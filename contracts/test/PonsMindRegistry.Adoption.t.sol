// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MindAccount} from "../src/MindAccount.sol";
import {IMindCore} from "../src/interfaces/IMindCore.sol";
import {IPonsMindRegistry} from "../src/interfaces/IPonsMindRegistry.sol";
import {IPonsV2LaunchFactory} from "../src/interfaces/pons/IPonsV2LaunchFactory.sol";
import {MockPonsCurve} from "./mocks/pons/MockPonsCurve.sol";
import {MockPonsFactory} from "./mocks/pons/MockPonsFactory.sol";
import {PonsBaseTest} from "./utils/PonsBaseTest.sol";

/// @notice SPEC §9.2 adoption (prepareAdoption -> transferCreatorFeeRecipient -> activateAdoption) and leave.
contract PonsMindRegistryAdoptionTest is PonsBaseTest {
    address internal wild;
    address internal wildCurve;

    function setUp() public override {
        super.setUp();
        // Alice launched a coin directly on Pons; Bob receives its creator fees.
        (wild, wildCurve) = _launchDirect(alice, bob, keccak256("wild"), false);
        vm.warp(block.timestamp + 1 minutes); // past the snipe-tax window
    }

    function _prepare(address who) internal returns (address account) {
        vm.prank(who);
        account = registry.prepareAdoption(wild, MODEL_ID, PERSONA_HASH, METADATA_URI);
    }

    function _handOver(address account) internal {
        vm.prank(bob);
        factory.transferCreatorFeeRecipient(wild, account);
    }

    // ---------------------------------------------------------------------------------------------
    // prepareAdoption
    // ---------------------------------------------------------------------------------------------

    function test_prepareAdoption_byRecipient() public {
        address predicted = registry.predictAdoptionAccount(wild);
        vm.expectEmit(true, true, true, true, address(registry));
        emit IPonsMindRegistry.AdoptionPrepared(wild, predicted, bob);
        address account = _prepare(bob);

        assertEq(account, predicted);
        assertTrue(registry.isMind(wild));
        assertEq(registry.mindsLength(), 1);
        IMindCore.MindInfo memory info = registry.getMind(wild);
        assertEq(info.creator, bob);
        assertEq(info.modelId, MODEL_ID);
        assertEq(info.personaHash, PERSONA_HASH);
        assertEq(info.metadataURI, METADATA_URI);
        assertEq(info.createdAt, block.timestamp);
        assertEq(uint8(info.status), uint8(IMindCore.MindStatus.Dormant));
        IPonsMindRegistry.PonsMind memory m = registry.ponsMind(wild);
        assertEq(m.curve, wildCurve);
        assertEq(m.account, account);
        assertEq(m.launchConfigId, 0);
        assertFalse(m.launchedHere);
        assertFalse(m.adopted);
        assertEq(registry.tokenOf(account), wild);
        assertEq(MindAccount(payable(account)).registry(), address(registry));
        // Nothing moved on Pons yet.
        assertEq(factory.getLaunchedToken(wild).creatorFeeRecipient, bob);
    }

    function test_prepareAdoption_deployerCannotSquat() public {
        // Alice launched the coin but Bob receives its fees: Alice cannot occupy the token's adoption slot.
        vm.prank(alice);
        vm.expectRevert(IPonsMindRegistry.NotRecipientOrDeployer.selector);
        registry.prepareAdoption(wild, MODEL_ID, PERSONA_HASH, METADATA_URI);
        assertFalse(registry.isMind(wild));
        assertEq(registry.mindsLength(), 0);
        // Bob still can.
        address account = _prepare(bob);
        assertEq(registry.getMind(wild).creator, bob);
        assertEq(account, registry.predictAdoptionAccount(wild));
    }

    function test_prepareAdoption_wrongCaller() public {
        vm.prank(stranger);
        vm.expectRevert(IPonsMindRegistry.NotRecipientOrDeployer.selector);
        registry.prepareAdoption(wild, MODEL_ID, PERSONA_HASH, METADATA_URI);
    }

    function test_prepareAdoption_notAPonsLaunch() public {
        vm.prank(bob);
        vm.expectRevert(IPonsMindRegistry.NotPonsLaunch.selector);
        registry.prepareAdoption(makeAddr("random"), MODEL_ID, PERSONA_HASH, METADATA_URI);
    }

    function test_prepareAdoption_nonNativeQuoteRejected() public {
        IPonsV2LaunchFactory.LaunchedToken memory lt = factory.getLaunchedToken(wild);
        lt.pairToken = makeAddr("usdc");
        vm.mockCall(address(factory), abi.encodeCall(IPonsV2LaunchFactory.getLaunchedToken, (wild)), abi.encode(lt));
        vm.prank(bob);
        vm.expectRevert(IPonsMindRegistry.NotPonsLaunch.selector);
        registry.prepareAdoption(wild, MODEL_ID, PERSONA_HASH, METADATA_URI);
    }

    function test_prepareAdoption_recipientReplacesPendingPreparation() public {
        address account = _prepare(bob);
        vm.prank(bob);
        registry.setCreatorPaused(wild, true);
        uint64 createdAt = registry.getMind(wild).createdAt;

        // Bob hands the fee recipient role to Carol without completing the adoption; Carol takes over the stale
        // preparation: creator and config are overwritten, the account is reused, the status is reset to Dormant.
        address carol = makeAddr("carol");
        vm.prank(bob);
        factory.transferCreatorFeeRecipient(wild, carol);
        vm.prank(bob);
        vm.expectRevert(IPonsMindRegistry.NotRecipientOrDeployer.selector);
        registry.prepareAdoption(wild, MODEL_ID, PERSONA_HASH, METADATA_URI);

        bytes32 model = keccak256("claude-sonnet-5");
        vm.warp(block.timestamp + 1 hours);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IMindCore.MindStatusChanged(wild, IMindCore.MindStatus.Dormant);
        vm.expectEmit(true, true, true, true, address(registry));
        emit IPonsMindRegistry.AdoptionPrepared(wild, account, carol);
        vm.prank(carol);
        address again = registry.prepareAdoption(wild, model, bytes32(uint256(7)), "ipfs://carol");

        assertEq(again, account, "account reused");
        assertEq(registry.mindsLength(), 1, "not registered twice");
        IMindCore.MindInfo memory info = registry.getMind(wild);
        assertEq(info.creator, carol);
        assertEq(info.modelId, model);
        assertEq(info.personaHash, bytes32(uint256(7)));
        assertEq(info.metadataURI, "ipfs://carol");
        assertEq(info.createdAt, createdAt, "registration time kept");
        assertEq(uint8(info.status), uint8(IMindCore.MindStatus.Dormant));
        assertFalse(registry.ponsMind(wild).adopted);

        // Bob lost every creator right.
        vm.prank(bob);
        vm.expectRevert(IMindCore.NotCreator.selector);
        registry.setMindConfig(wild, model, bytes32(0), "");

        // Carol can re-prepare her own pending adoption too (config update), then activate it.
        vm.prank(carol);
        registry.prepareAdoption(wild, model, bytes32(uint256(8)), "ipfs://carol2");
        assertEq(registry.getMind(wild).personaHash, bytes32(uint256(8)));
        vm.prank(carol);
        factory.transferCreatorFeeRecipient(wild, account);
        registry.activateAdoption(wild);
        assertTrue(registry.ponsMind(wild).adopted);
        assertEq(uint8(_status(wild)), uint8(IMindCore.MindStatus.Alive));
        assertEq(registry.getMind(wild).creator, carol);
    }

    function test_prepareAdoption_afterActivation_reverts() public {
        address account = _prepare(bob);
        _handOver(account);
        registry.activateAdoption(wild);
        // The recipient is now the account itself.
        vm.prank(account);
        vm.expectRevert(IPonsMindRegistry.AlreadyAdopted.selector);
        registry.prepareAdoption(wild, MODEL_ID, PERSONA_HASH, METADATA_URI);
        // Even after leaving, the new recipient cannot re-prepare an adoption that was activated.
        vm.prank(bob);
        registry.leave(wild, stranger);
        vm.prank(stranger);
        vm.expectRevert(IPonsMindRegistry.AlreadyAdopted.selector);
        registry.prepareAdoption(wild, MODEL_ID, PERSONA_HASH, METADATA_URI);
        assertEq(registry.getMind(wild).creator, bob);
    }

    function test_prepareAdoption_launchedHereToken() public {
        // A token launched through the registry: its recipient is the account (AccountExists if it could call), and
        // no external caller passes the recipient check, not even its creator.
        (address token,, address account) = _launch(creator, 0);
        vm.prank(account);
        vm.expectRevert(IPonsMindRegistry.AccountExists.selector);
        registry.prepareAdoption(token, MODEL_ID, PERSONA_HASH, METADATA_URI);
        vm.prank(creator);
        vm.expectRevert(IPonsMindRegistry.NotRecipientOrDeployer.selector);
        registry.prepareAdoption(token, MODEL_ID, PERSONA_HASH, METADATA_URI);
        // After leaving, the new recipient (the creator) still cannot turn it into an adoption.
        vm.prank(creator);
        registry.leave(token, creator);
        vm.prank(creator);
        vm.expectRevert(IPonsMindRegistry.AccountExists.selector);
        registry.prepareAdoption(token, MODEL_ID, PERSONA_HASH, METADATA_URI);
    }

    function test_prepareAdoption_validation() public {
        vm.startPrank(bob);
        vm.expectRevert(IMindCore.InvalidModel.selector);
        registry.prepareAdoption(wild, bytes32(0), PERSONA_HASH, METADATA_URI);
        vm.expectRevert(IMindCore.MetadataTooLong.selector);
        registry.prepareAdoption(wild, MODEL_ID, PERSONA_HASH, string(new bytes(2049)));
        vm.stopPrank();
    }

    function test_prepareAdoption_tokenLaunchedThroughRouter() public {
        // PonsV2LaunchAndBuy launches for the user with launchTokenFor: the user is the recorded deployer and, with
        // no explicit recipient, the creator fee recipient.
        address router = makeAddr("launchAndBuy");
        vm.deal(router, 1 ether);
        IPonsV2LaunchFactory.TokenParams memory tp;
        tp.name = "Routed";
        tp.symbol = "RTD";
        tp.salt = keccak256("routed");
        address[] memory exemptions = new address[](1);
        exemptions[0] = stranger;
        vm.prank(router);
        vm.expectRevert(MockPonsFactory.NotLaunchForwarder.selector);
        factory.launchTokenFor{value: LAUNCH_FEE}(tp, 0, address(0), alice, exemptions);
        vm.prank(ponsOwner);
        factory.setLaunchForwarder(router);
        vm.prank(router);
        (address token, address curve) = factory.launchTokenFor{value: LAUNCH_FEE}(tp, 0, address(0), alice, exemptions);
        IPonsV2LaunchFactory.LaunchedToken memory lt = factory.getLaunchedToken(token);
        assertEq(lt.deployer, alice);
        assertEq(lt.creatorFeeRecipient, alice);
        assertTrue(MockPonsCurve(curve).snipeTaxExempt(alice));
        assertTrue(MockPonsCurve(curve).snipeTaxExempt(stranger));
        assertFalse(MockPonsCurve(curve).snipeTaxExempt(router));

        vm.prank(alice);
        address account = registry.prepareAdoption(token, MODEL_ID, PERSONA_HASH, METADATA_URI);
        vm.prank(alice);
        factory.transferCreatorFeeRecipient(token, account);
        registry.activateAdoption(token);
        assertTrue(registry.ponsMind(token).adopted);
    }

    // ---------------------------------------------------------------------------------------------
    // activateAdoption
    // ---------------------------------------------------------------------------------------------

    function test_activateAdoption_beforeHandOver_reverts() public {
        _prepare(bob);
        vm.prank(stranger);
        vm.expectRevert(IPonsMindRegistry.AdoptionNotReady.selector);
        registry.activateAdoption(wild);
        // Handing the role to someone else does not count either.
        vm.prank(bob);
        factory.transferCreatorFeeRecipient(wild, stranger);
        vm.expectRevert(IPonsMindRegistry.AdoptionNotReady.selector);
        registry.activateAdoption(wild);
    }

    function test_activateAdoption_fullFlow() public {
        address account = _prepare(bob);
        _handOver(account);
        assertEq(MockPonsCurve(wildCurve).deployer(), account, "curve now pays the account");

        vm.expectEmit(true, false, false, true, address(registry));
        emit IMindCore.MindStatusChanged(wild, IMindCore.MindStatus.Alive);
        vm.expectEmit(true, true, false, true, address(registry));
        emit IPonsMindRegistry.MindAdopted(wild, account);
        vm.prank(stranger);
        registry.activateAdoption(wild);

        assertTrue(registry.ponsMind(wild).adopted);
        assertEq(uint8(_status(wild)), uint8(IMindCore.MindStatus.Alive));

        vm.expectRevert(IPonsMindRegistry.AlreadyAdopted.selector);
        registry.activateAdoption(wild);

        // From now on creator fees reach the vault through harvest.
        _buy(stranger, wildCurve, 1 ether);
        uint256 share = _pendingCreatorShare(wildCurve);
        assertGt(share, 0);
        _harvest(wild);
        assertEq(registry.mindBalance(wild), share);
        _assertSolvent();
    }

    function test_activateAdoption_keepsCreatorPause() public {
        address account = _prepare(bob);
        vm.prank(bob);
        registry.setCreatorPaused(wild, true);
        _handOver(account);
        registry.activateAdoption(wild);
        assertEq(uint8(_status(wild)), uint8(IMindCore.MindStatus.Paused));
        assertTrue(registry.ponsMind(wild).adopted);
    }

    function test_activateAdoption_launchedHereOrUnknown() public {
        (address token,,) = _launch(creator, 0);
        vm.expectRevert(IPonsMindRegistry.AlreadyAdopted.selector);
        registry.activateAdoption(token);
        vm.expectRevert(IMindCore.NotAMind.selector);
        registry.activateAdoption(makeAddr("random"));
    }

    function test_adoption_afterGraduation_poolFeesFlow() public {
        // The coin graduates and its pool is created while Bob is still the recipient.
        _graduate(stranger, wildCurve);
        factory.createGraduatedPool(wild);
        bytes32 poolId = factory.poolIdFor(wild);
        (,,, address poolCreator,,,,,) = hook.launches(poolId);
        assertEq(poolCreator, bob);

        address account = _prepare(bob);
        _handOver(account);
        (,,, poolCreator,,,,,) = hook.launches(poolId);
        assertEq(poolCreator, account, "hook follows the factory hand-off after graduation");
        registry.activateAdoption(wild);

        vm.prank(operator);
        registry.setPoolId(wild, poolId);
        hook.simulateSwapFees{value: 1 ether}(poolId, 0.1 ether);
        uint256 creatorShare = 0.9 ether - 0.9 ether * PROTOCOL_SHARE_BPS / 10_000 + 0.1 ether;
        _harvest(wild);
        assertEq(registry.mindBalance(wild), creatorShare);
        _assertSolvent();
    }

    // ---------------------------------------------------------------------------------------------
    // leave
    // ---------------------------------------------------------------------------------------------

    function test_leave_adoptedMind() public {
        address account = _prepare(bob);
        _handOver(account);
        registry.activateAdoption(wild);
        vm.prank(alice);
        registry.fundMind{value: 1 ether}(wild);

        vm.prank(stranger);
        vm.expectRevert(IMindCore.NotCreator.selector);
        registry.leave(wild, stranger);

        vm.expectEmit(true, false, false, true, address(registry));
        emit IMindCore.MindStatusChanged(wild, IMindCore.MindStatus.Dormant);
        vm.expectEmit(true, true, true, true, address(factory));
        emit IPonsV2LaunchFactory.CreatorFeeRecipientUpdated(wild, account, bob);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IPonsMindRegistry.MindLeft(wild, bob);
        vm.prank(bob);
        registry.leave(wild, bob);

        assertEq(factory.getLaunchedToken(wild).creatorFeeRecipient, bob);
        assertEq(MockPonsCurve(wildCurve).deployer(), bob);
        assertEq(uint8(_status(wild)), uint8(IMindCore.MindStatus.Dormant));

        // The vault keeps its balance and stays usable.
        assertEq(registry.mindBalance(wild), 1 ether);
        vm.prank(operator);
        registry.drawCompute(wild, 0.2 ether, keccak256("r"));
        vm.prank(alice);
        registry.fundMind{value: 0.5 ether}(wild);
        assertEq(registry.mindBalance(wild), 1.3 ether);
        _assertSolvent();
    }

    function test_leave_launchedMind_thenHarvestClaimsWhatWasCredited() public {
        (address token, address curve, address account) = _launch(creator, 1 ether);
        // Pons' operator sweeps while the account is still the recipient.
        uint256 share = _pendingCreatorShare(curve);
        vm.prank(ponsOperator);
        MockPonsCurve(curve).sweepFees(0);
        assertEq(escrow.balanceOf(account), share);

        vm.prank(creator);
        registry.leave(token, creator);
        assertEq(uint8(_status(token)), uint8(IMindCore.MindStatus.Dormant));

        // New trades now pay the creator directly; the account's escrow balance is still harvestable.
        _buy(stranger, curve, 1 ether);
        uint256 later = _pendingCreatorShare(curve);
        _harvest(token);
        assertEq(registry.mindBalance(token), share, "only fees credited before leaving");
        assertEq(MockPonsCurve(curve).quoteFeeBalance() + MockPonsCurve(curve).creatorTaxBalance() > 0, true);
        vm.prank(creator);
        MockPonsCurve(curve).sweepFees(0);
        assertEq(escrow.balanceOf(creator), later, "the new recipient sweeps its own fees");
        _assertSolvent();
    }

    function test_leave_fromPausedSetsDormant() public {
        (address token,,) = _launch(creator, 0);
        vm.startPrank(creator);
        registry.setCreatorPaused(token, true);
        registry.leave(token, creator);
        vm.stopPrank();
        assertEq(uint8(_status(token)), uint8(IMindCore.MindStatus.Dormant));
        // No status event when already Dormant.
        (address token2,,) = _launchWith(alice, _params(keccak256("2")), 0, 0);
        vm.prank(operator);
        registry.setMindStatus(token2, IMindCore.MindStatus.Dormant);
        vm.recordLogs();
        vm.prank(alice);
        registry.leave(token2, alice);
        assertEq(vm.getRecordedLogs().length, 3, "CreatorFeeRecipientUpdated (curve + factory) and MindLeft only");
    }

    function test_leave_guards() public {
        // Prepared but not handed over: the account is not the recipient, Pons refuses.
        _prepare(bob);
        vm.prank(bob);
        vm.expectRevert(MockPonsFactory.NotCreatorFeeRecipient.selector);
        registry.leave(wild, bob);

        (address token,,) = _launch(creator, 0);
        vm.prank(creator);
        vm.expectRevert(MockPonsFactory.ZeroAddress.selector);
        registry.leave(token, address(0));
        vm.expectRevert(IMindCore.NotCreator.selector);
        registry.leave(makeAddr("random"), creator);
    }

    function test_leave_afterGraduation_movesPoolRecipient() public {
        (address token, address curve, address account) = _launch(creator, 0);
        _graduate(stranger, curve);
        registry.createGraduatedPool(token);
        bytes32 poolId = factory.poolIdFor(token);
        (,,, address poolCreator,,,,,) = hook.launches(poolId);
        assertEq(poolCreator, account);
        vm.prank(creator);
        registry.leave(token, creator);
        (,,, poolCreator,,,,,) = hook.launches(poolId);
        assertEq(poolCreator, creator);
        assertEq(uint8(_phase(token)), uint8(IPonsV2LaunchFactory.GraduationPhase.PoolCreated));
        // The account can no longer sweep the pool: harvest records the failed attempt and still succeeds.
        vm.prank(operator);
        registry.setPoolId(token, poolId);
        hook.simulateSwapFees{value: 0.5 ether}(poolId, 0);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IPonsMindRegistry.SweepAttempted(token, false, false);
        _harvest(token);
        assertEq(hook.pendingFees(poolId), 0.5 ether);
        vm.prank(creator);
        hook.sweepPoolFees(poolId, 0, 0);
        assertEq(hook.pendingFees(poolId), 0);
    }
}
