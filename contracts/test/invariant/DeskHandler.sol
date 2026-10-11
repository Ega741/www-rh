// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CreditDesk} from "../../src/CreditDesk.sol";
import {MockPriceSource} from "../../src/mocks/MockPriceSource.sol";
import {PermitSigner} from "../utils/PermitSigner.sol";

/// @title DeskHandler
/// @notice Invariant-test handler for `CreditDesk`. Every action predicts whether the desk call must succeed,
///         asserts the prediction, and keeps ghost accounting from the *emitted events* (not from return values),
///         so the invariants compare contract state against what an indexer would see.
/// @dev Designed to never revert itself (`invariant.fail_on_revert = true`). The success oracle for pricing is
///      computed here from the price source, `maxPriceAge` and `block.timestamp` (SPEC §1 / §3.4) and never
///      from `desk.quote()`, so a regression in the desk's staleness, zero-price or rounding logic breaks a
///      prediction instead of being mirrored by the oracle.
contract DeskHandler is Test, PermitSigner {
    CreditDesk public immutable desk;
    IERC20 public immutable token;
    MockPriceSource public immutable ps;
    address public immutable owner;
    address public immutable operator;
    bool public immutable native;

    /// @dev Single-burn ceiling (1000 tokens): keeps actor balances from decaying geometrically over a run.
    uint256 internal constant MAX_BURN = 1e21;

    uint256[] internal _actorKeys;
    address[] internal _actors;
    address[] internal _workspaces;
    address internal immutable _stranger;

    // Ghost state (from events).
    uint256 public ghostBurned;
    uint256 public ghostUsd;
    uint256 public ghostReceipts;
    uint256 public lastReceiptId;
    uint256[] internal _budgetIds;
    mapping(uint256 budgetId => bool) public frozen; // seen closed or expired
    mapping(uint256 budgetId => uint128) public frozenDrawn; // `drawn` at the moment it froze

    // Call statistics (for `afterInvariant` logging).
    uint256 public nBurnOk;
    uint256 public nBurnRevert;
    uint256 public nPermitOk;
    uint256 public nPermitRevert;
    uint256 public nOpenOk;
    uint256 public nDrawOk;
    uint256 public nDrawRevert;
    uint256 public nCloseOk;
    uint256 public nAttemptsPaused; // burn/permit/draw attempts made while paused
    uint256 public nAttemptsStale; // … while the price was stale (judged here, not by the desk)
    uint256 public nAttemptsUnavailable; // … while the price was 0
    uint256 public nFloorRejects; // burns that must fail only because of the `minUsdMicro` floor
    uint256 public nDrawExpiredFresh; // draws blocked only by the budget's expiry (fresh price, live amount)

    constructor(CreditDesk desk_, MockPriceSource ps_, address owner_, address operator_, bool native_) {
        desk = desk_;
        token = desk_.token();
        ps = ps_;
        owner = owner_;
        operator = operator_;
        native = native_;
        for (uint256 i = 1; i <= 4; i++) {
            _actorKeys.push(0xBEA61E00 + i);
            _actors.push(vm.addr(0xBEA61E00 + i));
        }
        _workspaces.push(makeAddr("workspace-1"));
        _workspaces.push(makeAddr("workspace-2"));
        _stranger = makeAddr("stranger");
    }

    // ─── Views for the test contract ──────────────────────────────────────────────────────────────────

    function actors() external view returns (address[] memory) {
        return _actors;
    }

    function budgetIds() external view returns (uint256[] memory) {
        return _budgetIds;
    }

    // ─── Actions ──────────────────────────────────────────────────────────────────────────────────────

    /// @dev Half of the calls use `burnForCreditMin`: floor exactly at the predicted quote (must pass) or one
    ///      µUSD above it (must fail with `SlippageExceeded`).
    function burn(uint256 actorSeed, uint256 wsSeed, uint256 amount) external {
        address actor = _actor(actorSeed);
        amount = _amount(amount, Math.min(token.balanceOf(actor), MAX_BURN));
        _ensureAllowance(actor, amount);
        (bool expectOk, uint256 expectUsd) = _predictPurchase(actor, amount);
        (bytes memory data, bool floorRejects) =
            _purchaseCall(actorSeed, _workspace(wsSeed), amount, expectUsd, expectOk);
        if (floorRejects) expectOk = false;
        vm.recordLogs();
        vm.prank(actor);
        (bool ok, bytes memory ret) = address(desk).call(data);
        if (ok) {
            assertTrue(expectOk, "burn succeeded unexpectedly");
            _onReceipt(abi.decode(ret, (uint256)), CreditDesk.CreditPurchased.selector, amount, expectUsd);
            nBurnOk++;
        } else {
            assertFalse(expectOk, "burn reverted unexpectedly");
            if (floorRejects) assertEq(bytes4(ret), CreditDesk.SlippageExceeded.selector, "floor: wrong error");
            bytes4 priceErr = _priceError(amount);
            if (priceErr != 0) assertEq(bytes4(ret), priceErr, "price: wrong error");
            nBurnRevert++;
        }
        _snapshotBudgets();
    }

    function burnWithPermit(uint256 actorSeed, uint256 wsSeed, uint256 amount, bool validSig) external {
        uint256 idx = bound(actorSeed, 0, _actors.length - 1);
        address actor = _actors[idx];
        amount = _amount(amount, Math.min(token.balanceOf(actor), MAX_BURN));
        uint256 deadline = block.timestamp + 1 hours;
        uint8 v;
        bytes32 r;
        bytes32 s;
        if (validSig && native) {
            (v, r, s) = signPermit(IERC20Permit(address(token)), _actorKeys[idx], address(desk), amount, deadline);
        } else {
            (v, r, s) = (27, bytes32(amount + 1), bytes32(uint256(1)));
            _ensureAllowance(actor, amount);
        }
        (bool expectOk, uint256 expectUsd) = _predictPurchase(actor, amount);
        vm.recordLogs();
        vm.prank(actor);
        try desk.burnForCreditWithPermit(_workspace(wsSeed), amount, deadline, v, r, s) returns (uint256 rid) {
            assertTrue(expectOk, "permit burn succeeded unexpectedly");
            _onReceipt(rid, CreditDesk.CreditPurchased.selector, amount, expectUsd);
            nPermitOk++;
        } catch {
            assertFalse(expectOk, "permit burn reverted unexpectedly");
            nPermitRevert++;
        }
        _snapshotBudgets();
    }

    function openBudget(uint256 actorSeed, uint256 wsSeed, uint128 cap, uint64 duration) external {
        address actor = _actor(actorSeed);
        cap = uint128(bound(_rand(cap), 1e15, 1e23)); // $0.01 … $1M at the default price
        duration = uint64(bound(_rand(duration), 1 minutes, 3 days)); // short budgets expire within a run
        uint64 deadline = uint64(block.timestamp) + duration;
        bool expectOk = !desk.paused();
        vm.prank(actor);
        try desk.openBudget(_workspace(wsSeed), cap, deadline) returns (uint256 id) {
            assertTrue(expectOk, "open succeeded while paused");
            _budgetIds.push(id);
            assertEq(id, _budgetIds.length, "budget id not sequential");
            nOpenOk++;
        } catch {
            assertFalse(expectOk, "open reverted unexpectedly");
        }
        _snapshotBudgets();
    }

    function draw(uint256 budgetSeed, uint256 amount, bytes32 receiptHash) external {
        if (_budgetIds.length == 0) return;
        uint256 id = _pickBudget(budgetSeed);
        CreditDesk.Budget memory b = _budget(id);
        uint256 headroom = b.cap - b.drawn;
        amount = _amount(amount, headroom); // edges: exactly the headroom, or one above it
        _ensureAllowance(b.owner, amount);
        bool expired = !b.closed && block.timestamp > b.deadline;
        bool wasFrozen = b.closed || expired;
        _countBlockers();
        (bool quoteOk, uint256 expectUsd) = _predictQuote(amount);
        bool otherwiseOk = !desk.paused() && amount > 0 && amount <= headroom && amount <= token.balanceOf(b.owner)
            && quoteOk && expectUsd > 0;
        if (expired && otherwiseOk) nDrawExpiredFresh++; // only `BudgetExpired` stands between this draw and success
        bool expectOk = otherwiseOk && !wasFrozen;
        vm.recordLogs();
        vm.prank(operator);
        try desk.draw(id, amount, receiptHash) returns (uint256 rid) {
            assertTrue(expectOk, "draw succeeded unexpectedly");
            assertFalse(wasFrozen, "draw on closed/expired budget");
            _onReceipt(rid, CreditDesk.BudgetDrawn.selector, amount, expectUsd);
            assertEq(_budget(id).drawn, b.drawn + amount, "drawn not increased by amount");
            nDrawOk++;
        } catch {
            assertFalse(expectOk, "draw reverted unexpectedly");
            assertEq(_budget(id).drawn, b.drawn, "drawn changed on revert");
            nDrawRevert++;
        }
        _snapshotBudgets();
    }

    function closeBudget(uint256 budgetSeed, uint256 callerSeed) external {
        if (_budgetIds.length == 0) return;
        uint256 id = _pickBudget(budgetSeed);
        CreditDesk.Budget memory b = _budget(id);
        address caller = _closer(callerSeed);
        bool expectOk = !b.closed && (caller == b.owner || caller == operator || block.timestamp > b.deadline);
        vm.prank(caller);
        try desk.closeBudget(id) {
            assertTrue(expectOk, "close succeeded unexpectedly");
            assertTrue(_budget(id).closed, "not closed");
            nCloseOk++;
        } catch {
            assertFalse(expectOk, "close reverted unexpectedly");
        }
        _snapshotBudgets();
    }

    function warp(uint256 secs, bool refreshPrice) external {
        vm.warp(block.timestamp + bound(_rand(secs), 1, 90 minutes)); // may cross maxPriceAge (1 h)
        if (refreshPrice) _refreshPrice();
        _snapshotBudgets();
    }

    /// @dev Expires one (preferably live) budget — warp to `deadline + 1` — and refreshes the price, so that
    ///      draws on an expired budget with a fresh price and a live amount really happen (invariant 3).
    function warpPastDeadline(uint256 budgetSeed) external {
        if (_budgetIds.length == 0) return;
        CreditDesk.Budget memory b = _budget(_pickBudget(budgetSeed));
        if (block.timestamp <= b.deadline) vm.warp(uint256(b.deadline) + 1);
        _refreshPrice();
        _snapshotBudgets();
    }

    /// @dev Price in [1e9, 1e24] on a log-ish scale (1e9 · 10^k · m) so small and large prices both occur.
    function setPrice(uint256 seed) external {
        uint256 r = _rand(seed);
        uint256 exp = bound(r, 0, 15);
        uint256 mantissa = bound(r >> 8, 1, 9);
        ps.set(1e9 * 10 ** exp * mantissa, block.timestamp);
    }

    /// @dev One in three calls breaks the price (unavailable or stale); the others refresh it.
    function breakPrice(uint8 seed, bool unavailable) external {
        if (_rand(seed) % 3 != 0) return _refreshPrice();
        (uint256 p,) = ps.latestPrice();
        if (unavailable) ps.set(0, block.timestamp);
        else ps.set(p == 0 ? 1e16 : p, block.timestamp - 2 days); // stale
    }

    /// @dev Pauses on one call in five, unpauses otherwise (keeps the desk live most of the time).
    function setPaused(uint8 seed) external {
        bool wantPaused = _rand(seed) % 5 == 0;
        bool paused = desk.paused(); // read before prank: a view call would consume it
        if (wantPaused == paused) return;
        vm.prank(owner);
        if (wantPaused) desk.pause();
        else desk.unpause();
    }

    function setMinBurn(uint256 minBurn) external {
        vm.prank(owner);
        desk.setMinBurn(bound(_rand(minBurn), 0, 100e18));
    }

    // ─── Internals ────────────────────────────────────────────────────────────────────────────────────

    function _actor(uint256 seed) internal view returns (address) {
        return _actors[bound(seed, 0, _actors.length - 1)];
    }

    function _workspace(uint256 seed) internal view returns (address) {
        return _workspaces[bound(seed, 0, _workspaces.length - 1)];
    }

    function _closer(uint256 seed) internal view returns (address) {
        uint256 i = bound(_rand(seed), 0, _actors.length + 1);
        if (i < _actors.length) return _actors[i];
        return i == _actors.length ? operator : _stranger;
    }

    /// @dev Hash the fuzzer's seed so the sample is uniform: the fuzzer favours tiny and dictionary values,
    ///      which `bound` would pile up at the low edge (dust amounts, 30-minute budgets, …).
    function _rand(uint256 seed) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed)));
    }

    /// @dev Amount in [1e14, max] (≥ 1 µUSD at $0.01) most of the time, with deliberate edges: 0, dust,
    ///      exactly `max` and `max + 1` (over the cap / over the balance).
    function _amount(uint256 seed, uint256 max) internal pure returns (uint256) {
        uint256 r = _rand(seed);
        uint256 sel = r % 16;
        if (sel == 0) return 0;
        if (sel == 1) return max;
        if (sel == 2) return max + 1;
        if (sel == 3) return bound(r >> 8, 1, 1e14);
        return max >= 1e14 ? bound(r >> 8, 1e14, max) : bound(r >> 8, 0, max);
    }

    /// @dev Random budget; three times out of four prefer one that is still live (not closed/expired).
    function _pickBudget(uint256 seed) internal view returns (uint256) {
        uint256 r = _rand(seed);
        uint256 n = _budgetIds.length;
        uint256 start = r % n;
        if ((r >> 16) % 4 == 0) return _budgetIds[start];
        for (uint256 k = 0; k < n; k++) {
            uint256 id = _budgetIds[(start + k) % n];
            CreditDesk.Budget memory b = _budget(id);
            if (!b.closed && block.timestamp <= b.deadline) return id;
        }
        return _budgetIds[start];
    }

    function _budget(uint256 id) internal view returns (CreditDesk.Budget memory b) {
        (b.owner, b.workspace, b.cap, b.drawn, b.deadline, b.closed) = desk.budgets(id);
    }

    function _ensureAllowance(address who, uint256 amount) internal {
        if (token.allowance(who, address(desk)) < amount) {
            vm.prank(who);
            token.approve(address(desk), type(uint256).max);
        }
    }

    /// @dev SPEC §3.4 freshness, judged independently of the desk: `|now − updatedAt| <= maxPriceAge`.
    function _fresh(uint256 updatedAt) internal view returns (bool) {
        uint256 now_ = block.timestamp;
        uint256 age = now_ >= updatedAt ? now_ - updatedAt : updatedAt - now_;
        return age <= desk.maxPriceAge();
    }

    /// @dev Independent quote (SPEC §1, 18-decimal token): `amount * price / 1e30` in plain arithmetic.
    ///      `amount <= ~1e23` and `price <= 9e24` here, so the product cannot overflow.
    function _predictQuote(uint256 amount) internal view returns (bool ok, uint256 usd) {
        (uint256 price, uint256 updatedAt) = ps.latestPrice();
        if (price == 0 || !_fresh(updatedAt)) return (false, 0);
        return (true, amount * price / 1e30);
    }

    function _predictPurchase(address actor, uint256 amount) internal returns (bool ok, uint256 usd) {
        _countBlockers();
        (bool quoteOk, uint256 q) = _predictQuote(amount);
        ok = !desk.paused() && amount > 0 && amount >= desk.minBurn() && amount <= token.balanceOf(actor) && quoteOk
            && q > 0;
        usd = q;
    }

    /// @dev Calldata for the purchase: plain `burnForCredit` or `burnForCreditMin` with the floor at the predicted
    ///      quote (passes) or one above it (`floorRejects`, must fail). The floor only matters on an otherwise
    ///      successful burn; a doomed burn stays on the plain path so its blocker is what gets exercised.
    function _purchaseCall(uint256 seed, address workspace, uint256 amount, uint256 expectUsd, bool otherwiseOk)
        internal
        returns (bytes memory data, bool floorRejects)
    {
        uint256 mode = (_rand(seed) >> 128) % 4; // 0,1: no floor; 2: floor == quote; 3: floor == quote + 1
        if (mode < 2 || !otherwiseOk) return (abi.encodeCall(desk.burnForCredit, (workspace, amount)), false);
        floorRejects = mode == 3;
        if (floorRejects) nFloorRejects++;
        data = abi.encodeCall(desk.burnForCreditMin, (workspace, amount, expectUsd + (floorRejects ? 1 : 0)));
    }

    /// @dev The revert a purchase must produce when the price is its first blocker (the desk checks pause,
    ///      amount and `minBurn` before quoting, and quotes before touching the allowance): `PriceUnavailable`
    ///      for a zero price, `PriceStale` for an old or far-future one, zero when something else fails first.
    function _priceError(uint256 amount) internal view returns (bytes4) {
        if (desk.paused() || amount == 0 || amount < desk.minBurn()) return bytes4(0);
        (uint256 price, uint256 updatedAt) = ps.latestPrice();
        if (price == 0) return CreditDesk.PriceUnavailable.selector;
        if (!_fresh(updatedAt)) return CreditDesk.PriceStale.selector;
        return bytes4(0);
    }

    function _countBlockers() internal {
        if (desk.paused()) nAttemptsPaused++;
        (uint256 price, uint256 updatedAt) = ps.latestPrice();
        if (price == 0) nAttemptsUnavailable++;
        else if (!_fresh(updatedAt)) nAttemptsStale++;
    }

    function _refreshPrice() internal {
        (uint256 p,) = ps.latestPrice();
        ps.set(p == 0 ? 1e16 : p, block.timestamp);
    }

    /// @dev Receipt ids must be sequential; ghost totals come from exactly one desk event per call, and the
    ///      event's amount, µUSD and price must match the independent prediction.
    function _onReceipt(uint256 rid, bytes32 topic, uint256 amount, uint256 expectUsd) internal {
        assertEq(rid, lastReceiptId + 1, "receipt id not sequential");
        lastReceiptId = rid;
        ghostReceipts++;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (uint256 sourcePrice,) = ps.latestPrice();
        uint256 found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(desk) || logs[i].topics[0] != topic) continue;
            uint256 amt;
            uint256 usd;
            uint256 price;
            if (topic == CreditDesk.CreditPurchased.selector) {
                assertEq(uint256(logs[i].topics[1]), rid, "event receipt id");
                (amt, usd, price) = abi.decode(logs[i].data, (uint256, uint256, uint256));
            } else {
                assertEq(uint256(logs[i].topics[2]), rid, "event receipt id");
                (amt, usd, price,) = abi.decode(logs[i].data, (uint256, uint256, uint256, bytes32));
            }
            assertEq(amt, amount, "event tokenAmount != amount");
            assertEq(usd, expectUsd, "event usdMicro != independent quote");
            assertEq(price, sourcePrice, "event priceE18 != source price");
            ghostBurned += amt;
            ghostUsd += usd;
            found++;
        }
        assertEq(found, 1, "expected exactly one credit event");
    }

    /// @dev Invariant 3 bookkeeping: once closed or expired, `drawn` is frozen forever.
    function _snapshotBudgets() internal {
        for (uint256 i = 0; i < _budgetIds.length; i++) {
            uint256 id = _budgetIds[i];
            CreditDesk.Budget memory b = _budget(id);
            assertLe(b.drawn, b.cap, "drawn > cap");
            if (b.closed || block.timestamp > b.deadline) {
                if (!frozen[id]) {
                    frozen[id] = true;
                    frozenDrawn[id] = b.drawn;
                } else {
                    assertEq(b.drawn, frozenDrawn[id], "frozen budget drawn changed");
                }
            }
        }
    }
}
