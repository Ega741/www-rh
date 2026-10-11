// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {BeagleToken} from "../src/BeagleToken.sol";
import {CreditDesk} from "../src/CreditDesk.sol";
import {IPriceSource} from "../src/interfaces/IPriceSource.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockPriceSource} from "../src/mocks/MockPriceSource.sol";
import {PermitSigner} from "./utils/PermitSigner.sol";

/// @dev ERC-20 whose `transferFrom` re-enters the desk and records the revert reason it gets back.
contract ReentrantToken is ERC20 {
    CreditDesk public desk;
    bool public attack;
    bytes public lastRevert;

    constructor() ERC20("Evil", "EVIL") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setDesk(CreditDesk d) external {
        desk = d;
    }

    function setAttack(bool a) external {
        attack = a;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (attack) {
            attack = false;
            (bool ok, bytes memory data) = address(desk).call(abi.encodeCall(CreditDesk.burnForCredit, (from, value)));
            if (!ok) lastRevert = data;
        }
        return super.transferFrom(from, to, value);
    }

    function burn(uint256 value) external {
        _burn(msg.sender, value);
    }
}

contract CreditDeskTest is Test, PermitSigner {
    BeagleToken internal token;
    MockPriceSource internal ps;
    CreditDesk internal desk;

    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    address internal stranger = makeAddr("stranger");
    uint256 internal constant ALICE_PK = 0xA11CE;
    address internal alice;
    address internal bob = makeAddr("bob");
    address internal ws = makeAddr("workspace");

    uint256 internal constant PRICE = 1e16; // $0.01 per BEAGLE
    uint256 internal constant T0 = 1_700_000_000;

    function setUp() public {
        vm.warp(T0);
        alice = vm.addr(ALICE_PK);
        token = new BeagleToken(address(this));
        ps = new MockPriceSource(PRICE, block.timestamp);
        desk = new CreditDesk(IERC20(address(token)), true, ps, owner, operator);
        token.transfer(alice, 1_000_000e18);
        token.transfer(bob, 1_000_000e18);
        vm.prank(bob);
        token.approve(address(desk), type(uint256).max);
    }

    function _burn(address payer, address workspace, uint256 amount) internal returns (uint256) {
        vm.prank(payer);
        return desk.burnForCredit(workspace, amount);
    }

    function _open(address who, address workspace, uint128 cap, uint64 deadline) internal returns (uint256) {
        vm.prank(who);
        return desk.openBudget(workspace, cap, deadline);
    }

    function _draw(uint256 id, uint256 amount, bytes32 h) internal returns (uint256) {
        vm.prank(operator);
        return desk.draw(id, amount, h);
    }

    function _budget(uint256 id) internal view returns (CreditDesk.Budget memory b) {
        (b.owner, b.workspace, b.cap, b.drawn, b.deadline, b.closed) = desk.budgets(id);
    }

    // ─── Construction ─────────────────────────────────────────────────────────────────────────────────

    function test_constructor_state() public view {
        assertEq(address(desk.token()), address(token));
        assertEq(desk.tokenDecimals(), 18);
        assertTrue(desk.nativeBurn());
        assertEq(address(desk.priceSource()), address(ps));
        assertEq(desk.owner(), owner);
        assertEq(desk.operator(), operator);
        assertEq(desk.maxPriceAge(), 3600);
        assertEq(desk.minBurn(), 0);
        assertEq(desk.nextReceiptId(), 1);
        assertEq(desk.nextBudgetId(), 1);
        assertEq(desk.totalBurned(), 0);
        assertEq(desk.totalUsdMicro(), 0);
        assertEq(desk.DEAD(), 0x000000000000000000000000000000000000dEaD);
        assertEq(desk.MAX_BUDGET_DURATION(), 30 days);
        assertFalse(desk.paused());
    }

    function test_constructor_emits() public {
        vm.expectEmit();
        emit CreditDesk.PriceSourceSet(address(ps));
        vm.expectEmit();
        emit CreditDesk.OperatorSet(operator);
        vm.expectEmit();
        emit CreditDesk.MaxPriceAgeSet(3600);
        new CreditDesk(IERC20(address(token)), true, ps, owner, operator);
    }

    function test_constructor_zeroTokenReverts() public {
        vm.expectRevert(CreditDesk.ZeroAddress.selector);
        new CreditDesk(IERC20(address(0)), true, ps, owner, operator);
    }

    function test_constructor_zeroOwnerReverts() public {
        vm.expectRevert(CreditDesk.ZeroAddress.selector);
        new CreditDesk(IERC20(address(token)), true, ps, address(0), operator);
    }

    function test_constructor_badDecimalsReverts() public {
        MockERC20 weird = new MockERC20("W", "W", 37);
        vm.expectRevert(CreditDesk.BadDecimals.selector);
        new CreditDesk(IERC20(address(weird)), false, ps, owner, operator);
        MockERC20 ok36 = new MockERC20("W", "W", 36);
        CreditDesk d = new CreditDesk(IERC20(address(ok36)), false, ps, owner, operator);
        assertEq(d.tokenDecimals(), 36);
    }

    function test_constructor_optionalZeroes() public {
        CreditDesk d = new CreditDesk(IERC20(address(token)), true, IPriceSource(address(0)), owner, address(0));
        assertEq(address(d.priceSource()), address(0));
        assertEq(d.operator(), address(0));
        vm.expectRevert(CreditDesk.PriceUnavailable.selector);
        d.quote(1e18);
    }

    // ─── quote ────────────────────────────────────────────────────────────────────────────────────────

    function test_quote() public view {
        (uint256 usd, uint256 p, uint256 t) = desk.quote(1000e18);
        assertEq(usd, 10_000_000); // $10
        assertEq(p, PRICE);
        assertEq(t, T0);
    }

    function test_quote_zeroPriceUnavailable() public {
        ps.set(0, block.timestamp);
        vm.expectRevert(CreditDesk.PriceUnavailable.selector);
        desk.quote(1e18);
    }

    function test_quote_staleness() public {
        vm.warp(T0 + 3600);
        desk.quote(1e18); // exactly maxPriceAge old is still fresh
        vm.warp(T0 + 3601);
        vm.expectRevert(abi.encodeWithSelector(CreditDesk.PriceStale.selector, T0, uint32(3600)));
        desk.quote(1e18);
    }

    function test_quote_futureTimestampWithinMaxAgeIsFresh() public {
        ps.set(PRICE, block.timestamp + 3600); // a source clock slightly ahead of the chain is tolerated
        (uint256 usd,,) = desk.quote(1e18);
        assertEq(usd, 10_000);
    }

    function test_quote_farFutureTimestampIsStale() public {
        // Freshness is symmetric: |now − updatedAt| ≤ maxPriceAge. A far-future observation cannot bypass it.
        ps.set(PRICE, block.timestamp + 3601);
        vm.expectRevert(abi.encodeWithSelector(CreditDesk.PriceStale.selector, T0 + 3601, uint32(3600)));
        desk.quote(1e18);
        ps.set(PRICE, type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(CreditDesk.PriceStale.selector, type(uint256).max, uint32(3600)));
        desk.quote(1e18);
    }

    function test_quote_sixDecimalToken() public {
        MockERC20 usdcLike = new MockERC20("Six", "SIX", 6);
        CreditDesk d = new CreditDesk(IERC20(address(usdcLike)), false, ps, owner, operator);
        (uint256 usd,,) = d.quote(1e6); // one whole token at $0.01
        assertEq(usd, 10_000);
    }

    // ─── burnForCredit ────────────────────────────────────────────────────────────────────────────────

    function test_burnForCredit_happy() public {
        uint256 supply = token.totalSupply();
        vm.expectEmit();
        emit CreditDesk.CreditPurchased(1, ws, bob, 1000e18, 10_000_000, PRICE);
        uint256 id = _burn(bob, ws, 1000e18);
        assertEq(id, 1);
        assertEq(desk.nextReceiptId(), 2);
        assertEq(desk.totalBurned(), 1000e18);
        assertEq(desk.totalUsdMicro(), 10_000_000);
        assertEq(token.totalSupply(), supply - 1000e18);
        assertEq(token.balanceOf(bob), 1_000_000e18 - 1000e18);
        assertEq(token.balanceOf(address(desk)), 0);
    }

    function test_burnForCredit_zeroWorkspace() public {
        vm.expectRevert(CreditDesk.ZeroAddress.selector);
        _burn(bob, address(0), 1e18);
    }

    function test_burnForCredit_zeroAmount() public {
        vm.expectRevert(abi.encodeWithSelector(CreditDesk.BurnTooSmall.selector, 0, 0));
        _burn(bob, ws, 0);
    }

    function test_burnForCredit_belowMinBurn() public {
        vm.prank(owner);
        desk.setMinBurn(10e18);
        vm.expectRevert(abi.encodeWithSelector(CreditDesk.BurnTooSmall.selector, 10e18 - 1, 10e18));
        _burn(bob, ws, 10e18 - 1);
        _burn(bob, ws, 10e18);
    }

    function test_burnForCredit_quoteTooSmall() public {
        // 1e13 wei at $0.01 → 1e13 * 1e16 / 1e30 = 0.1 µUSD → 0
        vm.expectRevert(CreditDesk.QuoteTooSmall.selector);
        _burn(bob, ws, 1e13);
        _burn(bob, ws, 1e14); // 1 µUSD
        assertEq(desk.totalUsdMicro(), 1);
    }

    function test_burnForCredit_priceUnavailableAndStale() public {
        ps.set(0, block.timestamp);
        vm.expectRevert(CreditDesk.PriceUnavailable.selector);
        _burn(bob, ws, 1e18);
        ps.set(PRICE, block.timestamp);
        vm.warp(block.timestamp + 3601);
        vm.expectRevert(abi.encodeWithSelector(CreditDesk.PriceStale.selector, T0, uint32(3600)));
        _burn(bob, ws, 1e18);
    }

    function test_burnForCredit_noAllowance() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, address(desk), uint256(0), uint256(1e18)
            )
        );
        _burn(alice, ws, 1e18);
    }

    function test_burnForCredit_insufficientBalance() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, bob, uint256(1_000_000e18), uint256(1_000_000e18 + 1)
            )
        );
        _burn(bob, ws, 1_000_000e18 + 1);
    }

    function test_burnForCredit_usesCurrentPrice() public {
        ps.set(PRICE * 2, block.timestamp);
        vm.expectEmit();
        emit CreditDesk.CreditPurchased(1, ws, bob, 1e18, 20_000, PRICE * 2);
        _burn(bob, ws, 1e18);
    }

    function test_burnForCredit_reentrancyBlocked() public {
        ReentrantToken evil = new ReentrantToken();
        CreditDesk d = new CreditDesk(IERC20(address(evil)), true, ps, owner, operator);
        evil.setDesk(d);
        evil.mint(bob, 100e18);
        vm.prank(bob);
        evil.approve(address(d), type(uint256).max);
        evil.setAttack(true);
        vm.prank(bob);
        d.burnForCredit(ws, 10e18);
        assertEq(bytes4(evil.lastRevert()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(d.totalBurned(), 10e18);
        assertEq(d.nextReceiptId(), 2);
    }

    // ─── burnForCreditMin (credit floor) ──────────────────────────────────────────────────────────────

    function test_burnForCreditMin_floorRespected() public {
        // 1000 BEAGLE at $0.01 = $10.00: a floor one µUSD above the quote reverts, the exact quote passes.
        vm.expectRevert(abi.encodeWithSelector(CreditDesk.SlippageExceeded.selector, 10_000_000, 10_000_001));
        vm.prank(bob);
        desk.burnForCreditMin(ws, 1000e18, 10_000_001);
        assertEq(token.balanceOf(bob), 1_000_000e18); // nothing burned
        vm.expectEmit();
        emit CreditDesk.CreditPurchased(1, ws, bob, 1000e18, 10_000_000, PRICE);
        vm.prank(bob);
        uint256 id = desk.burnForCreditMin(ws, 1000e18, 10_000_000);
        assertEq(id, 1);
        assertEq(desk.totalUsdMicro(), 10_000_000);
        assertEq(desk.totalBurned(), 1000e18);
    }

    function test_burnForCreditMin_priceMovedBetweenQuoteAndInclusion() public {
        (uint256 quoted,,) = desk.quote(1000e18); // the UI quote at $0.01
        ps.set(PRICE * 3 / 4, block.timestamp); // a −25 % post (within the poster's bounds) lands first
        vm.expectRevert(abi.encodeWithSelector(CreditDesk.SlippageExceeded.selector, 7_500_000, quoted));
        vm.prank(bob);
        desk.burnForCreditMin(ws, 1000e18, quoted);
        vm.prank(bob);
        desk.burnForCreditMin(ws, 1000e18, 0); // 0 disables the floor: same as burnForCredit
        assertEq(desk.totalUsdMicro(), 7_500_000);
        assertEq(token.balanceOf(bob), 1_000_000e18 - 1000e18);
    }

    function test_burnForCreditMin_samePathChecks() public {
        vm.startPrank(bob);
        vm.expectRevert(CreditDesk.ZeroAddress.selector);
        desk.burnForCreditMin(address(0), 1e18, 0);
        vm.expectRevert(abi.encodeWithSelector(CreditDesk.BurnTooSmall.selector, 0, 0));
        desk.burnForCreditMin(ws, 0, 0);
        vm.expectRevert(CreditDesk.QuoteTooSmall.selector); // a zero quote is QuoteTooSmall, not slippage
        desk.burnForCreditMin(ws, 1e13, 1);
        vm.stopPrank();
        vm.prank(owner);
        desk.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(bob);
        desk.burnForCreditMin(ws, 1e18, 0);
    }

    function test_permitMin_floorRespected() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = signPermit(token, ALICE_PK, address(desk), 500e18, deadline);
        vm.expectRevert(abi.encodeWithSelector(CreditDesk.SlippageExceeded.selector, 5_000_000, 5_000_001));
        vm.prank(alice);
        desk.burnForCreditWithPermitMin(ws, 500e18, 5_000_001, deadline, v, r, s);
        assertEq(token.nonces(alice), 0); // the whole call reverted, permit included: the signature is reusable
        vm.expectEmit();
        emit CreditDesk.CreditPurchased(1, ws, alice, 500e18, 5_000_000, PRICE);
        vm.prank(alice);
        uint256 id = desk.burnForCreditWithPermitMin(ws, 500e18, 5_000_000, deadline, v, r, s);
        assertEq(id, 1);
        assertEq(token.nonces(alice), 1);
        assertEq(token.allowance(alice, address(desk)), 0);
        vm.prank(owner);
        desk.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(alice);
        desk.burnForCreditWithPermitMin(ws, 1e18, 0, deadline, v, r, s);
    }

    // ─── burnForCreditWithPermit ──────────────────────────────────────────────────────────────────────

    function test_permit_validNoPriorAllowance() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = signPermit(token, ALICE_PK, address(desk), 500e18, deadline);
        assertEq(token.allowance(alice, address(desk)), 0);
        vm.expectEmit();
        emit CreditDesk.CreditPurchased(1, ws, alice, 500e18, 5_000_000, PRICE);
        vm.prank(alice);
        uint256 id = desk.burnForCreditWithPermit(ws, 500e18, deadline, v, r, s);
        assertEq(id, 1);
        assertEq(token.allowance(alice, address(desk)), 0);
        assertEq(token.nonces(alice), 1);
    }

    function test_permit_replayedWithExistingAllowanceSucceeds() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = signPermit(token, ALICE_PK, address(desk), 500e18, deadline);
        // Front-runner consumes the permit first.
        token.permit(alice, address(desk), 500e18, deadline, v, r, s);
        vm.prank(alice);
        uint256 id = desk.burnForCreditWithPermit(ws, 500e18, deadline, v, r, s);
        assertEq(id, 1);
        assertEq(desk.totalBurned(), 500e18);
    }

    function test_permit_invalidSigWithExistingAllowanceSucceeds() public {
        vm.prank(alice);
        token.approve(address(desk), 1e18);
        vm.prank(alice);
        uint256 id = desk.burnForCreditWithPermit(ws, 1e18, 0, 27, bytes32(uint256(1)), bytes32(uint256(2)));
        assertEq(id, 1);
        assertEq(token.allowance(alice, address(desk)), 0);
    }

    function test_permit_invalidSigWithoutAllowanceReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, address(desk), uint256(0), uint256(1e18)
            )
        );
        vm.prank(alice);
        desk.burnForCreditWithPermit(ws, 1e18, 0, 27, bytes32(uint256(1)), bytes32(uint256(2)));
    }

    function test_permit_tokenWithoutPermitStillWorks() public {
        MockERC20 plain = new MockERC20("Plain", "PLN", 18);
        CreditDesk d = new CreditDesk(IERC20(address(plain)), false, ps, owner, operator);
        plain.mint(bob, 10e18);
        vm.startPrank(bob);
        plain.approve(address(d), 10e18);
        uint256 id = d.burnForCreditWithPermit(ws, 10e18, 0, 0, 0, 0);
        vm.stopPrank();
        assertEq(id, 1);
        assertEq(plain.balanceOf(d.DEAD()), 10e18);
    }

    function test_permit_samePathChecks() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = signPermit(token, ALICE_PK, address(desk), 1e18, deadline);
        vm.expectRevert(CreditDesk.ZeroAddress.selector);
        vm.prank(alice);
        desk.burnForCreditWithPermit(address(0), 1e18, deadline, v, r, s);
    }

    // ─── openBudget ───────────────────────────────────────────────────────────────────────────────────

    function test_openBudget_happy() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        vm.expectEmit();
        emit CreditDesk.BudgetOpened(1, bob, ws, 500e18, deadline);
        uint256 id = _open(bob, ws, 500e18, deadline);
        assertEq(id, 1);
        assertEq(desk.nextBudgetId(), 2);
        CreditDesk.Budget memory b = _budget(1);
        assertEq(b.owner, bob);
        assertEq(b.workspace, ws);
        assertEq(b.cap, 500e18);
        assertEq(b.drawn, 0);
        assertEq(b.deadline, deadline);
        assertFalse(b.closed);
        assertEq(_open(alice, alice, 1, deadline), 2);
    }

    function test_openBudget_badParams() public {
        uint64 now_ = uint64(block.timestamp);
        vm.expectRevert(CreditDesk.ZeroAddress.selector);
        _open(bob, address(0), 1, now_ + 1);
        vm.expectRevert(CreditDesk.BadBudgetParams.selector);
        _open(bob, ws, 0, now_ + 1);
        vm.expectRevert(CreditDesk.BadBudgetParams.selector);
        _open(bob, ws, 1, now_);
        vm.expectRevert(CreditDesk.BadBudgetParams.selector);
        _open(bob, ws, 1, now_ + 30 days + 1);
        _open(bob, ws, 1, now_ + 1);
        _open(bob, ws, 1, now_ + 30 days);
    }

    // ─── draw ─────────────────────────────────────────────────────────────────────────────────────────

    function test_draw_happy() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        uint256 id = _open(bob, ws, 500e18, deadline);
        bytes32 h = keccak256("receipt");
        uint256 supply = token.totalSupply();
        vm.expectEmit();
        emit CreditDesk.BudgetDrawn(id, 1, ws, 100e18, 1_000_000, PRICE, h);
        uint256 rid = _draw(id, 100e18, h);
        assertEq(rid, 1);
        assertEq(_budget(id).drawn, 100e18);
        assertEq(desk.totalBurned(), 100e18);
        assertEq(desk.totalUsdMicro(), 1_000_000);
        assertEq(token.totalSupply(), supply - 100e18);
        assertEq(token.balanceOf(bob), 1_000_000e18 - 100e18);
        assertEq(token.balanceOf(address(desk)), 0);
        // Fill up to the cap exactly.
        _draw(id, 400e18, h);
        assertEq(_budget(id).drawn, 500e18);
        assertEq(desk.budgetRemaining(id), 0);
        vm.expectRevert(abi.encodeWithSelector(CreditDesk.BudgetExceeded.selector, 0));
        _draw(id, 1, h);
    }

    function test_draw_notOperator() public {
        uint256 id = _open(bob, ws, 500e18, uint64(block.timestamp + 1 hours));
        vm.expectRevert(CreditDesk.NotOperator.selector);
        vm.prank(bob);
        desk.draw(id, 1e18, 0);
        vm.expectRevert(CreditDesk.NotOperator.selector);
        vm.prank(owner);
        desk.draw(id, 1e18, 0);
    }

    function test_draw_unknownBudget() public {
        vm.expectRevert(CreditDesk.UnknownBudget.selector);
        _draw(1, 1e18, 0);
        vm.expectRevert(CreditDesk.UnknownBudget.selector);
        _draw(0, 1e18, 0);
    }

    function test_draw_closed() public {
        uint256 id = _open(bob, ws, 500e18, uint64(block.timestamp + 1 hours));
        vm.prank(bob);
        desk.closeBudget(id);
        vm.expectRevert(CreditDesk.BudgetIsClosed.selector);
        _draw(id, 1e18, 0);
    }

    function test_draw_expired() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        uint256 id = _open(bob, ws, 500e18, deadline);
        vm.warp(deadline);
        ps.set(PRICE, block.timestamp);
        _draw(id, 1e18, 0); // at the deadline is still allowed
        vm.warp(deadline + 1);
        vm.expectRevert(CreditDesk.BudgetExpired.selector);
        _draw(id, 1e18, 0);
    }

    function test_draw_zeroAmount() public {
        uint256 id = _open(bob, ws, 500e18, uint64(block.timestamp + 1 hours));
        vm.expectRevert(abi.encodeWithSelector(CreditDesk.BurnTooSmall.selector, 0, 0));
        _draw(id, 0, 0);
    }

    function test_draw_exceeded() public {
        uint256 id = _open(bob, ws, 500e18, uint64(block.timestamp + 1 hours));
        _draw(id, 200e18, 0);
        vm.expectRevert(abi.encodeWithSelector(CreditDesk.BudgetExceeded.selector, 300e18));
        _draw(id, 300e18 + 1, 0);
    }

    function test_draw_quoteTooSmall() public {
        uint256 id = _open(bob, ws, 500e18, uint64(block.timestamp + 1 hours));
        vm.expectRevert(CreditDesk.QuoteTooSmall.selector);
        _draw(id, 1e13, 0);
    }

    function test_draw_priceStale() public {
        uint256 id = _open(bob, ws, 500e18, uint64(block.timestamp + 2 hours));
        vm.warp(block.timestamp + 3601);
        vm.expectRevert(abi.encodeWithSelector(CreditDesk.PriceStale.selector, T0, uint32(3600)));
        _draw(id, 1e18, 0);
    }

    function test_draw_ownerAllowanceAndBalanceEnforced() public {
        uint256 id = _open(alice, ws, 500e18, uint64(block.timestamp + 1 hours));
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, address(desk), uint256(0), uint256(1e18)
            )
        );
        _draw(id, 1e18, 0);
        vm.prank(alice);
        token.approve(address(desk), 1e18);
        _draw(id, 1e18, 0);
        assertEq(token.balanceOf(alice), 1_000_000e18 - 1e18);
    }

    function test_draw_minBurnDoesNotApply() public {
        vm.prank(owner);
        desk.setMinBurn(1000e18);
        uint256 id = _open(bob, ws, 500e18, uint64(block.timestamp + 1 hours));
        _draw(id, 1e18, 0);
    }

    function test_receiptIdsSharedAcrossPaths() public {
        uint256 id = _open(bob, ws, 500e18, uint64(block.timestamp + 1 hours));
        assertEq(_burn(bob, ws, 1e18), 1);
        assertEq(_draw(id, 1e18, 0), 2);
        assertEq(_burn(bob, ws, 1e18), 3);
        assertEq(_draw(id, 1e18, 0), 4);
        assertEq(desk.nextReceiptId(), 5);
        assertEq(desk.totalBurned(), 4e18);
        assertEq(desk.totalUsdMicro(), 40_000);
    }

    // ─── closeBudget ──────────────────────────────────────────────────────────────────────────────────

    function test_closeBudget_byOwner() public {
        uint256 id = _open(bob, ws, 500e18, uint64(block.timestamp + 1 hours));
        _draw(id, 10e18, 0);
        vm.expectEmit();
        emit CreditDesk.BudgetClosed(id, 10e18);
        vm.prank(bob);
        desk.closeBudget(id);
        assertTrue(_budget(id).closed);
        assertEq(desk.budgetRemaining(id), 0);
    }

    function test_closeBudget_byOperator() public {
        uint256 id = _open(bob, ws, 500e18, uint64(block.timestamp + 1 hours));
        vm.prank(operator);
        desk.closeBudget(id);
        assertTrue(_budget(id).closed);
    }

    function test_closeBudget_strangerOnlyAfterDeadline() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        uint256 id = _open(bob, ws, 500e18, deadline);
        vm.expectRevert(CreditDesk.NotBudgetOwner.selector);
        vm.prank(stranger);
        desk.closeBudget(id);
        vm.warp(deadline);
        vm.expectRevert(CreditDesk.NotBudgetOwner.selector);
        vm.prank(stranger);
        desk.closeBudget(id);
        vm.warp(deadline + 1);
        vm.prank(stranger);
        desk.closeBudget(id);
        assertTrue(_budget(id).closed);
    }

    function test_closeBudget_alreadyClosed() public {
        uint256 id = _open(bob, ws, 500e18, uint64(block.timestamp + 1 hours));
        vm.prank(bob);
        desk.closeBudget(id);
        vm.expectRevert(CreditDesk.BudgetIsClosed.selector);
        vm.prank(bob);
        desk.closeBudget(id);
    }

    function test_closeBudget_unknown() public {
        vm.expectRevert(CreditDesk.UnknownBudget.selector);
        desk.closeBudget(99);
    }

    // ─── budgetRemaining ──────────────────────────────────────────────────────────────────────────────

    function test_budgetRemaining() public {
        assertEq(desk.budgetRemaining(1), 0); // unknown
        uint64 deadline = uint64(block.timestamp + 1 hours);
        uint256 id = _open(alice, ws, 500e18, deadline);
        assertEq(desk.budgetRemaining(id), 0); // no allowance yet
        vm.prank(alice);
        token.approve(address(desk), 200e18);
        assertEq(desk.budgetRemaining(id), 200e18); // allowance binds
        vm.prank(alice);
        token.approve(address(desk), type(uint256).max);
        assertEq(desk.budgetRemaining(id), 500e18); // cap binds
        _draw(id, 100e18, 0);
        assertEq(desk.budgetRemaining(id), 400e18);
        uint256 excess = token.balanceOf(alice) - 50e18;
        vm.prank(alice);
        token.transfer(bob, excess);
        assertEq(desk.budgetRemaining(id), 50e18); // balance binds
        vm.warp(deadline + 1);
        assertEq(desk.budgetRemaining(id), 0); // expired
    }

    // ─── Admin ────────────────────────────────────────────────────────────────────────────────────────

    function test_admin_onlyOwner() public {
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger);
        vm.startPrank(stranger);
        vm.expectRevert(err);
        desk.setPriceSource(ps);
        vm.expectRevert(err);
        desk.setMaxPriceAge(1);
        vm.expectRevert(err);
        desk.setMinBurn(1);
        vm.expectRevert(err);
        desk.setOperator(stranger);
        vm.expectRevert(err);
        desk.pause();
        vm.expectRevert(err);
        desk.unpause();
        vm.expectRevert(err);
        desk.recoverToken(IERC20(address(token)), stranger, 1);
        vm.stopPrank();
    }

    function test_admin_setters() public {
        MockPriceSource ps2 = new MockPriceSource(PRICE * 3, block.timestamp);
        vm.startPrank(owner);
        vm.expectEmit();
        emit CreditDesk.PriceSourceSet(address(ps2));
        desk.setPriceSource(ps2);
        assertEq(address(desk.priceSource()), address(ps2));
        (, uint256 p,) = desk.quote(1);
        assertEq(p, PRICE * 3);

        vm.expectEmit();
        emit CreditDesk.MaxPriceAgeSet(60);
        desk.setMaxPriceAge(60);
        assertEq(desk.maxPriceAge(), 60);
        vm.expectRevert(CreditDesk.BadMaxPriceAge.selector);
        desk.setMaxPriceAge(0);

        vm.expectEmit();
        emit CreditDesk.MinBurnSet(5);
        desk.setMinBurn(5);
        assertEq(desk.minBurn(), 5);

        vm.expectEmit();
        emit CreditDesk.OperatorSet(stranger);
        desk.setOperator(stranger);
        assertEq(desk.operator(), stranger);

        desk.setPriceSource(IPriceSource(address(0)));
        vm.stopPrank();
        vm.expectRevert(CreditDesk.PriceUnavailable.selector);
        desk.quote(1);
    }

    function test_admin_recoverToken() public {
        MockERC20 stray = new MockERC20("Stray", "STR", 18);
        stray.mint(address(desk), 5e18);
        token.transfer(address(desk), 7e18);
        vm.startPrank(owner);
        vm.expectRevert(CreditDesk.ZeroAddress.selector);
        desk.recoverToken(IERC20(address(stray)), address(0), 5e18);
        desk.recoverToken(IERC20(address(stray)), stranger, 5e18);
        desk.recoverToken(IERC20(address(token)), stranger, 7e18);
        vm.stopPrank();
        assertEq(stray.balanceOf(stranger), 5e18);
        assertEq(token.balanceOf(stranger), 7e18);
        assertEq(token.balanceOf(address(desk)), 0);
    }

    function test_admin_ownershipTwoStep() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        desk.transferOwnership(newOwner);
        assertEq(desk.owner(), owner);
        assertEq(desk.pendingOwner(), newOwner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, newOwner));
        vm.prank(newOwner);
        desk.setMinBurn(1);
        vm.prank(newOwner);
        desk.acceptOwnership();
        assertEq(desk.owner(), newOwner);
        vm.prank(newOwner);
        desk.setMinBurn(1);
    }

    function test_admin_renounceOwnershipDisabled() public {
        vm.expectRevert(CreditDesk.RenounceDisabled.selector);
        vm.prank(owner);
        desk.renounceOwnership();
        vm.expectRevert(CreditDesk.RenounceDisabled.selector);
        vm.prank(stranger);
        desk.renounceOwnership();
        assertEq(desk.owner(), owner);
        vm.prank(owner);
        desk.pause(); // still governable
    }

    // ─── Pause ────────────────────────────────────────────────────────────────────────────────────────

    function test_pause_semantics() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        uint256 id = _open(bob, ws, 500e18, deadline);
        uint256 id2 = _open(bob, ws, 500e18, deadline);
        vm.prank(owner);
        desk.pause();
        assertTrue(desk.paused());

        vm.expectRevert(Pausable.EnforcedPause.selector);
        _burn(bob, ws, 1e18);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(bob);
        desk.burnForCreditWithPermit(ws, 1e18, 0, 0, 0, 0);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        _open(bob, ws, 1, deadline);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        _draw(id, 1e18, 0);
        // Views and closing still work.
        desk.quote(1e18);
        vm.prank(bob);
        desk.closeBudget(id);
        assertTrue(_budget(id).closed);

        vm.prank(owner);
        desk.unpause();
        assertFalse(desk.paused());
        _burn(bob, ws, 1e18);
        _draw(id2, 1e18, 0);
        _open(bob, ws, 1, deadline);
    }

    function test_pause_doubleToggleReverts() public {
        vm.startPrank(owner);
        vm.expectRevert(Pausable.ExpectedPause.selector);
        desk.unpause();
        desk.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        desk.pause();
        vm.stopPrank();
    }

    // ─── Dead-address mode ────────────────────────────────────────────────────────────────────────────

    function test_deadMode_burnAndDraw() public {
        MockERC20 plain = new MockERC20("Plain", "PLN", 18);
        CreditDesk d = new CreditDesk(IERC20(address(plain)), false, ps, owner, operator);
        assertFalse(d.nativeBurn());
        plain.mint(bob, 1000e18);
        vm.startPrank(bob);
        plain.approve(address(d), type(uint256).max);
        d.burnForCredit(ws, 100e18);
        uint256 id = d.openBudget(ws, 500e18, uint64(block.timestamp + 1 hours));
        vm.stopPrank();
        vm.prank(operator);
        d.draw(id, 50e18, keccak256("r"));
        assertEq(plain.totalSupply(), 1000e18); // nothing destroyed …
        assertEq(plain.balanceOf(d.DEAD()), 150e18); // … everything parked at DEAD
        assertEq(plain.balanceOf(address(d)), 0);
        assertEq(d.totalBurned(), 150e18);
        assertEq(d.totalUsdMicro(), 1_500_000);
    }

    function test_nativeModeWithNonBurnableTokenReverts() public {
        MockERC20 plain = new MockERC20("Plain", "PLN", 18);
        CreditDesk d = new CreditDesk(IERC20(address(plain)), true, ps, owner, operator);
        plain.mint(bob, 1000e18);
        vm.startPrank(bob);
        plain.approve(address(d), type(uint256).max);
        vm.expectRevert(); // `burn(uint256)` does not exist on the token
        d.burnForCredit(ws, 100e18);
        vm.stopPrank();
    }

    // ─── Fuzz ─────────────────────────────────────────────────────────────────────────────────────────

    function testFuzz_burnForCredit_eventMatchesQuote(uint256 amount, uint256 price) public {
        amount = bound(amount, 1, 1_000_000e18);
        price = bound(price, 1e9, 1e24);
        ps.set(price, block.timestamp);
        uint256 expectedUsd = amount * price / 1e30;
        if (expectedUsd == 0) {
            vm.expectRevert(CreditDesk.QuoteTooSmall.selector);
            _burn(bob, ws, amount);
            return;
        }
        vm.expectEmit();
        emit CreditDesk.CreditPurchased(1, ws, bob, amount, expectedUsd, price);
        _burn(bob, ws, amount);
        assertEq(desk.totalUsdMicro(), expectedUsd);
        assertEq(desk.totalBurned(), amount);
    }

    function testFuzz_draw_neverExceedsCap(uint128 cap, uint256 a1, uint256 a2) public {
        cap = uint128(bound(cap, 1e14, 1_000_000e18));
        a1 = bound(a1, 1e14, cap);
        a2 = bound(a2, 1e14, cap);
        uint256 id = _open(bob, ws, cap, uint64(block.timestamp + 1 days));
        _draw(id, a1, 0);
        if (a1 + a2 > cap) {
            vm.expectRevert(abi.encodeWithSelector(CreditDesk.BudgetExceeded.selector, cap - a1));
            _draw(id, a2, 0);
        } else {
            _draw(id, a2, 0);
        }
        assertLe(_budget(id).drawn, cap);
    }
}
