// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {MindAccount} from "../src/MindAccount.sol";
import {IMindCore} from "../src/interfaces/IMindCore.sol";
import {IPonsMindRegistry} from "../src/interfaces/IPonsMindRegistry.sol";
import {IPonsV2LaunchFactory} from "../src/interfaces/pons/IPonsV2LaunchFactory.sol";
import {MockPonsCurve} from "./mocks/pons/MockPonsCurve.sol";
import {MockPonsFactory} from "./mocks/pons/MockPonsFactory.sol";
import {PonsBaseTest} from "./utils/PonsBaseTest.sol";

/// @notice SPEC §9.7 adoption v2 (per-preparer prepareAdoption -> transferCreatorFeeRecipient -> activateAdoption,
///         registration at activation, takeovers), leave (recipient validation, harvest first, left state) and
///         recoverAccountTokens.
contract PonsMindRegistryAdoptionTest is PonsBaseTest {
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

    function _overrideRecipient(address token, address to) internal {
        vm.prank(ponsOwner);
        factory.setCreatorFeeRecipient(token, to);
        vm.warp(block.timestamp + factory.CREATOR_FEE_RECIPIENT_TIMELOCK());
        factory.executeCreatorFeeRecipientChange(token);
    }

    // ---------------------------------------------------------------------------------------------
    // prepareAdoption
    // ---------------------------------------------------------------------------------------------

    function test_prepareAdoption_anyoneMayPrepare_nothingRegistered() public {
        address predicted = registry.predictAdoptionAccount(wild, bob);
        assertEq(predicted.code.length, 0);
        vm.expectEmit(true, true, true, true, address(registry));
        emit IPonsMindRegistry.AdoptionPrepared(wild, predicted, bob);
        address account = _prepareAdoption(wild, bob);

        assertEq(account, predicted);
        assertGt(account.code.length, 0, "account deployed");
        assertEq(MindAccount(payable(account)).registry(), address(registry));
        assertFalse(registry.isMind(wild), "nothing registered before activation");
        assertEq(registry.mindsLength(), 0);
        assertEq(registry.accountOf(wild), address(0));
        assertEq(registry.tokenOf(account), address(0), "pending accounts map to no token");
        (address a, bytes32 model, bytes32 persona, string memory uri) = registry.pendingAdoption(wild, bob);
        assertEq(a, account);
        assertEq(model, MODEL_ID);
        assertEq(persona, PERSONA_HASH);
        assertEq(uri, METADATA_URI);
        assertEq(factory.getLaunchedToken(wild).creatorFeeRecipient, bob, "nothing moved on Pons");

        // Anyone may prepare (the deployer, a stranger): each preparer gets its own account.
        address aliceAccount = _prepareAdoption(wild, alice);
        address strangerAccount = _prepareAdoption(wild, stranger);
        assertEq(aliceAccount, registry.predictAdoptionAccount(wild, alice));
        assertEq(strangerAccount, registry.predictAdoptionAccount(wild, stranger));
        assertTrue(aliceAccount != account && strangerAccount != account && aliceAccount != strangerAccount);
        assertFalse(registry.isMind(wild));

        // A pending adoption confers no creator rights and the token has no vault yet.
        vm.prank(bob);
        vm.expectRevert(IMindCore.NotCreator.selector);
        registry.setCreatorPaused(wild, true);
        vm.prank(bob);
        vm.expectRevert(IMindCore.NotAMind.selector);
        registry.fundMind{value: 1 ether}(wild);
        vm.expectRevert(IMindCore.NotAMind.selector);
        registry.harvest(wild);
        assertEq(registry.claimable(wild), 0);
    }

    function test_prepareAdoption_repeatUpdatesPendingConfig_reusesAccount() public {
        address account = _prepareAdoption(wild, bob);
        bytes32 model = keccak256("claude-sonnet-5");
        vm.recordLogs();
        vm.prank(bob);
        address again = registry.prepareAdoption(wild, model, bytes32(uint256(7)), "ipfs://bob2");
        assertEq(again, account, "account reused");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "AdoptionPrepared only (no new clone)");
        assertEq(logs[0].topics[0], IPonsMindRegistry.AdoptionPrepared.selector);
        (address a, bytes32 m, bytes32 persona, string memory uri) = registry.pendingAdoption(wild, bob);
        assertEq(a, account);
        assertEq(m, model);
        assertEq(persona, bytes32(uint256(7)));
        assertEq(uri, "ipfs://bob2");
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

    function test_prepareAdoption_buybackLaunchRejected() public {
        (address bb,) = _launchDirect(alice, alice, keccak256("bb"), true);
        vm.prank(alice);
        vm.expectRevert(IPonsMindRegistry.BuybackEnabledLaunch.selector);
        registry.prepareAdoption(bb, MODEL_ID, PERSONA_HASH, METADATA_URI);
        // Buyback enabled later by the recipient is rejected too.
        vm.prank(bob);
        factory.setBuybackEnabled(wild, true);
        vm.prank(stranger);
        vm.expectRevert(IPonsMindRegistry.BuybackEnabledLaunch.selector);
        registry.prepareAdoption(wild, MODEL_ID, PERSONA_HASH, METADATA_URI);
    }

    function test_prepareAdoption_validation() public {
        vm.startPrank(bob);
        vm.expectRevert(IMindCore.InvalidModel.selector);
        registry.prepareAdoption(wild, bytes32(0), PERSONA_HASH, METADATA_URI);
        vm.expectRevert(IMindCore.MetadataTooLong.selector);
        registry.prepareAdoption(wild, MODEL_ID, PERSONA_HASH, string(new bytes(2049)));
        registry.prepareAdoption(wild, MODEL_ID, bytes32(0), string(new bytes(2048)));
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

        address account = _adopt(token, alice);
        assertTrue(registry.ponsMind(token).adopted);
        assertEq(registry.getMind(token).creator, alice);
        assertEq(registry.accountOf(token), account);
    }

    function test_predictAdoptionAccount_boundToTokenAndPreparer() public {
        bytes32 salt = keccak256(abi.encode(wild, bob));
        address expected = Clones.predictDeterministicAddress(registry.accountImplementation(), salt, address(registry));
        assertEq(registry.predictAdoptionAccount(wild, bob), expected);
        assertTrue(registry.predictAdoptionAccount(wild, carol) != expected);
        (address other,) = _launchDirect(alice, bob, keccak256("other"), false);
        assertTrue(registry.predictAdoptionAccount(other, bob) != expected);
        assertTrue(registry.predictAccount(bob, salt) != expected, "launch and adoption salts differ");
    }

    // ---------------------------------------------------------------------------------------------
    // activateAdoption: first registration
    // ---------------------------------------------------------------------------------------------

    function test_activateAdoption_registersMind() public {
        address account = _prepareAdoption(wild, bob);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(bob);
        factory.transferCreatorFeeRecipient(wild, account);
        assertEq(MockPonsCurve(wildCurve).deployer(), account, "curve now pays the account");

        vm.recordLogs();
        vm.expectEmit(true, true, false, true, address(registry));
        emit IMindCore.MindCreated(wild, bob, "Wild Coin", "WILD", METADATA_URI, MODEL_ID, PERSONA_HASH);
        vm.expectEmit(true, true, true, true, address(registry));
        emit IPonsMindRegistry.MindAdopted(wild, account, bob);
        vm.prank(stranger);
        registry.activateAdoption(wild, bob);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 registryLogs;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(registry)) registryLogs++;
        }
        assertEq(registryLogs, 2, "MindCreated + MindAdopted only");

        assertTrue(registry.isMind(wild));
        assertEq(registry.mindsLength(), 1);
        assertEq(registry.mindAt(0), wild);
        IMindCore.MindInfo memory info = registry.getMind(wild);
        assertEq(info.creator, bob);
        assertEq(info.modelId, MODEL_ID);
        assertEq(info.personaHash, PERSONA_HASH);
        assertEq(info.metadataURI, METADATA_URI);
        assertEq(info.createdAt, block.timestamp, "registered at activation");
        assertEq(uint8(info.status), uint8(IMindCore.MindStatus.Alive));
        IPonsMindRegistry.PonsMind memory m = registry.ponsMind(wild);
        assertEq(m.curve, wildCurve);
        assertEq(m.account, account);
        assertEq(m.launchConfigId, 0);
        assertFalse(m.launchedHere);
        assertTrue(m.adopted);
        assertEq(registry.accountOf(wild), account);
        assertEq(registry.tokenOf(account), wild);
        assertFalse(registry.hasLeft(wild));
        (address pendingAccount,,, string memory pendingUri) = registry.pendingAdoption(wild, bob);
        assertEq(pendingAccount, address(0), "pending record consumed");
        assertEq(bytes(pendingUri).length, 0);

        // From now on creator fees reach the vault through harvest.
        _buy(stranger, wildCurve, 1 ether);
        uint256 share = _pendingCreatorShare(wildCurve);
        assertGt(share, 0);
        _harvest(wild);
        assertEq(registry.mindBalance(wild), share);
        _assertSolvent();
    }

    function test_activateAdoption_notReady() public {
        // No pending adoption for the preparer, or an unknown token.
        vm.expectRevert(IPonsMindRegistry.AdoptionNotReady.selector);
        registry.activateAdoption(wild, bob);
        vm.expectRevert(IPonsMindRegistry.AdoptionNotReady.selector);
        registry.activateAdoption(makeAddr("random"), bob);

        address account = _prepareAdoption(wild, bob);
        // Pending, but the creator fees were not handed over.
        vm.expectRevert(IPonsMindRegistry.AdoptionNotReady.selector);
        registry.activateAdoption(wild, bob);
        // Handed to someone else.
        vm.prank(bob);
        factory.transferCreatorFeeRecipient(wild, stranger);
        vm.expectRevert(IPonsMindRegistry.AdoptionNotReady.selector);
        registry.activateAdoption(wild, bob);
        // Handed to Bob's account: only Bob's preparation activates.
        vm.prank(stranger);
        factory.transferCreatorFeeRecipient(wild, account);
        _prepareAdoption(wild, carol);
        vm.expectRevert(IPonsMindRegistry.AdoptionNotReady.selector);
        registry.activateAdoption(wild, carol);
        registry.activateAdoption(wild, bob);
        assertEq(registry.getMind(wild).creator, bob);
    }

    /// @dev Audit M-1 regression: the creator is whoever's account received the stream, never a stale preparer.
    function test_activateAdoption_creatorIsTheOwnerOfTheReceivingAccount() public {
        address bobAccount = _prepareAdoption(wild, bob);
        vm.prank(bob);
        factory.transferCreatorFeeRecipient(wild, carol); // OTC sale of the fee stream

        // Carol prepares after buying the stream and hands it to her own account.
        address carolAccount = _prepareAdoption(wild, carol);
        vm.prank(carol);
        factory.transferCreatorFeeRecipient(wild, carolAccount);
        vm.expectRevert(IPonsMindRegistry.AdoptionNotReady.selector);
        registry.activateAdoption(wild, bob);
        registry.activateAdoption(wild, carol);
        assertEq(registry.getMind(wild).creator, carol);
        assertEq(registry.accountOf(wild), carolAccount);

        vm.prank(bob);
        vm.expectRevert(IMindCore.NotCreator.selector);
        registry.leave(wild, bob);
        // Bob's stale preparation stays pending but cannot activate while Carol's account is the recipient.
        (address pendingAccount,,,) = registry.pendingAdoption(wild, bob);
        assertEq(pendingAccount, bobAccount);
        vm.expectRevert(IPonsMindRegistry.AdoptionNotReady.selector);
        registry.activateAdoption(wild, bob);
        assertEq(factory.getLaunchedToken(wild).creatorFeeRecipient, carolAccount);
    }

    function test_activateAdoption_alreadyAdopted() public {
        address account = _adopt(wild, bob);
        vm.expectRevert(IPonsMindRegistry.AdoptionNotReady.selector);
        registry.activateAdoption(wild, bob);
        // Re-preparing reuses the account, which is still the recipient: nothing to take over.
        assertEq(_prepareAdoption(wild, bob), account);
        vm.expectRevert(IPonsMindRegistry.AlreadyAdopted.selector);
        registry.activateAdoption(wild, bob);
    }

    function test_activateAdoption_notPausable() public {
        address account = _prepareAdoption(wild, bob);
        _handOver(wild, account);
        vm.prank(owner);
        registry.pause();
        registry.activateAdoption(wild, bob);
        assertTrue(registry.isMind(wild));
    }

    function test_activateAdoption_unreadableNameSymbol() public {
        address account = _prepareAdoption(wild, bob);
        _handOver(wild, account);
        vm.mockCallRevert(wild, abi.encodeWithSelector(IERC20Metadata.name.selector), "");
        vm.mockCallRevert(wild, abi.encodeWithSelector(IERC20Metadata.symbol.selector), "");
        vm.expectEmit(true, true, false, true, address(registry));
        emit IMindCore.MindCreated(wild, bob, "", "", METADATA_URI, MODEL_ID, PERSONA_HASH);
        registry.activateAdoption(wild, bob);
        assertTrue(registry.ponsMind(wild).adopted);
    }

    function test_adoption_afterGraduation_poolFeesFlow() public {
        // The coin graduates and its pool is created while Bob is still the recipient.
        _graduate(stranger, wildCurve);
        factory.createGraduatedPool(wild);
        bytes32 poolId = factory.poolIdFor(wild);
        (,,, address poolCreator,,,,,) = hook.launches(poolId);
        assertEq(poolCreator, bob);

        address account = _adopt(wild, bob);
        (,,, poolCreator,,,,,) = hook.launches(poolId);
        assertEq(poolCreator, account, "hook follows the factory hand-off after graduation");
        assertEq(registry.derivedPoolId(wild), poolId);

        // No setPoolId needed: harvest sweeps the derived pool id.
        hook.simulateSwapFees{value: 1 ether}(poolId, 0.1 ether);
        uint256 creatorShare = 0.9 ether - 0.9 ether * PROTOCOL_SHARE_BPS / 10_000 + 0.1 ether;
        vm.expectEmit(true, false, false, true, address(registry));
        emit IPonsMindRegistry.SweepAttempted(wild, false, true);
        _harvest(wild);
        assertEq(registry.mindBalance(wild), creatorShare);
        _assertSolvent();
    }

    // ---------------------------------------------------------------------------------------------
    // activateAdoption: takeovers
    // ---------------------------------------------------------------------------------------------

    function test_takeover_afterLeave_adoptedMind() public {
        address bobAccount = _adopt(wild, bob);
        vm.prank(alice);
        registry.fundMind{value: 1 ether}(wild);
        uint64 createdAt = registry.getMind(wild).createdAt;
        vm.prank(bob);
        registry.leave(wild, carol); // Bob sells the stream to Carol
        assertTrue(registry.hasLeft(wild));
        assertEq(uint8(_status(wild)), uint8(IMindCore.MindStatus.Dormant));

        vm.warp(block.timestamp + 1 days);
        bytes32 model = keccak256("claude-sonnet-5");
        vm.prank(carol);
        address carolAccount = registry.prepareAdoption(wild, model, bytes32(uint256(9)), "ipfs://carol");
        vm.prank(carol);
        factory.transferCreatorFeeRecipient(wild, carolAccount);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IMindCore.MindConfigUpdated(wild, model, bytes32(uint256(9)), "ipfs://carol");
        vm.expectEmit(true, false, false, true, address(registry));
        emit IMindCore.MindStatusChanged(wild, IMindCore.MindStatus.Alive);
        vm.expectEmit(true, true, true, true, address(registry));
        emit IPonsMindRegistry.MindAdopted(wild, carolAccount, carol);
        vm.prank(stranger);
        registry.activateAdoption(wild, carol);

        IMindCore.MindInfo memory info = registry.getMind(wild);
        assertEq(info.creator, carol);
        assertEq(info.modelId, model);
        assertEq(info.personaHash, bytes32(uint256(9)));
        assertEq(info.metadataURI, "ipfs://carol");
        assertEq(info.createdAt, createdAt, "registration time kept");
        assertEq(uint8(info.status), uint8(IMindCore.MindStatus.Alive));
        IPonsMindRegistry.PonsMind memory m = registry.ponsMind(wild);
        assertEq(m.account, carolAccount);
        assertEq(m.curve, wildCurve);
        assertTrue(m.adopted);
        assertFalse(m.launchedHere);
        assertEq(registry.tokenOf(carolAccount), wild);
        assertEq(registry.tokenOf(bobAccount), address(0), "old account unmapped");
        assertFalse(registry.hasLeft(wild));
        assertEq(registry.mindsLength(), 1, "same mind");
        assertEq(registry.mindBalance(wild), 1 ether, "vault kept");

        // Bob lost every creator right; Carol has them.
        vm.startPrank(bob);
        vm.expectRevert(IMindCore.NotCreator.selector);
        registry.setMindConfig(wild, model, bytes32(0), "");
        vm.expectRevert(IMindCore.NotCreator.selector);
        registry.leave(wild, bob);
        vm.stopPrank();
        vm.prank(carol);
        registry.setMindConfig(wild, model, bytes32(uint256(10)), "");

        // New fees reach the vault through Carol's account.
        _buy(stranger, wildCurve, 1 ether);
        uint256 share = _pendingCreatorShare(wildCurve);
        _harvest(wild);
        assertEq(registry.mindBalance(wild), 1 ether + share);
        _assertSolvent();
    }

    function test_takeover_launchedHereMind() public {
        (address token, address curve, address account) = _launch(creator, 0);
        vm.prank(operator);
        registry.setPoolId(token, bytes32(uint256(1)));
        vm.prank(creator);
        registry.leave(token, alice);

        address aliceAccount = _adopt(token, alice);
        IPonsMindRegistry.PonsMind memory m = registry.ponsMind(token);
        assertTrue(m.launchedHere, "launch origin kept");
        assertTrue(m.adopted);
        assertEq(m.curve, curve);
        assertEq(m.account, aliceAccount);
        assertEq(registry.getMind(token).creator, alice);
        assertEq(uint8(_status(token)), uint8(IMindCore.MindStatus.Alive));
        assertEq(registry.tokenOf(account), address(0));
        assertEq(registry.tokenOf(aliceAccount), token);
        assertEq(registry.poolIdOf(token), bytes32(uint256(1)), "operator override kept");
        assertEq(factory.getLaunchedToken(token).deployer, address(registry));

        // The original creator can come back the same way once Alice leaves.
        vm.prank(alice);
        registry.leave(token, creator);
        address creatorAccount = _adopt(token, creator);
        assertEq(registry.getMind(token).creator, creator);
        assertEq(registry.accountOf(token), creatorAccount);
        assertTrue(creatorAccount != account, "adoption account, not the launch account");
    }

    function test_takeover_afterPonsOverride_claimsWhatThePreviousAccountEarned() public {
        address bobAccount = _adopt(wild, bob);
        _buy(stranger, wildCurve, 1 ether);
        uint256 share = _pendingCreatorShare(wildCurve);
        vm.prank(ponsOperator);
        MockPonsCurve(wildCurve).sweepFees(0); // credited to Bob's account, not harvested yet
        assertEq(escrow.balanceOf(bobAccount), share);

        // Pons' owner moves the recipient (e.g. lost-key recovery) to Carol; the registry is not involved.
        _overrideRecipient(wild, carol);
        assertFalse(registry.hasLeft(wild));
        assertEq(uint8(_status(wild)), uint8(IMindCore.MindStatus.Alive));
        // Bob cannot leave any more: Pons refuses, the account is no longer the recipient.
        vm.prank(bob);
        vm.expectRevert(MockPonsFactory.NotCreatorFeeRecipient.selector);
        registry.leave(wild, bob);

        address carolAccount = _prepareAdoption(wild, carol);
        vm.prank(carol);
        factory.transferCreatorFeeRecipient(wild, carolAccount);
        vm.expectEmit(true, true, false, true, address(registry));
        emit IMindCore.MindFunded(wild, bobAccount, share);
        vm.expectEmit(true, true, true, true, address(registry));
        emit IPonsMindRegistry.MindAdopted(wild, carolAccount, carol);
        registry.activateAdoption(wild, carol);

        assertEq(registry.mindBalance(wild), share, "previous account's earnings kept in the vault");
        assertEq(escrow.balanceOf(bobAccount), 0);
        assertEq(registry.getMind(wild).creator, carol);
        assertEq(registry.accountOf(wild), carolAccount);
        _assertSolvent();
    }

    function test_takeover_sameAccountAfterLeave_reactivates() public {
        address account = _adopt(wild, bob);
        vm.prank(bob);
        registry.leave(wild, bob);

        // Bob comes back with a new config: his account is reused, the stream returns to it, activation re-activates.
        bytes32 model = keccak256("claude-haiku-5");
        vm.prank(bob);
        address again = registry.prepareAdoption(wild, model, bytes32(uint256(3)), "ipfs://back");
        assertEq(again, account);
        vm.prank(bob);
        factory.transferCreatorFeeRecipient(wild, account);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IMindCore.MindConfigUpdated(wild, model, bytes32(uint256(3)), "ipfs://back");
        vm.expectEmit(true, false, false, true, address(registry));
        emit IMindCore.MindStatusChanged(wild, IMindCore.MindStatus.Alive);
        vm.expectEmit(true, true, true, true, address(registry));
        emit IPonsMindRegistry.MindAdopted(wild, account, bob);
        registry.activateAdoption(wild, bob);

        assertFalse(registry.hasLeft(wild));
        assertEq(uint8(_status(wild)), uint8(IMindCore.MindStatus.Alive));
        assertEq(registry.getMind(wild).modelId, model);
        assertEq(registry.accountOf(wild), account);
        assertEq(registry.tokenOf(account), wild);
    }

    function test_takeover_streamBackWithoutLeave_alreadyAdopted() public {
        address account = _adopt(wild, bob);
        _overrideRecipient(wild, carol);
        // Carol returns the stream to the mind's account: the mind is whole again, nothing to take over.
        vm.prank(carol);
        factory.transferCreatorFeeRecipient(wild, account);
        _prepareAdoption(wild, bob);
        vm.expectRevert(IPonsMindRegistry.AlreadyAdopted.selector);
        registry.activateAdoption(wild, bob);
        assertEq(registry.getMind(wild).creator, bob);
    }

    // ---------------------------------------------------------------------------------------------
    // leave
    // ---------------------------------------------------------------------------------------------

    function test_leave_adoptedMind() public {
        address account = _adopt(wild, bob);
        vm.prank(alice);
        registry.fundMind{value: 1 ether}(wild);

        vm.prank(stranger);
        vm.expectRevert(IMindCore.NotCreator.selector);
        registry.leave(wild, stranger);

        vm.expectEmit(true, true, true, true, address(factory));
        emit IPonsV2LaunchFactory.CreatorFeeRecipientUpdated(wild, account, bob);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IMindCore.MindStatusChanged(wild, IMindCore.MindStatus.Dormant);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IPonsMindRegistry.MindLeft(wild, bob);
        vm.prank(bob);
        registry.leave(wild, bob);

        assertEq(factory.getLaunchedToken(wild).creatorFeeRecipient, bob);
        assertEq(MockPonsCurve(wildCurve).deployer(), bob);
        assertEq(uint8(_status(wild)), uint8(IMindCore.MindStatus.Dormant));
        assertTrue(registry.hasLeft(wild));
        assertEq(registry.accountOf(wild), account, "the mind keeps its account until a takeover");
        assertEq(registry.tokenOf(account), wild);
        assertEq(registry.getMind(wild).creator, bob);

        // The vault keeps its balance and stays usable.
        assertEq(registry.mindBalance(wild), 1 ether);
        vm.prank(operator);
        registry.drawCompute(wild, 0.2 ether, keccak256("r"));
        vm.prank(alice);
        registry.fundMind{value: 0.5 ether}(wild);
        assertEq(registry.mindBalance(wild), 1.3 ether);
        _assertSolvent();
    }

    /// @dev Audit L-2 regression: fees earned while the account was the recipient reach the vault, with the mind fee.
    function test_leave_harvestsFirst() public {
        (address token, address curve, address account) = _launch(creator, 0);
        vm.warp(block.timestamp + 1 minutes);
        _buy(stranger, curve, 2 ether);
        vm.prank(owner);
        registry.setMindFeeBps(1000);
        uint256 earned = _pendingCreatorShare(curve);
        uint256 cut = earned * 1000 / 10_000;
        assertGt(earned, 0);

        vm.expectEmit(true, false, false, true, address(registry));
        emit IPonsMindRegistry.SweepAttempted(token, true, false);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IMindCore.FeeAccrued(token, 0, cut);
        vm.expectEmit(true, true, false, true, address(registry));
        emit IMindCore.MindFunded(token, account, earned - cut);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IMindCore.Harvested(token, earned - cut, 0);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IPonsMindRegistry.MindLeft(token, creator);
        vm.prank(creator);
        registry.leave(token, creator);

        assertEq(registry.mindBalance(token), earned - cut, "vault");
        assertEq(registry.protocolBalance(), cut, "mindFeeBps not bypassed");
        assertEq(escrow.balanceOf(account), 0);
        assertEq(escrow.balanceOf(creator), 0, "nothing earned by the mind went to the new recipient");
        assertEq(registry.claimable(token), 0);

        // Later trades pay the new recipient directly; the vault is untouched.
        _buy(stranger, curve, 1 ether);
        uint256 later = _pendingCreatorShare(curve);
        vm.prank(creator);
        MockPonsCurve(curve).sweepFees(0);
        assertEq(escrow.balanceOf(creator), later);
        _harvest(token);
        assertEq(registry.mindBalance(token), earned - cut);
        _assertSolvent();
    }

    function test_leave_claimsWhatPonsAlreadyCredited() public {
        (address token, address curve, address account) = _launch(creator, 1 ether);
        // Pons' operator sweeps while the account is still the recipient.
        uint256 share = _pendingCreatorShare(curve);
        vm.prank(ponsOperator);
        MockPonsCurve(curve).sweepFees(0);
        assertEq(escrow.balanceOf(account), share);
        vm.prank(creator);
        registry.leave(token, creator);
        assertEq(registry.mindBalance(token), share);
        assertEq(escrow.balanceOf(account), 0);
        _assertSolvent();
    }

    /// @dev Audit L-3 regression: the stream can never be handed to a recipient nobody can move it away from.
    function test_leave_invalidRecipient() public {
        (address token,, address account) = _launch(creator, 0);
        (,, address account2) = _launchWith(alice, _params(keccak256("2")), 0, 0);
        address pendingAccount = _prepareAdoption(wild, bob);

        vm.startPrank(creator);
        vm.expectRevert(IPonsMindRegistry.InvalidRecipient.selector);
        registry.leave(token, address(0));
        vm.expectRevert(IPonsMindRegistry.InvalidRecipient.selector);
        registry.leave(token, address(registry));
        vm.expectRevert(IPonsMindRegistry.InvalidRecipient.selector);
        registry.leave(token, account);
        vm.expectRevert(IPonsMindRegistry.InvalidRecipient.selector);
        registry.leave(token, account2);
        vm.expectRevert(IPonsMindRegistry.InvalidRecipient.selector);
        registry.leave(token, pendingAccount);
        vm.stopPrank();

        // A superseded account stays rejected after a takeover.
        vm.prank(creator);
        registry.leave(token, alice);
        _adopt(token, alice);
        vm.prank(alice);
        vm.expectRevert(IPonsMindRegistry.InvalidRecipient.selector);
        registry.leave(token, account);

        // The creator check comes first.
        vm.prank(stranger);
        vm.expectRevert(IMindCore.NotCreator.selector);
        registry.leave(token, address(0));
    }

    function test_leave_statusRulesWhileLeft() public {
        (address token,,) = _launch(creator, 0);
        vm.prank(creator);
        registry.leave(token, creator);
        assertEq(uint8(_status(token)), uint8(IMindCore.MindStatus.Dormant));

        vm.startPrank(operator);
        vm.expectRevert(IMindCore.InvalidStatus.selector);
        registry.setMindStatus(token, IMindCore.MindStatus.Alive);
        registry.setMindStatus(token, IMindCore.MindStatus.Dormant); // no-op
        vm.stopPrank();

        vm.startPrank(creator);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IMindCore.MindStatusChanged(token, IMindCore.MindStatus.Paused);
        registry.setCreatorPaused(token, true);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IMindCore.MindStatusChanged(token, IMindCore.MindStatus.Dormant);
        registry.setCreatorPaused(token, false);
        assertEq(uint8(_status(token)), uint8(IMindCore.MindStatus.Dormant), "unpause restores Dormant while left");
        vm.recordLogs();
        registry.setCreatorPaused(token, false);
        assertEq(vm.getRecordedLogs().length, 0, "no-op");
        vm.stopPrank();

        // A takeover clears the flag: Alive again and the operator toggles as usual.
        _adopt(token, alice);
        assertFalse(registry.hasLeft(token));
        assertEq(uint8(_status(token)), uint8(IMindCore.MindStatus.Alive));
        vm.startPrank(operator);
        registry.setMindStatus(token, IMindCore.MindStatus.Dormant);
        registry.setMindStatus(token, IMindCore.MindStatus.Alive);
        vm.stopPrank();
        vm.startPrank(alice);
        registry.setCreatorPaused(token, true);
        registry.setCreatorPaused(token, false);
        vm.stopPrank();
        assertEq(uint8(_status(token)), uint8(IMindCore.MindStatus.Alive));
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
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != IMindCore.MindStatusChanged.selector, "no MindStatusChanged");
        }
        assertEq(logs[logs.length - 1].topics[0], IPonsMindRegistry.MindLeft.selector);
    }

    function test_leave_guards() public {
        // A pending adoption is not a mind: its preparer has no creator rights.
        _prepareAdoption(wild, bob);
        vm.prank(bob);
        vm.expectRevert(IMindCore.NotCreator.selector);
        registry.leave(wild, bob);
        vm.expectRevert(IMindCore.NotCreator.selector);
        registry.leave(makeAddr("random"), creator);
    }

    function test_leave_afterGraduation_sweepsPoolThenMovesPoolRecipient() public {
        (address token, address curve, address account) = _launch(creator, 0);
        _graduate(stranger, curve);
        registry.createGraduatedPool(token);
        bytes32 poolId = factory.poolIdFor(token);
        (,,, address poolCreator,,,,,) = hook.launches(poolId);
        assertEq(poolCreator, account);
        uint256 graduationCredit = escrow.balanceOf(account);
        hook.simulateSwapFees{value: 0.5 ether}(poolId, 0); // earned while the account is the pool creator

        vm.expectEmit(true, false, false, true, address(registry));
        emit IPonsMindRegistry.SweepAttempted(token, false, true);
        vm.prank(creator);
        registry.leave(token, creator);
        assertEq(registry.mindBalance(token), graduationCredit + 0.35 ether, "pool fees swept before leaving");
        (,,, poolCreator,,,,,) = hook.launches(poolId);
        assertEq(poolCreator, creator);
        assertEq(uint8(_phase(token)), uint8(IPonsV2LaunchFactory.GraduationPhase.PoolCreated));

        // The account can no longer sweep the pool: harvest records the failed attempt and still succeeds.
        hook.simulateSwapFees{value: 0.5 ether}(poolId, 0);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IPonsMindRegistry.SweepAttempted(token, false, false);
        _harvest(token);
        assertEq(hook.pendingFees(poolId), 0.5 ether);
        vm.prank(creator);
        hook.sweepPoolFees(poolId, 0, 0);
        assertEq(hook.pendingFees(poolId), 0);
        _assertSolvent();
    }

    // ---------------------------------------------------------------------------------------------
    // recoverAccountTokens
    // ---------------------------------------------------------------------------------------------

    function test_recoverAccountTokens_movesTokensNeverEth() public {
        (address token,, address account) = _launch(creator, 1 ether);
        uint256 creatorTokens = IERC20(token).balanceOf(creator);
        vm.prank(creator);
        assertTrue(IERC20(token).transfer(account, 1000 ether));
        vm.prank(stranger);
        (bool ok,) = account.call{value: 0.1 ether}("");
        assertTrue(ok);

        vm.prank(stranger);
        vm.expectRevert(IMindCore.NotCreator.selector);
        registry.recoverAccountTokens(token, token);
        vm.expectRevert(IMindCore.NotCreator.selector);
        registry.recoverAccountTokens(makeAddr("random"), token);

        vm.prank(creator);
        registry.recoverAccountTokens(token, token);
        assertEq(IERC20(token).balanceOf(account), 0);
        assertEq(IERC20(token).balanceOf(creator), creatorTokens);
        assertEq(account.balance, 0.1 ether, "ETH never leaves through this path");
        // Nothing left: a no-op.
        vm.prank(creator);
        registry.recoverAccountTokens(token, token);

        // MindAccount.sweepTokens is registry-only and refuses the zero recipient.
        vm.prank(creator);
        vm.expectRevert(MindAccount.NotRegistry.selector);
        MindAccount(payable(account)).sweepTokens(token, creator);
        vm.prank(address(registry));
        vm.expectRevert(MindAccount.ZeroAddress.selector);
        MindAccount(payable(account)).sweepTokens(token, address(0));
    }

    function test_recoverAccountTokens_afterPonsRescue() public {
        (address token, address curve, address account) = _launch(creator, 0);
        _graduate(stranger, curve);
        IPonsV2LaunchFactory.LaunchedToken memory lt = factory.getLaunchedToken(token);
        uint256 credited = escrow.balanceOf(account);
        // The pool cannot be seeded; after the delay Pons' owner releases the reserves to the mind account.
        vm.warp(block.timestamp + factory.GRADUATION_RESCUE_DELAY());
        vm.prank(ponsOwner);
        factory.rescueSweptGraduation(token, account);
        assertEq(uint8(_phase(token)), uint8(IPonsV2LaunchFactory.GraduationPhase.Rescued));
        assertEq(registry.claimable(token), credited + lt.sweptQuote, "escrow balance + account ETH");

        vm.expectEmit(true, false, false, true, address(registry));
        emit IPonsMindRegistry.SweepAttempted(token, false, false);
        _harvest(token);
        assertEq(registry.mindBalance(token), credited + lt.sweptQuote);
        uint256 before = IERC20(token).balanceOf(creator);
        vm.prank(creator);
        registry.recoverAccountTokens(token, token);
        assertEq(IERC20(token).balanceOf(creator) - before, lt.sweptTokens);
        assertEq(IERC20(token).balanceOf(account), 0);
        _assertSolvent();
    }
}
