// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {MindAccount} from "../src/MindAccount.sol";
import {PonsMindRegistry} from "../src/PonsMindRegistry.sol";
import {IMindCore} from "../src/interfaces/IMindCore.sol";
import {IPonsMindRegistry} from "../src/interfaces/IPonsMindRegistry.sol";
import {IPonsV2FeeEscrow} from "../src/interfaces/pons/IPonsV2FeeEscrow.sol";
import {IPonsV2LaunchFactory} from "../src/interfaces/pons/IPonsV2LaunchFactory.sol";
import {IPonsV2MemeHook} from "../src/interfaces/pons/IPonsV2MemeHook.sol";
import {MockPonsCurve} from "./mocks/pons/MockPonsCurve.sol";
import {MockPonsFactory} from "./mocks/pons/MockPonsFactory.sol";
import {MockPonsMemeHook} from "./mocks/pons/MockPonsMemeHook.sol";
import {PonsBaseTest} from "./utils/PonsBaseTest.sol";

// -------------------------------------------------------------------------------------------------
// Misbehaving accounts, etched over a real clone (same storage: slot 0 = registry, slot 1 = parameter)
// -------------------------------------------------------------------------------------------------

/// @notice Forwards the claim but reports one wei more than it sent.
contract MisreportingAccount {
    address private _registry;

    receive() external payable {}

    function claim(IPonsV2FeeEscrow escrow) external returns (uint256) {
        if (escrow.balanceOf(address(this)) != 0) escrow.claim();
        uint256 amount = address(this).balance;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "send");
        return amount + 1;
    }
}

/// @notice Tries to get its claim credited twice by routing it through `fundMind` during `harvest`.
contract FundMindAccount {
    address private _registry;

    receive() external payable {}

    function claim(IPonsV2FeeEscrow escrow) external returns (uint256) {
        if (escrow.balanceOf(address(this)) != 0) escrow.claim();
        uint256 amount = address(this).balance;
        address token = IPonsMindRegistry(msg.sender).tokenOf(address(this));
        IMindCore(msg.sender).fundMind{value: amount}(token);
        return amount;
    }
}

/// @notice Has a third contract (slot 1) push ETH into the registry during `harvest`.
contract SideChannelAccount {
    address private _registry;
    address private _helper;

    receive() external payable {}

    function claim(IPonsV2FeeEscrow) external returns (uint256) {
        EthPusher(payable(_helper)).push(msg.sender);
        return 0;
    }
}

/// @notice Returns its claim with a 2300-gas `transfer` (the registry's receive() writes storage).
contract StipendAccount {
    address private _registry;

    receive() external payable {}

    function claim(IPonsV2FeeEscrow escrow) external returns (uint256) {
        if (escrow.balanceOf(address(this)) != 0) escrow.claim();
        uint256 amount = address(this).balance;
        payable(msg.sender).transfer(amount);
        return amount;
    }
}

contract EthPusher {
    receive() external payable {}

    function push(address to) external {
        (bool ok, bytes memory err) = to.call{value: address(this).balance}("");
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(err, 0x20), mload(err))
            }
        }
    }
}

