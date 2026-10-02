// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IMindLaunchpad} from "../src/interfaces/IMindLaunchpad.sol";
import {ReentrantReceiver} from "./mocks/ReentrantReceiver.sol";
import {BaseTest} from "./utils/BaseTest.sol";

/// @notice Mind vault (fundMind / drawCompute / epoch caps), mind status rules and creator configuration.
contract MindLaunchpadVaultTest is BaseTest {
    address internal token;
    bytes32 internal constant RECEIPT = keccak256("receipt");

    function setUp() public override {
        super.setUp();
        token = _createMind();
    }

    function _fund(uint256 amount) internal {
        vm.prank(alice);
        launchpad.fundMind{value: amount}(token);
    }

    function _draw(uint256 amount) internal {
        vm.prank(operator);
        launchpad.drawCompute(token, amount, RECEIPT);
    }

    // ---------------------------------------------------------------------------------------------
    // fundMind
    // ---------------------------------------------------------------------------------------------

    function test_fundMind() public {
        vm.expectEmit(true, true, false, true, address(launchpad));
        emit IMindLaunchpad.MindFunded(token, alice, 1 ether);
        _fund(1 ether);
        assertEq(launchpad.mindBalance(token), 1 ether);
        assertEq(address(launchpad).balance, 1 ether);

        vm.expectRevert(IMindLaunchpad.ZeroAmount.selector);
        launchpad.fundMind(token);
        vm.expectRevert(IMindLaunchpad.NotAMind.selector);
        launchpad.fundMind{value: 1}(address(0xBEEF));

        // Works in every status.
        vm.prank(creator);
        launchpad.setCreatorPaused(token, true);
        _fund(1 ether);
        assertEq(launchpad.mindBalance(token), 2 ether);
    }

    // ---------------------------------------------------------------------------------------------
    // drawCompute
    // ---------------------------------------------------------------------------------------------

    function test_drawCompute_paysComputeTreasury() public {
        _fund(1 ether);
        vm.expectEmit(true, false, false, true, address(launchpad));
        emit IMindLaunchpad.ComputeDrawn(token, 0.1 ether, RECEIPT);
        _draw(0.1 ether);
        assertEq(computeTreasury.balance, 0.1 ether);
        assertEq(launchpad.mindBalance(token), 0.9 ether);
        (uint256 drawn, uint64 epochStart) = launchpad.drawnInEpoch(token);
        assertEq(drawn, 0.1 ether);
        assertEq(epochStart, block.timestamp);

        // The recipient follows setComputeTreasury.
        address newTreasury = makeAddr("newComputeTreasury");
        vm.prank(owner);
        launchpad.setComputeTreasury(newTreasury);
        _draw(0.05 ether);
        assertEq(newTreasury.balance, 0.05 ether);
        assertEq(computeTreasury.balance, 0.1 ether);
    }

    function test_drawCompute_epochCap() public {
        _fund(2 ether);
        _draw(0.2 ether);
        _draw(0.05 ether); // exactly at the 0.25 ether cap
        vm.prank(operator);
        vm.expectRevert(IMindLaunchpad.DrawLimitExceeded.selector);
        launchpad.drawCompute(token, 1, RECEIPT);

        // Still inside the epoch one second before it ends.
        (, uint64 start) = launchpad.drawnInEpoch(token);
        vm.warp(uint256(start) + 1 days - 1);
        vm.prank(operator);
        vm.expectRevert(IMindLaunchpad.DrawLimitExceeded.selector);
        launchpad.drawCompute(token, 1, RECEIPT);

        // A new epoch starts at epochStart + drawEpoch.
        vm.warp(uint256(start) + 1 days);
        (uint256 drawnView, uint64 startView) = launchpad.drawnInEpoch(token);
        assertEq(drawnView, 0.25 ether, "the view returns the stored values (no reset applied)");
        assertEq(startView, start);
        _draw(0.25 ether);
        (uint256 drawn, uint64 newStart) = launchpad.drawnInEpoch(token);
        assertEq(drawn, 0.25 ether);
        assertEq(newStart, block.timestamp);
        vm.prank(operator);
        vm.expectRevert(IMindLaunchpad.DrawLimitExceeded.selector);
        launchpad.drawCompute(token, 1, RECEIPT);

        // A single draw above the cap never passes.
        vm.warp(block.timestamp + 2 days);
        vm.prank(operator);
        vm.expectRevert(IMindLaunchpad.DrawLimitExceeded.selector);
        launchpad.drawCompute(token, 0.25 ether + 1, RECEIPT);
    }

    function test_drawCompute_capIsPerMind() public {
        address other = _createMind();
        _fund(1 ether);
        vm.prank(alice);
        launchpad.fundMind{value: 1 ether}(other);
        _draw(0.25 ether);
        vm.prank(operator);
        launchpad.drawCompute(other, 0.25 ether, RECEIPT);
        assertEq(computeTreasury.balance, 0.5 ether);
    }

    function test_drawCompute_customLimit() public {
        vm.expectEmit(false, false, false, true, address(launchpad));
        emit IMindLaunchpad.DrawLimitUpdated(1 ether, 3600);
        vm.prank(owner);
        launchpad.setDrawLimit(1 ether, 3600);
        (uint256 maxPerEpoch, uint32 epochSeconds) = launchpad.drawLimit();
        assertEq(maxPerEpoch, 1 ether);
        assertEq(epochSeconds, 3600);
        _fund(5 ether);
        _draw(1 ether);
        vm.warp(block.timestamp + 3600);
        _draw(1 ether);
        assertEq(computeTreasury.balance, 2 ether);

        vm.startPrank(owner);
        vm.expectRevert(IMindLaunchpad.InvalidDrawLimit.selector);
        launchpad.setDrawLimit(1 ether, 0);
        vm.expectRevert(IMindLaunchpad.InvalidDrawLimit.selector);
        launchpad.setDrawLimit(1 ether, 3599);
        // A zero cap is allowed and blocks draws.
        launchpad.setDrawLimit(0, 3600);
        vm.stopPrank();
        vm.warp(block.timestamp + 3600);
        vm.prank(operator);
        vm.expectRevert(IMindLaunchpad.DrawLimitExceeded.selector);
        launchpad.drawCompute(token, 1, RECEIPT);
    }

    function test_drawCompute_reverts() public {
        _fund(0.1 ether);
        vm.startPrank(operator);
        vm.expectRevert(IMindLaunchpad.ZeroAmount.selector);
        launchpad.drawCompute(token, 0, RECEIPT);
        vm.expectRevert(IMindLaunchpad.InsufficientMindBalance.selector);
        launchpad.drawCompute(token, 0.1 ether + 1, RECEIPT);
        vm.expectRevert(IMindLaunchpad.NotAMind.selector);
        launchpad.drawCompute(address(0xBEEF), 1, RECEIPT);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(IMindLaunchpad.NotOperator.selector);
        launchpad.drawCompute(token, 1, RECEIPT);
        vm.prank(creator);
        vm.expectRevert(IMindLaunchpad.NotOperator.selector);
        launchpad.drawCompute(token, 1, RECEIPT);
    }

    function test_drawCompute_allowedInAnyStatus() public {
        _fund(1 ether);
        vm.prank(operator);
        launchpad.setMindStatus(token, IMindLaunchpad.MindStatus.Dormant);
        _draw(0.01 ether);
        vm.prank(creator);
        launchpad.setCreatorPaused(token, true);
        _draw(0.01 ether);
        assertEq(computeTreasury.balance, 0.02 ether);
    }

    function test_drawCompute_failingTreasuryReverts() public {
        _fund(1 ether);
        ReentrantReceiver r = new ReentrantReceiver(launchpad);
        r.configure(token, ReentrantReceiver.Mode.Reject, false);
        vm.prank(owner);
        launchpad.setComputeTreasury(address(r));
        vm.prank(operator);
        vm.expectRevert(IMindLaunchpad.EthTransferFailed.selector);
        launchpad.drawCompute(token, 0.1 ether, RECEIPT);
        assertEq(launchpad.mindBalance(token), 1 ether);
    }

    function test_vaultFromFeesIsDrawable() public {
        _buy(alice, token, 2 ether);
        uint256 vault = launchpad.mindBalance(token);
        assertEq(vault, 2 ether / 100 * 7000 / 10_000);
        _draw(vault);
        assertEq(launchpad.mindBalance(token), 0);
        assertEq(computeTreasury.balance, vault);
    }

    // ---------------------------------------------------------------------------------------------
    // Status rules (directive D4)
    // ---------------------------------------------------------------------------------------------

    function test_operatorTogglesAliveDormant() public {
        vm.expectEmit(true, false, false, true, address(launchpad));
        emit IMindLaunchpad.MindStatusChanged(token, IMindLaunchpad.MindStatus.Dormant);
        vm.prank(operator);
        launchpad.setMindStatus(token, IMindLaunchpad.MindStatus.Dormant);
        assertEq(uint8(_status(token)), uint8(IMindLaunchpad.MindStatus.Dormant));

        // Idempotent: no event when unchanged.
        vm.recordLogs();
        vm.prank(operator);
        launchpad.setMindStatus(token, IMindLaunchpad.MindStatus.Dormant);
        assertEq(vm.getRecordedLogs().length, 0);

        vm.prank(operator);
        launchpad.setMindStatus(token, IMindLaunchpad.MindStatus.Alive);
        assertEq(uint8(_status(token)), uint8(IMindLaunchpad.MindStatus.Alive));
    }

    function test_operatorCannotPauseOrTouchPausedMind() public {
        vm.prank(operator);
        vm.expectRevert(IMindLaunchpad.InvalidStatus.selector);
        launchpad.setMindStatus(token, IMindLaunchpad.MindStatus.Paused);

        vm.prank(creator);
        launchpad.setCreatorPaused(token, true);
        vm.startPrank(operator);
        vm.expectRevert(IMindLaunchpad.InvalidStatus.selector);
        launchpad.setMindStatus(token, IMindLaunchpad.MindStatus.Alive);
        vm.expectRevert(IMindLaunchpad.InvalidStatus.selector);
        launchpad.setMindStatus(token, IMindLaunchpad.MindStatus.Dormant);
        vm.stopPrank();
        assertEq(uint8(_status(token)), uint8(IMindLaunchpad.MindStatus.Paused));
    }

    function test_creatorPauseAndUnpause() public {
        vm.prank(operator);
        launchpad.setMindStatus(token, IMindLaunchpad.MindStatus.Dormant);

        vm.expectEmit(true, false, false, true, address(launchpad));
        emit IMindLaunchpad.MindStatusChanged(token, IMindLaunchpad.MindStatus.Paused);
        vm.prank(creator);
        launchpad.setCreatorPaused(token, true);
        assertEq(uint8(_status(token)), uint8(IMindLaunchpad.MindStatus.Paused));

        // Pausing again is a no-op without an event.
        vm.recordLogs();
        vm.prank(creator);
        launchpad.setCreatorPaused(token, true);
        assertEq(vm.getRecordedLogs().length, 0);

        vm.expectEmit(true, false, false, true, address(launchpad));
        emit IMindLaunchpad.MindStatusChanged(token, IMindLaunchpad.MindStatus.Alive);
        vm.prank(creator);
        launchpad.setCreatorPaused(token, false);
        assertEq(uint8(_status(token)), uint8(IMindLaunchpad.MindStatus.Alive));

        vm.recordLogs();
        vm.prank(creator);
        launchpad.setCreatorPaused(token, false);
        assertEq(vm.getRecordedLogs().length, 0, "unpausing a non-paused mind is a no-op");
        assertEq(uint8(_status(token)), uint8(IMindLaunchpad.MindStatus.Alive));

        // Unpausing a mind that is not paused leaves a Dormant status untouched.
        vm.prank(operator);
        launchpad.setMindStatus(token, IMindLaunchpad.MindStatus.Dormant);
        vm.recordLogs();
        vm.prank(creator);
        launchpad.setCreatorPaused(token, false);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(uint8(_status(token)), uint8(IMindLaunchpad.MindStatus.Dormant));
    }

    function test_onlyCreatorPauses() public {
        address[3] memory others = [operator, owner, stranger];
        for (uint256 i; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(IMindLaunchpad.NotCreator.selector);
            launchpad.setCreatorPaused(token, true);
        }
        // Unknown tokens have no creator.
        vm.expectRevert(IMindLaunchpad.NotCreator.selector);
        launchpad.setCreatorPaused(address(0xBEEF), true);
        vm.prank(creator);
        vm.expectRevert(IMindLaunchpad.NotCreator.selector);
        launchpad.setMindConfig(address(0xBEEF), MODEL_ID, PERSONA_HASH, "");
    }

    function test_pausedVaultIsNotWithdrawableByCreator() public {
        _fund(1 ether);
        vm.prank(creator);
        launchpad.setCreatorPaused(token, true);
        // There is no creator withdrawal path at all: the only outflow is drawCompute to the compute treasury.
        uint256 creatorBefore = creator.balance;
        _draw(0.25 ether);
        assertEq(creator.balance, creatorBefore);
        assertEq(computeTreasury.balance, 0.25 ether);
    }

    // ---------------------------------------------------------------------------------------------
    // setMindConfig / anchorMemory
    // ---------------------------------------------------------------------------------------------

    function test_setMindConfig() public {
        bytes32 model = keccak256("claude-sonnet-5-5");
        bytes32 persona = keccak256("new persona");
        vm.expectEmit(true, false, false, true, address(launchpad));
        emit IMindLaunchpad.MindConfigUpdated(token, model, persona, "ipfs://cid");
        vm.prank(creator);
        launchpad.setMindConfig(token, model, persona, "ipfs://cid");
        IMindLaunchpad.MindInfo memory info = launchpad.getMind(token);
        assertEq(info.modelId, model);
        assertEq(info.personaHash, persona);
        assertEq(info.metadataURI, "ipfs://cid");

        vm.startPrank(creator);
        vm.expectRevert(IMindLaunchpad.InvalidModel.selector);
        launchpad.setMindConfig(token, bytes32(0), persona, "ipfs://cid");
        vm.expectRevert(IMindLaunchpad.MetadataTooLong.selector);
        launchpad.setMindConfig(token, model, persona, string(new bytes(2049)));
        // Rule 8 order: the model is checked before the metadata length.
        vm.expectRevert(IMindLaunchpad.InvalidModel.selector);
        launchpad.setMindConfig(token, bytes32(0), persona, string(new bytes(2049)));
        vm.stopPrank();

        vm.prank(stranger);
        vm.expectRevert(IMindLaunchpad.NotCreator.selector);
        launchpad.setMindConfig(token, model, persona, "x");
        vm.prank(operator);
        vm.expectRevert(IMindLaunchpad.NotCreator.selector);
        launchpad.setMindConfig(token, model, persona, "x");
    }

    function test_anchorMemory() public {
        vm.expectEmit(true, true, false, true, address(launchpad));
        emit IMindLaunchpad.MemoryAnchored(token, 3, keccak256("batch"), "runner://memories/x/1-3");
        vm.prank(operator);
        launchpad.anchorMemory(token, 3, keccak256("batch"), "runner://memories/x/1-3");

        vm.prank(stranger);
        vm.expectRevert(IMindLaunchpad.NotOperator.selector);
        launchpad.anchorMemory(token, 4, bytes32(0), "");
        vm.prank(operator);
        vm.expectRevert(IMindLaunchpad.NotAMind.selector);
        launchpad.anchorMemory(address(0xBEEF), 4, bytes32(0), "");
    }
}
