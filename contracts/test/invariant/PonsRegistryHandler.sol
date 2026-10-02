// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PonsMindRegistry} from "../../src/PonsMindRegistry.sol";
import {IPonsMindRegistry} from "../../src/interfaces/IPonsMindRegistry.sol";
import {IPonsV2LaunchFactory} from "../../src/interfaces/pons/IPonsV2LaunchFactory.sol";
import {MockPonsCurve} from "../mocks/pons/MockPonsCurve.sol";
import {MockPonsFactory} from "../mocks/pons/MockPonsFactory.sol";
import {MockPonsMemeHook} from "../mocks/pons/MockPonsMemeHook.sol";

/// @notice Drives the Pons registry and the Pons mocks with random but valid actions: launches (with initial buys,
///         some crossing the threshold), adoptions, pending-only preparations, takeovers (after a leave, a Pons
///         recipient override, or a return to the same account), curve trades, Pons operator sweeps, Pons owner
///         overrides, graduation and pool fees, harvests, funding, draws, withdrawals, fee changes, leaving to an heir,
///         donations to accounts, token recovery from accounts and time.
contract PonsRegistryHandler is Test {
    /// @notice An account replaced by a takeover (it may become current again if its preparer re-adopts).
    struct Superseded {
        address account;
        address token;
    }

    PonsMindRegistry public immutable registry;
    MockPonsFactory public immutable factory;
    MockPonsMemeHook public immutable hook;
    address public immutable owner;
    address public immutable operator;
    address public immutable ponsOperator;
    address public immutable ponsOwner;

    address[] public actors;
    address[] public tokens;
    Superseded[] public superseded;
    mapping(address account => uint256) public undelivered; // ETH sent straight to an account, not yet harvested
    mapping(address token => bool) public overridden; // Pons moved the recipient away from the mind account
    mapping(bytes32 action => uint256) public calls;
    uint256 internal _nonce;

    uint256 internal constant MAX_MINDS = 8;

    constructor(
        PonsMindRegistry registry_,
        MockPonsFactory factory_,
        MockPonsMemeHook hook_,
        address owner_,
        address operator_,
        address ponsOperator_,
        address ponsOwner_
    ) {
        registry = registry_;
        factory = factory_;
        hook = hook_;
        owner = owner_;
        operator = operator_;
        ponsOperator = ponsOperator_;
        ponsOwner = ponsOwner_;
        for (uint256 i; i < 4; ++i) {
            address a = makeAddr(string.concat("ponsActor", vm.toString(i)));
            actors.push(a);
            vm.deal(a, 100_000 ether);
        }
        // Two minds from the start so every action has targets.
        launchMind(0, 0.5 ether);
        launchMind(1, 0);
    }

    function tokensLength() external view returns (uint256) {
        return tokens.length;
    }

    function supersededLength() external view returns (uint256) {
        return superseded.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _token(uint256 seed) internal view returns (address) {
        return tokens[seed % tokens.length];
    }

    function _curve(address token) internal view returns (MockPonsCurve) {
        return MockPonsCurve(registry.ponsMind(token).curve);
    }

    function _phase(address token) internal view returns (IPonsV2LaunchFactory.GraduationPhase) {
        return factory.getLaunchedToken(token).phase;
    }

    function _params() internal returns (IPonsMindRegistry.LaunchParams memory p) {
        p.name = "Mind";
        p.symbol = "MIND";
        uint256 n = _nonce % 3; // creator tax 0, 1 or 2 %
        p.creatorTaxBps = n == 0 ? 0 : (n == 1 ? 100 : 200);
        p.salt = keccak256(abi.encode("salt", _nonce++));
    }

    // ---------------------------------------------------------------------------------------------
    // Actions
    // ---------------------------------------------------------------------------------------------

    function launchMind(uint256 actorSeed, uint256 quoteIn) public {
        if (tokens.length >= MAX_MINDS) return;
        address a = _actor(actorSeed);
        quoteIn = bound(quoteIn, 0, 6 ether);
        if (quoteIn != 0 && quoteIn < 1e12) quoteIn = 1e12;
        uint256 value = factory.launchFee() + quoteIn + registry.creationFee();
        IPonsMindRegistry.LaunchParams memory p = _params();
        vm.prank(a);
        (address token,,) = registry.launchMind{value: value}(p, quoteIn, 0, keccak256("m"), bytes32(0), "");
        tokens.push(token);
        calls["launchMind"]++;
    }

    function adopt(uint256 actorSeed) external {
        if (tokens.length >= MAX_MINDS) return;
        address a = _actor(actorSeed);
        IPonsV2LaunchFactory.TokenParams memory tp;
        tp.name = "Wild";
        tp.symbol = "WILD";
        tp.creatorTaxBps = 100;
        tp.salt = keccak256(abi.encode("wild", _nonce++));
        uint256 fee = factory.launchFee();
        vm.startPrank(a);
        (address token,) = factory.launchToken{value: fee}(tp, 0, address(0), new address[](0));
        address account = registry.prepareAdoption(token, keccak256("m"), bytes32(0), "");
        // Re-preparing a pending adoption updates it (same account, nothing registered yet).
        require(registry.prepareAdoption(token, keccak256("m2"), bytes32(0), "") == account, "account reused");
        require(!registry.isMind(token), "registered only at activation");
        factory.transferCreatorFeeRecipient(token, account);
        vm.stopPrank();
        registry.activateAdoption(token, a);
        tokens.push(token);
        calls["adopt"]++;
    }

    /// @dev A preparation that is never activated (or only later, by a takeover of the same preparer).
    function prepareOnly(uint256 actorSeed, uint256 tokenSeed) external {
        vm.prank(_actor(actorSeed));
        registry.prepareAdoption(_token(tokenSeed), keccak256("pending"), bytes32(0), "");
        calls["prepareOnly"]++;
    }

    /// @dev The heir takes the mind over: if the mind account still receives the fees, the creator first leaves to
    ///      the heir; the heir prepares, the current recipient hands over to the heir's account, anyone activates.
    function takeover(uint256 tokenSeed, uint256 heirSeed) external {
        address token = _token(tokenSeed);
        address heir = _actor(heirSeed);
        address previous = registry.accountOf(token);
        address recipient = factory.getLaunchedToken(token).creatorFeeRecipient;
        if (recipient == previous) {
            vm.prank(registry.getMind(token).creator);
            registry.leave(token, heir);
            undelivered[previous] = 0;
            recipient = heir;
        }
        vm.prank(heir);
        address account = registry.prepareAdoption(token, keccak256("heir"), bytes32(uint256(uint160(heir))), "");
        // Same account without a leave (Pons override): handing back would just make the mind whole again.
        if (account == previous && !registry.hasLeft(token)) return;
        vm.prank(recipient);
        factory.transferCreatorFeeRecipient(token, account);
        registry.activateAdoption(token, heir);
        require(registry.getMind(token).creator == heir && !registry.hasLeft(token), "taken over");
        if (account != previous) {
            undelivered[previous] = 0; // claimed into the vault during the takeover
            superseded.push(Superseded({account: previous, token: token}));
        }
        overridden[token] = false;
        calls["takeover"]++;
    }

    /// @dev Pons' owner moves the recipient (timelocked override) to an actor.
    function ponsOverride(uint256 tokenSeed, uint256 actorSeed) external {
        address token = _token(tokenSeed);
        address to = _actor(actorSeed);
        if (factory.getLaunchedToken(token).creatorFeeRecipient == to) return;
        vm.prank(ponsOwner);
        factory.setCreatorFeeRecipient(token, to);
        vm.warp(block.timestamp + factory.CREATOR_FEE_RECIPIENT_TIMELOCK());
        factory.executeCreatorFeeRecipientChange(token);
        overridden[token] = true;
        calls["ponsOverride"]++;
    }

    function buy(uint256 actorSeed, uint256 tokenSeed, uint256 amount) external {
        address token = _token(tokenSeed);
        MockPonsCurve curve = _curve(token);
        if (curve.graduated() || curve.sellableTokens() == 0) return;
        amount = bound(amount, 1e12, 3 ether);
        address a = _actor(actorSeed);
        vm.prank(a);
        curve.buy{value: amount}(amount, 0, a);
        calls["buy"]++;
    }

    function sell(uint256 actorSeed, uint256 tokenSeed, uint256 bps) external {
        address token = _token(tokenSeed);
        MockPonsCurve curve = _curve(token);
        if (curve.graduated() || curve.readyToGraduate()) return;
        address a = _actor(actorSeed);
        uint256 amount = IERC20(token).balanceOf(a) * bound(bps, 1, 10_000) / 10_000;
        if (amount == 0) return;
        vm.startPrank(a);
        IERC20(token).approve(address(curve), amount);
        try curve.sell(amount, 0, a) {
            calls["sell"]++;
        } catch {}
        vm.stopPrank();
    }

    function ponsSweep(uint256 tokenSeed) external {
        MockPonsCurve curve = _curve(_token(tokenSeed));
        if (curve.graduated()) return;
        vm.prank(ponsOperator);
        curve.sweepFees(1);
        calls["ponsSweep"]++;
    }

    function harvest(uint256 tokenSeed) external {
        address token = _token(tokenSeed);
        registry.harvest(token);
        undelivered[registry.accountOf(token)] = 0;
        calls["harvest"]++;
    }

    function createPool(uint256 tokenSeed, bool setOverride) external {
        address token = _token(tokenSeed);
        if (_phase(token) != IPonsV2LaunchFactory.GraduationPhase.Swept) return;
        registry.createGraduatedPool(token);
        bytes32 poolId = factory.poolIdFor(token);
        require(registry.derivedPoolId(token) == poolId, "derived pool id");
        if (setOverride) {
            vm.prank(operator);
            registry.setPoolId(token, poolId);
        }
        calls["createPool"]++;
    }

    function poolFees(uint256 tokenSeed, uint256 amount, uint256 taxBps) external {
        address token = _token(tokenSeed);
        if (_phase(token) != IPonsV2LaunchFactory.GraduationPhase.PoolCreated) return;
        amount = bound(amount, 1, 1 ether);
        uint256 tax = amount * bound(taxBps, 0, 1000) / 10_000;
        bytes32 poolId = factory.poolIdFor(token);
        vm.deal(address(this), address(this).balance + amount);
        hook.simulateSwapFees{value: amount}(poolId, tax);
        calls["poolFees"]++;
    }

    function fundMind(uint256 actorSeed, uint256 tokenSeed, uint256 amount) external {
        amount = bound(amount, 1, 1 ether);
        vm.prank(_actor(actorSeed));
        registry.fundMind{value: amount}(_token(tokenSeed));
        calls["fundMind"]++;
    }

    function drawCompute(uint256 tokenSeed, uint256 amount) external {
        address token = _token(tokenSeed);
        uint256 balance = registry.mindBalance(token);
        (uint256 maxPerEpoch, uint32 epochSeconds) = registry.drawLimit();
        (uint256 drawn, uint64 epochStart) = registry.drawnInEpoch(token);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= uint256(epochStart) + epochSeconds) drawn = 0;
        uint256 room = maxPerEpoch > drawn ? maxPerEpoch - drawn : 0;
        uint256 cap = balance < room ? balance : room;
        if (cap == 0) return;
        amount = bound(amount, 1, cap);
        vm.prank(operator);
        registry.drawCompute(token, amount, keccak256(abi.encode(amount)));
        calls["drawCompute"]++;
    }

    function withdrawProtocolFees() external {
        if (registry.protocolBalance() == 0) return;
        vm.prank(owner);
        registry.withdrawProtocolFees(owner);
        calls["withdrawProtocolFees"]++;
    }

    function setMindFeeBps(uint16 bps) external {
        vm.prank(owner);
        registry.setMindFeeBps(uint16(bound(bps, 0, 1000)));
        calls["setMindFeeBps"]++;
    }

    function setCreationFee(uint256 fee) external {
        vm.prank(owner);
        registry.setCreationFee(bound(fee, 0, 0.05 ether));
        calls["setCreationFee"]++;
    }

    function leave(uint256 tokenSeed, uint256 heirSeed) external {
        address token = _token(tokenSeed);
        address account = registry.accountOf(token);
        if (factory.getLaunchedToken(token).creatorFeeRecipient != account) return;
        vm.prank(registry.getMind(token).creator);
        registry.leave(token, _actor(heirSeed));
        undelivered[account] = 0; // leave harvests first
        calls["leave"]++;
    }

    /// @dev Memecoin sent to a mind account is recovered by the creator.
    function recoverTokens(uint256 actorSeed, uint256 tokenSeed, uint256 bps) external {
        address token = _token(tokenSeed);
        address a = _actor(actorSeed);
        uint256 amount = IERC20(token).balanceOf(a) * bound(bps, 1, 10_000) / 10_000;
        if (amount == 0) return;
        address account = registry.accountOf(token);
        vm.prank(a);
        require(IERC20(token).transfer(account, amount), "transfer");
        address creator = registry.getMind(token).creator;
        uint256 before = IERC20(token).balanceOf(creator);
        vm.prank(creator);
        registry.recoverAccountTokens(token, token);
        require(IERC20(token).balanceOf(creator) == before + amount, "recovered");
        calls["recoverTokens"]++;
    }

    function donateToAccount(uint256 actorSeed, uint256 tokenSeed, uint256 amount) external {
        address account = registry.accountOf(_token(tokenSeed));
        amount = bound(amount, 1, 0.1 ether);
        vm.prank(_actor(actorSeed));
        (bool ok,) = account.call{value: amount}("");
        require(ok, "donation");
        undelivered[account] += amount;
        calls["donateToAccount"]++;
    }

    function warp(uint256 secondsAhead) external {
        vm.warp(block.timestamp + bound(secondsAhead, 1, 2 days));
        calls["warp"]++;
    }

    receive() external payable {}
}