/// @notice SPEC §9.2/§9.7 harvest: best-effort sweeps (curve via the account, direct fallback, graduated pool on the
///         derived v4 pool id or the operator override), claim through the account with the return counter, mindFeeBps
///         split, EthReturnMismatch and the receive() gate, setPoolId, derivedPoolId vectors, createGraduatedPool,
///         claimable (escrow balance + account ETH).
contract PonsMindRegistryHarvestTest is PonsBaseTest {
    address internal token;
    address internal curve;
    address internal account;

    function setUp() public override {
        super.setUp();
        (token, curve, account) = _launch(creator, 1 ether);
        vm.warp(block.timestamp + 1 minutes); // past the snipe-tax window
    }

    // ---------------------------------------------------------------------------------------------
    // Curve phase
    // ---------------------------------------------------------------------------------------------

    function test_harvest_sweepsCurveThroughAccount_andCreditsVault() public {
        _buy(stranger, curve, 2 ether);
        uint256 tokens = _buy(alice, curve, 1 ether);
        _sell(alice, curve, tokens / 2);
        uint256 pending = MockPonsCurve(curve).quoteFeeBalance();
        uint256 share = _pendingCreatorShare(curve);
        uint256 protocolShare = pending * PROTOCOL_SHARE_BPS / 10_000;
        assertGt(share, 0);

        vm.expectEmit(true, false, false, true, address(registry));
        emit IPonsMindRegistry.SweepAttempted(token, true, false);
        vm.expectEmit(true, true, false, true, address(registry));
        emit IMindCore.MindFunded(token, account, share);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IMindCore.Harvested(token, share, 0);
        _harvest(token);

        assertEq(registry.mindBalance(token), share);
        assertEq(registry.protocolBalance(), 0);
        assertEq(escrow.balanceOf(ponsProtocol), protocolShare, "Pons protocol share credited");
        assertEq(escrow.balanceOf(account), 0);
        assertEq(account.balance, 0, "account holds nothing");
        assertEq(MockPonsCurve(curve).quoteFeeBalance(), 0);
        assertEq(MockPonsCurve(curve).creatorTaxBalance(), 0);
        assertEq(registry.claimable(token), 0);
        _assertSolvent();
    }

    function test_harvest_nothingToClaim() public {
        _harvest(token); // sweeps and claims the initial buy's fees
        uint256 balance = registry.mindBalance(token);
        vm.recordLogs();
        vm.expectEmit(true, false, false, true, address(registry));
        emit IPonsMindRegistry.SweepAttempted(token, true, false);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IMindCore.Harvested(token, 0, 0);
        _harvest(token);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 external_;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(this)) external_++;
        }
        assertEq(external_, 2, "no sweep, claim, MindFunded or FeeAccrued events");
        assertEq(registry.mindBalance(token), balance);
    }

    function test_harvest_afterPonsOperatorSweep() public {
        _buy(stranger, curve, 1 ether);
        uint256 share = _pendingCreatorShare(curve);
        vm.prank(ponsOperator);
        MockPonsCurve(curve).sweepFees(0);
        assertEq(registry.claimable(token), share);
        _harvest(token);
        assertEq(registry.mindBalance(token), share);
    }

    function test_sweepAuthorization() public {
        _buy(stranger, curve, 1 ether);
        // Only Pons' operator or the curve's creator fee recipient (the account) may sweep.
        vm.prank(stranger);
        vm.expectRevert(MockPonsCurve.NotFeeSweepOperator.selector);
        MockPonsCurve(curve).sweepFees(0);
        vm.prank(address(registry));
        vm.expectRevert(MockPonsCurve.NotFeeSweepOperator.selector);
        MockPonsCurve(curve).sweepFees(0);
        vm.prank(creator);
        vm.expectRevert(MockPonsCurve.NotFeeSweepOperator.selector);
        MockPonsCurve(curve).sweepFees(0);
        // The account itself is accepted (harvest drives it).
        vm.prank(account);
        MockPonsCurve(curve).sweepFees(0);
    }

    function test_harvest_directSweepFallback_whenRegistryIsAuthorized() public {
        // After leaving, the account can no longer sweep. If the registry itself is authorized on the curve (here:
        // Pons' sweep operator), the direct fallback still distributes the pending fees (to the new recipient).
        vm.prank(creator);
        registry.leave(token, creator);
        _buy(stranger, curve, 1 ether);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IPonsMindRegistry.SweepAttempted(token, false, false);
        _harvest(token);
        assertGt(MockPonsCurve(curve).quoteFeeBalance(), 0);

        vm.prank(ponsOwner);
        hook.setFeeSweepOperator(address(registry));
        uint256 creatorShare = _pendingCreatorShare(curve);
        uint256 vaultBefore = registry.mindBalance(token);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IPonsMindRegistry.SweepAttempted(token, true, false);
        _harvest(token);
        assertEq(MockPonsCurve(curve).quoteFeeBalance(), 0);
        assertEq(escrow.balanceOf(creator), creatorShare, "fees follow the current recipient");
        assertEq(registry.mindBalance(token), vaultBefore);
    }

    function test_harvest_buybackPending_sweepSkipped() public {
        // Buyback launches cannot be prepared, but the recipient may enable buyback after preparing: activation does
        // not re-check (refusing would strand the handed-over stream). The account may not sweep (the internal swap
        // needs Pons' operator); harvest records the failure and still claims what the escrow holds.
        (address wild, address wildCurve) = _launchDirect(alice, alice, keccak256("bb"), false);
        address wildAccount = _prepareAdoption(wild, alice);
        vm.prank(alice);
        factory.setBuybackEnabled(wild, true);
        vm.prank(alice);
        factory.transferCreatorFeeRecipient(wild, wildAccount);
        registry.activateAdoption(wild, alice);
        assertTrue(factory.getLaunchedToken(wild).buybackEnabled);
        vm.warp(block.timestamp + 1 minutes);
        _buy(stranger, wildCurve, 1 ether);
        assertGt(MockPonsCurve(wildCurve).buybackQuoteBalance(), 0);

        vm.expectEmit(true, false, false, true, address(registry));
        emit IPonsMindRegistry.SweepAttempted(wild, false, false);
        _harvest(wild);
        assertEq(registry.mindBalance(wild), 0);

        // Pons' operator sweeps (buyback folded back in the model); the next harvest claims the creator share.
        uint256 pending = MockPonsCurve(wildCurve).quoteFeeBalance();
        uint256 share = pending - pending * PROTOCOL_SHARE_BPS / 10_000 + MockPonsCurve(wildCurve).creatorTaxBalance();
        vm.prank(ponsOperator);
        MockPonsCurve(wildCurve).sweepFees(1);
        _harvest(wild);
        assertEq(registry.mindBalance(wild), share);
        _assertSolvent();
    }

    // ---------------------------------------------------------------------------------------------
    // mindFeeBps
    // ---------------------------------------------------------------------------------------------

    function test_harvest_mindFeeSplit() public {
        vm.expectEmit(false, false, false, true, address(registry));
        emit IPonsMindRegistry.MindFeeUpdated(1000);
        vm.prank(owner);
        registry.setMindFeeBps(1000);
        assertEq(registry.mindFeeBps(), 1000);

        _buy(stranger, curve, 3 ether);
        uint256 ethOut = _pendingCreatorShare(curve);
        uint256 cut = ethOut * 1000 / 10_000;
        vm.expectEmit(true, false, false, true, address(registry));
        emit IMindCore.FeeAccrued(token, 0, cut);
        vm.expectEmit(true, true, false, true, address(registry));
        emit IMindCore.MindFunded(token, account, ethOut - cut);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IMindCore.Harvested(token, ethOut - cut, 0);
        _harvest(token);
        assertEq(registry.mindBalance(token), ethOut - cut);
        assertEq(registry.protocolBalance(), cut);
        _assertSolvent();

        vm.prank(treasury);
        registry.withdrawProtocolFees(treasury);
        assertEq(registry.protocolBalance(), 0);
        _assertSolvent();
    }

    function test_setMindFeeBps_bounds() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        registry.setMindFeeBps(10);
        vm.prank(owner);
        vm.expectRevert(IMindCore.FeeTooHigh.selector);
        registry.setMindFeeBps(1001);
        vm.prank(owner);
        registry.setMindFeeBps(1000);
        vm.prank(owner);
        registry.setMindFeeBps(0);
        assertEq(registry.mindFeeBps(), 0);
    }

    function testFuzz_harvest_creditsExactly(uint256 buyIn, uint256 sellBps, uint16 feeBps) public {
        buyIn = bound(buyIn, 0.001 ether, 3 ether);
        feeBps = uint16(bound(feeBps, 0, 1000));
        vm.prank(owner);
        registry.setMindFeeBps(feeBps);
        uint256 tokens = _buy(alice, curve, buyIn);
        uint256 toSell = tokens * bound(sellBps, 0, 10_000) / 10_000;
        if (toSell > 0) _sell(alice, curve, toSell);

        uint256 ethOut = _pendingCreatorShare(curve);
        uint256 cut = ethOut * feeBps / 10_000;
        _harvest(token);
        assertEq(registry.mindBalance(token), ethOut - cut);
        assertEq(registry.protocolBalance(), cut);
        assertEq(account.balance, 0);
        assertEq(escrow.balanceOf(account), 0);
        _assertSolvent();
    }

    // ---------------------------------------------------------------------------------------------
    // Graduation phases
    // ---------------------------------------------------------------------------------------------

    function test_harvest_sweptPhase_claimsGraduationSweep() public {
        uint256 share = _pendingCreatorShare(curve);
        _graduate(stranger, curve);
        assertEq(uint8(_phase(token)), uint8(IPonsV2LaunchFactory.GraduationPhase.Swept));
        uint256 credited = escrow.balanceOf(account);
        assertGt(credited, share, "graduation swept the pending fees, including the crossing buy's");
        vm.expectEmit(true, false, false, true, address(registry));
        emit IPonsMindRegistry.SweepAttempted(token, false, false);
        _harvest(token);
        assertEq(registry.mindBalance(token), credited);
    }

    function test_createGraduatedPool_viaRegistry() public {
        vm.expectRevert(MockPonsFactory.WrongGraduationPhase.selector);
        registry.createGraduatedPool(token);
        vm.expectRevert(IMindCore.NotAMind.selector);
        registry.createGraduatedPool(makeAddr("random"));

        _graduate(stranger, curve);
        bytes32 poolId = factory.poolIdFor(token);
        vm.expectEmit(true, false, false, true, address(hook));
        emit IPonsV2MemeHook.PoolRegistered(poolId, token, address(0), account);
        vm.prank(stranger);
        registry.createGraduatedPool(token);
        assertEq(uint8(_phase(token)), uint8(IPonsV2LaunchFactory.GraduationPhase.PoolCreated));
    }

    function test_harvest_poolPhase_derivedPoolId_andOperatorOverride() public {
        _graduate(stranger, curve);
        registry.createGraduatedPool(token);
        bytes32 poolId = factory.poolIdFor(token);
        assertEq(registry.derivedPoolId(token), poolId);
        assertEq(registry.poolIdOf(token), bytes32(0));
        _harvest(token); // claims the graduation sweep
        uint256 vault = registry.mindBalance(token);
        uint256 share = 0.95 ether - 0.95 ether * PROTOCOL_SHARE_BPS / 10_000 + 0.05 ether;

        // No override: the derived pool id is swept.
        hook.simulateSwapFees{value: 1 ether}(poolId, 0.05 ether);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IPonsMindRegistry.SweepAttempted(token, false, true);
        _harvest(token);
        assertEq(registry.mindBalance(token), vault + share);
        vault += share;

        // An operator override takes precedence (a wrong one makes the sweep fail, nothing is lost).
        vm.prank(stranger);
        vm.expectRevert(IMindCore.NotOperator.selector);
        registry.setPoolId(token, poolId);
        vm.prank(operator);
        vm.expectRevert(IMindCore.NotAMind.selector);
        registry.setPoolId(makeAddr("random"), poolId);
        bytes32 wrong = keccak256("wrong");
        vm.expectEmit(true, false, false, true, address(registry));
        emit IPonsMindRegistry.PoolIdSet(token, wrong);
        vm.prank(operator);
        registry.setPoolId(token, wrong);
        assertEq(registry.poolIdOf(token), wrong);
        hook.simulateSwapFees{value: 1 ether}(poolId, 0.05 ether);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IPonsMindRegistry.SweepAttempted(token, false, false);
        _harvest(token);
        assertEq(registry.mindBalance(token), vault);

        // Correct override, then cleared (zero): both sweep the right pool.
        vm.prank(operator);
        registry.setPoolId(token, poolId);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IPonsMindRegistry.SweepAttempted(token, false, true);
        _harvest(token);
        assertEq(registry.mindBalance(token), vault + share);
        vm.prank(operator);
        registry.setPoolId(token, bytes32(0));
        hook.simulateSwapFees{value: 1 ether}(poolId, 0.05 ether);
        _harvest(token);
        assertEq(registry.mindBalance(token), vault + 2 * share);
        assertGt(escrow.balanceOf(ponsProtocol), 0);
        _assertSolvent();
    }

    // ---------------------------------------------------------------------------------------------
    // derivedPoolId: Uniswap v4 PoolId = keccak256(abi.encode(PoolKey))
    // ---------------------------------------------------------------------------------------------

    /// @dev Verbatim copy of Uniswap v4-core `PoolIdLibrary.toId`: hashes the 5-word in-memory `PoolKey`.
    function _v4ToId(IPonsV2MemeHook.PoolKey memory key) internal pure returns (bytes32 poolId) {
        assembly ("memory-safe") {
            poolId := keccak256(key, 0xa0)
        }
    }

    function test_derivedPoolId_matchesPonsHookAndV4() public {
        _graduate(stranger, curve);
        vm.recordLogs();
        registry.createGraduatedPool(token);
        bytes32 registered;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == IPonsV2MemeHook.PoolRegistered.selector) {
                registered = logs[i].topics[1];
            }
        }
        IPonsV2MemeHook.PoolKey memory key = IPonsV2MemeHook.PoolKey({
            currency0: address(0), currency1: token, fee: POOL_FEE, tickSpacing: TICK_SPACING, hooks: address(hook)
        });
        assertTrue(registered != bytes32(0));
        assertEq(registry.derivedPoolId(token), registered, "== hook PoolRegistered id");
        assertEq(registry.derivedPoolId(token), _v4ToId(key), "== v4 PoolIdLibrary.toId");
        assertEq(registry.derivedPoolId(token), keccak256(abi.encode(key)));
        // Zero for tokens that are not native-quote Pons launches.
        assertEq(registry.derivedPoolId(makeAddr("random")), bytes32(0));
    }

    /// @dev Known vectors computed off-chain from the raw ABI encoding of the 5-tuple
    ///      (`cast keccak $(cast abi-encode "f((address,address,uint24,int24,address))" "(0x0…0,0x1111…1111,10000,200,
    ///      0xE5e7…e044)")`), checked against a registry wired to the mainnet hook address.
    function test_derivedPoolId_knownVectors() public {
        address mainnetHook = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;
        address coin = 0x1111111111111111111111111111111111111111;
        PonsMindRegistry r = new PonsMindRegistry(
            owner, treasury, computeTreasury, operator, address(factory), address(escrow), mainnetHook
        );
        IPonsV2LaunchFactory.LaunchedToken memory lt;
        lt.token = coin;
        lt.exists = true;
        lt.poolFee = 10_000;
        lt.tickSpacing = 200;
        vm.mockCall(address(factory), abi.encodeCall(IPonsV2LaunchFactory.getLaunchedToken, (coin)), abi.encode(lt));
        bytes32 expected = 0x51a32dcddaf6614976a48d3001e0ccffe7efda9be089f31410d0975777ee00eb;
        assertEq(r.derivedPoolId(coin), expected);
        assertEq(
            _v4ToId(
                IPonsV2MemeHook.PoolKey({
                    currency0: address(0), currency1: coin, fee: 10_000, tickSpacing: 200, hooks: mainnetHook
                })
            ),
            expected
        );
        // A negative tick spacing (sign extension of int24) encodes identically in memory and in abi.encode.
        lt.poolFee = 3000;
        lt.tickSpacing = -60;
        vm.mockCall(address(factory), abi.encodeCall(IPonsV2LaunchFactory.getLaunchedToken, (coin)), abi.encode(lt));
        assertEq(r.derivedPoolId(coin), 0x39db912e2807e24c8642609d46d7c5d76a5e70f4f89cf1a33a85d2a47b15e4c6);
        // A non-native pair is not derivable.
        lt.pairToken = makeAddr("usdc");
        vm.mockCall(address(factory), abi.encodeCall(IPonsV2LaunchFactory.getLaunchedToken, (coin)), abi.encode(lt));
        assertEq(r.derivedPoolId(coin), bytes32(0));
    }

    function testFuzz_poolKeyAbiEncoding_equalsV4MemoryHash(address coin, uint24 fee, int24 tickSpacing, address hk)
        public
        pure
    {
        IPonsV2MemeHook.PoolKey memory key = IPonsV2MemeHook.PoolKey({
            currency0: address(0), currency1: coin, fee: fee, tickSpacing: tickSpacing, hooks: hk
        });
        assertEq(keccak256(abi.encode(key)), _v4ToId(key));
        assertEq(keccak256(abi.encode(address(0), coin, fee, tickSpacing, hk)), _v4ToId(key));
    }

    function test_claimable_includesAccountEth() public {
        uint256 share = _pendingCreatorShare(curve);
        vm.prank(ponsOperator);
        MockPonsCurve(curve).sweepFees(0);
        assertEq(registry.claimable(token), share);
        vm.prank(stranger);
        (bool ok,) = account.call{value: 0.25 ether}("");
        assertTrue(ok);
        assertEq(registry.claimable(token), share + 0.25 ether);
        _harvest(token);
        assertEq(registry.mindBalance(token), share + 0.25 ether);
        assertEq(registry.claimable(token), 0);
    }

    function test_harvest_poolSweep_memecoinFeesNeedOperator() public {
        _graduate(stranger, curve);
        registry.createGraduatedPool(token);
        bytes32 poolId = factory.poolIdFor(token);
        vm.prank(operator);
        registry.setPoolId(token, poolId);
        hook.simulateSwapFees{value: 1 ether}(poolId, 0);
        hook.simulateMemecoinFees(poolId, 1000 ether);

        vm.expectEmit(true, false, false, true, address(registry));
        emit IPonsMindRegistry.SweepAttempted(token, false, false);
        _harvest(token);
        assertEq(hook.pendingFees(poolId), 1 ether, "sweep refused, nothing lost");

        // Stranger / registry cannot sweep the pool; Pons' operator can, then harvest claims.
        vm.prank(stranger);
        vm.expectRevert(MockPonsMemeHook.NotFeeSweepOperator.selector);
        hook.sweepPoolFees(poolId, 0, 0);
        vm.prank(ponsOperator);
        hook.sweepPoolFees(poolId, 1, 0);
        uint256 vault = registry.mindBalance(token);
        _harvest(token);
        assertEq(registry.mindBalance(token), vault + 0.7 ether);
    }

    // ---------------------------------------------------------------------------------------------
    // Return counter and receive() gate
    // ---------------------------------------------------------------------------------------------

    function test_harvest_misreportingAccount_reverts() public {
        _buy(stranger, curve, 1 ether);
        vm.etch(account, address(new MisreportingAccount()).code);
        vm.expectRevert(IMindCore.EthReturnMismatch.selector);
        _harvest(token);
    }

    function test_harvest_returnThroughFundMind_reverts_noDoubleCredit() public {
        _buy(stranger, curve, 1 ether);
        vm.etch(account, address(new FundMindAccount()).code);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        _harvest(token);
        assertEq(registry.mindBalance(token), 0);
    }

    function test_harvest_ethFromAnotherAddress_rejected() public {
        EthPusher pusher = new EthPusher();
        vm.deal(address(pusher), 1 ether);
        vm.etch(account, address(new SideChannelAccount()).code);
        vm.store(account, bytes32(uint256(1)), bytes32(uint256(uint160(address(pusher)))));
        vm.expectRevert(IMindCore.DirectEthNotAccepted.selector);
        _harvest(token);
    }

    function test_harvest_stipendReturn_fails() public {
        _buy(stranger, curve, 1 ether);
        _harvest(token); // nothing wrong with the real account
        _buy(stranger, curve, 1 ether);
        vm.etch(account, address(new StipendAccount()).code);
        vm.expectRevert();
        _harvest(token);
    }

    function test_receive_rejectsEveryoneOutsideReturnWindows() public {
        address[4] memory senders = [stranger, account, curve, address(escrow)];
        for (uint256 i; i < senders.length; ++i) {
            vm.deal(senders[i], 1 ether);
            vm.prank(senders[i]);
            (bool ok, bytes memory err) = address(registry).call{value: 1}("");
            assertFalse(ok);
            assertEq(err, abi.encodeWithSelector(IMindCore.DirectEthNotAccepted.selector));
        }
    }

    function test_harvest_forwardsEthSentToTheAccount() public {
        // ETH donated straight to the account is forwarded on the next harvest and counted like a claim.
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = account.call{value: 0.3 ether}("");
        assertTrue(ok);
        uint256 share = _pendingCreatorShare(curve);
        _harvest(token);
        assertEq(registry.mindBalance(token), share + 0.3 ether);
        _assertSolvent();
    }

    function test_forcedEth_notCounted() public {
        _harvest(token);
        uint256 vault = registry.mindBalance(token);
        vm.deal(address(registry), address(registry).balance + 1 ether); // e.g. selfdestruct
        _buy(stranger, curve, 1 ether);
        uint256 share = _pendingCreatorShare(curve);
        _harvest(token);
        assertEq(registry.mindBalance(token), vault + share, "only the account's return is credited");
        assertEq(address(registry).balance, _liabilities() + 1 ether);
    }

    function test_harvest_guards() public {
        vm.expectRevert(IMindCore.NotAMind.selector);
        registry.harvest(makeAddr("random"));
        assertEq(registry.claimable(makeAddr("random")), 0);
        // Not pausable.
        vm.prank(owner);
        registry.pause();
        _harvest(token);
    }

    function test_mindAccount_onlyRegistry() public {
        vm.startPrank(stranger);
        (bool ok, bytes memory err) = account.call(abi.encodeWithSignature("claim(address)", address(escrow)));
        assertFalse(ok);
        assertEq(err, abi.encodeWithSelector(MindAccount.NotRegistry.selector));
        bytes memory notRegistry = abi.encodeWithSelector(MindAccount.NotRegistry.selector);
        (ok, err) = account.call(abi.encodeWithSignature("sweepCurve(address,uint256)", curve, 0));
        assertFalse(ok);
        assertEq(err, notRegistry);
        (ok, err) = account.call(
            abi.encodeWithSignature("sweepPool(address,bytes32,uint256,uint256)", address(hook), bytes32(0), 0, 0)
        );
        assertFalse(ok);
        assertEq(err, notRegistry);
        (ok, err) = account.call(
            abi.encodeWithSignature("transferFeeRecipient(address,address,address)", address(factory), token, stranger)
        );
        assertFalse(ok);
        assertEq(err, notRegistry);
        (ok, err) = account.call(abi.encodeWithSignature("sweepTokens(address,address)", token, stranger));
        assertFalse(ok);
        assertEq(err, notRegistry);
        (ok, err) = account.call(abi.encodeWithSignature("initialize(address)", stranger));
        assertFalse(ok);
        assertEq(err, abi.encodeWithSelector(MindAccount.AlreadyInitialized.selector));
        vm.stopPrank();
        assertEq(factory.getLaunchedToken(token).creatorFeeRecipient, account);
    }
}
