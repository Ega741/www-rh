// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IMindCore} from "../../../src/interfaces/IMindCore.sol";
import {IPonsMindRegistry} from "../../../src/interfaces/IPonsMindRegistry.sol";
import {MockPonsCurve} from "../../mocks/pons/MockPonsCurve.sol";
import {PonsBaseTest} from "../../utils/PonsBaseTest.sol";

/// @notice AUDIT PoCs for PonsMindRegistry / MindAccount (Pons mode, SPEC §9.2). Tests named test_POC_* assert the
///         SAFE behaviour (they failed on the first adoption design and pass since SPEC §9.7; adjusted only where §9.7
///         changed the interface: per-preparer accounts, registration at activation, `activateAdoption(token,
///         preparer)`); test_control_* pass and document the mechanics.
contract AuditPonsRegistryTest is PonsBaseTest {
    address internal wild;
    address internal wildCurve;
    address internal carol = makeAddr("carol");

    function setUp() public override {
        super.setUp();
        // Alice launched a coin directly on Pons; Bob receives its creator fees.
        (wild, wildCurve) = _launchDirect(alice, bob, keccak256("wild"), false);
        vm.warp(block.timestamp + 1 minutes); // past the snipe-tax window
        vm.deal(carol, 100 ether);
    }

    // ---------------------------------------------------------------------------------------------
    // M-1: a stale pending preparation captures a later recipient's hand-off (shared per-token account)
    // ---------------------------------------------------------------------------------------------

    /// Bob (recipient) prepares an adoption, then sells the creator-fee role to Carol. Carol hands the role to the
    /// mind account the registry advertises for the token (`accountOf(wild)`) without re-preparing first (or in the
    /// wrong order: a prepare after the hand-off reverts, she is no longer the recipient). Anyone activates; Bob is
    /// still the mind's creator and pulls Carol's fee stream to himself with `leave`.
    function test_POC_M1_stalePreparerCapturesHandOff() public {
        vm.prank(bob);
        address account = registry.prepareAdoption(wild, MODEL_ID, PERSONA_HASH, METADATA_URI);
        vm.prank(bob);
        factory.transferCreatorFeeRecipient(wild, carol); // OTC sale of the fee stream

        // SPEC §9.7: nothing is registered at preparation, so there is no shared "advertised" account; Bob's
        // preparation is bound to Bob's own account. Carol prepares after the hand-off (anyone may) and hands the
        // stream to her own account.
        assertEq(registry.accountOf(wild), address(0));
        vm.prank(carol);
        address carolAccount = registry.prepareAdoption(wild, MODEL_ID, PERSONA_HASH, METADATA_URI);
        assertTrue(carolAccount != account);
        vm.prank(carol);
        factory.transferCreatorFeeRecipient(wild, carolAccount);

        vm.expectRevert(IPonsMindRegistry.AdoptionNotReady.selector);
        registry.activateAdoption(wild, bob); // the stale preparation activates nothing
        registry.activateAdoption(wild, carol); // permissionless
        assertEq(registry.getMind(wild).creator, carol, "creator is whoever's account received the stream");

        // SAFE: Bob, who no longer owned the fee stream when it was handed over, must not be able to take it.
        vm.prank(bob);
        vm.expectRevert();
        registry.leave(wild, bob);
        assertEq(factory.getLaunchedToken(wild).creatorFeeRecipient, carolAccount, "Carol's stream stays with the mind");
    }

    // ---------------------------------------------------------------------------------------------
    // L-1: after `leave`, a token can never be (re-)adopted by its new recipient
    // ---------------------------------------------------------------------------------------------

    function test_POC_L1_tokenCannotBeReadoptedAfterLeave() public {
        vm.prank(bob);
        address account = registry.prepareAdoption(wild, MODEL_ID, PERSONA_HASH, METADATA_URI);
        vm.prank(bob);
        factory.transferCreatorFeeRecipient(wild, account);
        registry.activateAdoption(wild, bob);
        vm.prank(bob);
        registry.leave(wild, carol); // Bob sells the stream to Carol

        // SAFE: Carol, the current recipient, can prepare a fresh adoption and take over (replacing the stale creator).
        vm.prank(carol);
        address carolAccount = registry.prepareAdoption(wild, MODEL_ID, PERSONA_HASH, METADATA_URI);
        vm.prank(carol);
        factory.transferCreatorFeeRecipient(wild, carolAccount);
        registry.activateAdoption(wild, carol); // takeover
        assertEq(registry.getMind(wild).creator, carol);
    }

    // ---------------------------------------------------------------------------------------------
    // L-2: `leave` hands fees earned while the account was the recipient (not yet swept) to the new recipient
    // ---------------------------------------------------------------------------------------------

    function test_POC_L2_leaveDivertsUnsweptFeesFromVault() public {
        (address token, address curve,) = _launch(creator, 0);
        vm.warp(block.timestamp + 1 minutes);
        _buy(stranger, curve, 2 ether); // volume while the mind account is the creator fee recipient
        uint256 earnedByMind = _pendingCreatorShare(curve);
        assertGt(earnedByMind, 0);

        vm.prank(creator);
        registry.leave(token, creator); // no sweep/claim first
        vm.prank(ponsOperator);
        MockPonsCurve(curve).sweepFees(0); // next Pons sweep credits the CURRENT recipient
        _harvest(token);

        // SAFE: the mind vault receives what was earned while the account was the recipient.
        assertEq(registry.mindBalance(token), earnedByMind, "vault"); // current code: 0, the creator got it
    }

    // ---------------------------------------------------------------------------------------------
    // L-3: `leave` to the registry (or another mind account) bricks the fee stream irrecoverably
    // ---------------------------------------------------------------------------------------------

    function test_POC_L3_leaveToRegistryBricksFeeStream() public {
        (address token,,) = _launch(creator, 0);
        vm.prank(creator);
        vm.expectRevert(); // SAFE: rejected. Current code: succeeds; nobody can ever move or claim the stream again
        registry.leave(token, address(registry));
    }

    // ---------------------------------------------------------------------------------------------
    // I-1: a pending (never activated) adoption can be made Alive by its preparer
    // ---------------------------------------------------------------------------------------------

    function test_POC_I1_pendingAdoptionCanBeMadeAlive() public {
        vm.startPrank(bob);
        registry.prepareAdoption(wild, MODEL_ID, PERSONA_HASH, METADATA_URI);
        // SPEC §9.7: a pending adoption registers no mind, so its preparer has no status to toggle.
        vm.expectRevert(IMindCore.NotCreator.selector);
        registry.setCreatorPaused(wild, true);
        vm.expectRevert(IMindCore.NotCreator.selector);
        registry.setCreatorPaused(wild, false);
        vm.stopPrank();
        assertFalse(registry.ponsMind(wild).adopted);
        // SAFE: nothing can be Alive before activateAdoption (there is no mind at all).
        assertFalse(registry.isMind(wild));
    }

    // ---------------------------------------------------------------------------------------------
    // Controls (pass): ETH accounting holds under donations to accounts / escrow and refunds
    // ---------------------------------------------------------------------------------------------

    function test_control_donationsToAccountAndEscrowAreHarvestedSolvently() public {
        (address token, address curve, address account) = _launch(creator, 1 ether);
        vm.warp(block.timestamp + 1 minutes);
        // Donations: direct ETH to the account, and an escrow credit by a third party.
        vm.prank(stranger);
        (bool ok,) = account.call{value: 0.3 ether}("");
        assertTrue(ok);
        vm.prank(stranger);
        escrow.credit{value: 0.2 ether}(account);
        _buy(stranger, curve, 1 ether);
        uint256 share = _pendingCreatorShare(curve);
        vm.prank(owner);
        registry.setMindFeeBps(1000);
        _harvest(token);
        // initial-buy fees were pending too; everything that reached the account is split 10/90
        uint256 total = registry.mindBalance(token) + registry.protocolBalance();
        assertGe(total, share + 0.5 ether);
        assertEq(account.balance, 0);
        assertEq(escrow.balanceOf(account), 0);
        _assertSolvent();
    }

    function test_control_samePonsSaltDifferentCreators_noCollision() public {
        (address t1,, address a1) = _launchWith(creator, _params(SALT), 0, 0);
        (address t2,, address a2) = _launchWith(alice, _params(SALT), 0, 0);
        assertTrue(t1 != t2 && a1 != a2);
        assertEq(a1, registry.predictAccount(creator, SALT));
        assertEq(a2, registry.predictAccount(alice, SALT));
        // a launch account never collides with an adoption account: the first word of an adoption salt preimage is a
        // Pons token, which never calls launchMind (SPEC §9.7 salt keccak256(abi.encode(token, preparer)))
        assertTrue(registry.predictAdoptionAccount(t1, creator) != a1);
    }
}
