// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {MindLaunchpad} from "../src/MindLaunchpad.sol";
import {MindToken} from "../src/MindToken.sol";
import {MockGraduator} from "../src/MockGraduator.sol";
import {IMindCore} from "../src/interfaces/IMindCore.sol";
import {IMindLaunchpad} from "../src/interfaces/IMindLaunchpad.sol";
import {BaseTest} from "./utils/BaseTest.sol";

/// @notice Constructor, owner setters, access control for every restricted function, pause scope and
///         protocol fee withdrawal.
contract MindLaunchpadAdminTest is BaseTest {
    // ---------------------------------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------------------------------

    function test_constructor_initialState() public view {
        assertEq(launchpad.owner(), owner);
        assertEq(launchpad.treasury(), treasury);
        assertEq(launchpad.computeTreasury(), computeTreasury);
        assertEq(launchpad.operator(), operator);
        assertEq(launchpad.graduator(), address(mockGraduator));
        IMindLaunchpad.FeeParams memory p = launchpad.feeParams();
        assertEq(p.tradeFeeBps, 100);
        assertEq(p.mindShareBps, 7000);
        assertEq(p.graduationFeeBps, 250);
        assertEq(launchpad.creationFee(), 0);
        (uint256 maxPerEpoch, uint32 epochSeconds) = launchpad.drawLimit();
        assertEq(maxPerEpoch, 0.25 ether);
        assertEq(epochSeconds, 1 days);
        assertEq(launchpad.TOTAL_SUPPLY(), 1_000_000_000e18);
        assertEq(launchpad.CURVE_SUPPLY(), 800_000_000e18);
        assertEq(launchpad.LP_SUPPLY(), 200_000_000e18);
        assertEq(launchpad.VIRTUAL_ETH(), 1.365 ether);
        assertEq(launchpad.VIRTUAL_TOKENS(), 1_073_000_000e18);
        assertEq(launchpad.graduationGrace(), 1 days);
        assertFalse(launchpad.paused());
    }

    function test_constructor_emitsAndValidates() public {
        vm.expectEmit(false, false, false, true);
        emit IMindCore.TreasuryUpdated(treasury);
        vm.expectEmit(false, false, false, true);
        emit IMindCore.ComputeTreasuryUpdated(computeTreasury);
        vm.expectEmit(false, false, false, true);
        emit IMindCore.OperatorUpdated(operator);
        vm.expectEmit(false, false, false, true);
        emit IMindLaunchpad.FeeParamsUpdated(100, 7000, 250);
        vm.expectEmit(false, false, false, true);
        emit IMindCore.DrawLimitUpdated(0.25 ether, 1 days);
        vm.expectEmit(false, false, false, true);
        emit IMindLaunchpad.GraduationGraceUpdated(1 days);
        MindLaunchpad fresh = new MindLaunchpad(owner, treasury, computeTreasury, operator);
        assertEq(fresh.graduator(), address(0));

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new MindLaunchpad(address(0), treasury, computeTreasury, operator);
        vm.expectRevert(IMindCore.ZeroAddress.selector);
        new MindLaunchpad(owner, address(0), computeTreasury, operator);
        vm.expectRevert(IMindCore.ZeroAddress.selector);
        new MindLaunchpad(owner, treasury, address(0), operator);
        vm.expectRevert(IMindCore.ZeroAddress.selector);
        new MindLaunchpad(owner, treasury, computeTreasury, address(0));
    }

    function test_mockGraduatorConstructor() public {
        vm.expectRevert(MockGraduator.ZeroAddress.selector);
        new MockGraduator(address(0));
    }

    // ---------------------------------------------------------------------------------------------
    // Owner setters
    // ---------------------------------------------------------------------------------------------

    function test_ownerSetters() public {
        address a = makeAddr("a");
        vm.startPrank(owner);

        vm.expectEmit(false, false, false, true, address(launchpad));
        emit IMindCore.OperatorUpdated(a);
        launchpad.setOperator(a);
        assertEq(launchpad.operator(), a);

        vm.expectEmit(false, false, false, true, address(launchpad));
        emit IMindCore.TreasuryUpdated(a);
        launchpad.setTreasury(a);
        assertEq(launchpad.treasury(), a);

        vm.expectEmit(false, false, false, true, address(launchpad));
        emit IMindCore.ComputeTreasuryUpdated(a);
        launchpad.setComputeTreasury(a);
        assertEq(launchpad.computeTreasury(), a);

        vm.expectEmit(false, false, false, true, address(launchpad));
        emit IMindLaunchpad.FeeParamsUpdated(500, 10_000, 1000);
        launchpad.setFeeParams(IMindLaunchpad.FeeParams(500, 10_000, 1000));
        assertEq(launchpad.feeParams().tradeFeeBps, 500);

        vm.expectEmit(false, false, false, true, address(launchpad));
        emit IMindCore.CreationFeeUpdated(1 ether);
        launchpad.setCreationFee(1 ether);
        assertEq(launchpad.creationFee(), 1 ether);

        vm.expectRevert(IMindCore.ZeroAddress.selector);
        launchpad.setOperator(address(0));
        vm.expectRevert(IMindCore.ZeroAddress.selector);
        launchpad.setTreasury(address(0));
        vm.expectRevert(IMindCore.ZeroAddress.selector);
        launchpad.setComputeTreasury(address(0));
        vm.expectRevert(IMindCore.FeeTooHigh.selector);
        launchpad.setFeeParams(IMindLaunchpad.FeeParams(501, 7000, 250));
        vm.expectRevert(IMindCore.FeeTooHigh.selector);
        launchpad.setFeeParams(IMindLaunchpad.FeeParams(100, 10_001, 250));
        vm.expectRevert(IMindCore.FeeTooHigh.selector);
        launchpad.setFeeParams(IMindLaunchpad.FeeParams(100, 7000, 1001));
        vm.stopPrank();
    }

    function test_renounceOwnership_disabled() public {
        vm.prank(owner);
        vm.expectRevert(IMindCore.RenounceDisabled.selector);
        launchpad.renounceOwnership();
        vm.prank(stranger);
        vm.expectRevert(IMindCore.RenounceDisabled.selector);
        launchpad.renounceOwnership();
        assertEq(launchpad.owner(), owner);
        // Transfers still work.
        vm.prank(owner);
        launchpad.transferOwnership(alice);
        vm.prank(alice);
        launchpad.acceptOwnership();
        vm.prank(alice);
        vm.expectRevert(IMindCore.RenounceDisabled.selector);
        launchpad.renounceOwnership();
        assertEq(launchpad.owner(), alice);
    }

    function test_setDrawLimit_hardCeiling() public {
        vm.startPrank(owner);
        vm.expectEmit(false, false, false, true, address(launchpad));
        emit IMindCore.DrawLimitUpdated(2 ether, 3600);
        launchpad.setDrawLimit(2 ether, 3600); // MAX_DRAW_PER_EPOCH
        vm.expectRevert(IMindCore.InvalidDrawLimit.selector);
        launchpad.setDrawLimit(2 ether + 1, 3600);
        vm.expectRevert(IMindCore.InvalidDrawLimit.selector);
        launchpad.setDrawLimit(type(uint256).max, 1 days);
        vm.stopPrank();
        (uint256 maxPerEpoch, uint32 epochSeconds) = launchpad.drawLimit();
        assertEq(maxPerEpoch, 2 ether);
        assertEq(epochSeconds, 3600);
    }

    /// @dev Documented bound: with fixed epochs at most 2 x MAX_DRAW_PER_EPOCH leaves a vault around a boundary,
    ///      and never more than MAX_DRAW_PER_EPOCH within one epoch.
    function test_drawBurst_boundedByTwiceTheCeiling() public {
        address token = _createMind();
        vm.prank(alice);
        launchpad.fundMind{value: 10 ether}(token);
        vm.prank(owner);
        launchpad.setDrawLimit(2 ether, 3600);
        vm.startPrank(operator);
        launchpad.drawCompute(token, 1, bytes32(0));
        (, uint64 start) = launchpad.drawnInEpoch(token);
        vm.warp(uint256(start) + 3599);
        launchpad.drawCompute(token, 2 ether - 1, bytes32(0));
        vm.expectRevert(IMindCore.DrawLimitExceeded.selector);
        launchpad.drawCompute(token, 1, bytes32(0));
        vm.warp(uint256(start) + 3600);
        launchpad.drawCompute(token, 2 ether, bytes32(0));
        vm.expectRevert(IMindCore.DrawLimitExceeded.selector);
        launchpad.drawCompute(token, 1, bytes32(0));
        vm.stopPrank();
        assertEq(computeTreasury.balance, 4 ether, "2 x MAX_DRAW_PER_EPOCH within two seconds, no more");
    }

    function test_ownershipIsTwoStep() public {
        vm.prank(owner);
        launchpad.transferOwnership(alice);
        assertEq(launchpad.owner(), owner);
        assertEq(launchpad.pendingOwner(), alice);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        launchpad.acceptOwnership();
        vm.prank(alice);
        launchpad.acceptOwnership();
        assertEq(launchpad.owner(), alice);
    }

    // ---------------------------------------------------------------------------------------------
    // Access control for every restricted function
    // ---------------------------------------------------------------------------------------------

    function test_accessControl_ownerOnly() public {
        address[4] memory callers = [stranger, operator, treasury, creator];
        for (uint256 i; i < callers.length; ++i) {
            address c = callers[i];
            bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, c);
            vm.startPrank(c);
            vm.expectRevert(err);
            launchpad.setOperator(c);
            vm.expectRevert(err);
            launchpad.setTreasury(c);
            vm.expectRevert(err);
            launchpad.setComputeTreasury(c);
            vm.expectRevert(err);
            launchpad.setGraduator(c);
            vm.expectRevert(err);
            launchpad.setFeeParams(IMindLaunchpad.FeeParams(0, 0, 0));
            vm.expectRevert(err);
            launchpad.setCreationFee(0);
            vm.expectRevert(err);
            launchpad.setDrawLimit(1, 1);
            vm.expectRevert(err);
            launchpad.setGraduationGrace(1 days);
            vm.expectRevert(err);
            launchpad.pause();
            vm.expectRevert(err);
            launchpad.unpause();
            vm.expectRevert(err);
            launchpad.transferOwnership(c);
            vm.stopPrank();
        }
    }

    function test_accessControl_operatorOnly() public {
        address token = _createMind();
        address[4] memory callers = [stranger, owner, treasury, creator];
        for (uint256 i; i < callers.length; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert(IMindCore.NotOperator.selector);
            launchpad.drawCompute(token, 1, bytes32(0));
            vm.expectRevert(IMindCore.NotOperator.selector);
            launchpad.anchorMemory(token, 1, bytes32(0), "");
            vm.expectRevert(IMindCore.NotOperator.selector);
            launchpad.setMindStatus(token, IMindCore.MindStatus.Dormant);
            vm.stopPrank();
        }
    }

    function test_accessControl_creatorOnly() public {
        address token = _createMind();
        address[4] memory callers = [stranger, owner, operator, treasury];
        for (uint256 i; i < callers.length; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert(IMindCore.NotCreator.selector);
            launchpad.setMindConfig(token, MODEL_ID, PERSONA_HASH, "");
            vm.expectRevert(IMindCore.NotCreator.selector);
            launchpad.setCreatorPaused(token, true);
            vm.stopPrank();
        }
    }

    function test_accessControl_graduatorOnly() public {
        address token = _createMind();
        vm.prank(stranger);
        vm.expectRevert(MockGraduator.NotLaunchpad.selector);
        mockGraduator.graduate(token, 1);
        vm.prank(stranger);
        vm.expectRevert(MockGraduator.NotLaunchpad.selector);
        mockGraduator.harvest(token);
        vm.prank(stranger);
        (bool ok,) = address(launchpad).call{value: 1}("");
        assertFalse(ok, "receive is graduator-only");
    }

    // ---------------------------------------------------------------------------------------------
    // Protocol fees
    // ---------------------------------------------------------------------------------------------

    function test_withdrawProtocolFees() public {
        address token = _createMind();
        _buy(alice, token, 1 ether);
        uint256 protocol = launchpad.protocolBalance();
        assertGt(protocol, 0);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        launchpad.withdrawProtocolFees(stranger);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        launchpad.withdrawProtocolFees(operator);
        vm.prank(owner);
        vm.expectRevert(IMindCore.ZeroAddress.selector);
        launchpad.withdrawProtocolFees(address(0));

        vm.expectEmit(true, false, false, true, address(launchpad));
        emit IMindCore.ProtocolFeesWithdrawn(treasury, protocol);
        vm.prank(treasury);
        launchpad.withdrawProtocolFees(treasury);
        assertEq(treasury.balance, protocol);
        assertEq(launchpad.protocolBalance(), 0);

        vm.prank(owner);
        vm.expectRevert(IMindCore.ZeroAmount.selector);
        launchpad.withdrawProtocolFees(owner);

        _buy(alice, token, 1 ether);
        uint256 more = launchpad.protocolBalance();
        vm.prank(owner);
        launchpad.withdrawProtocolFees(bob);
        assertEq(bob.balance, 1000 ether + more);
        // The mind vault and the curve reserve are untouched.
        (uint256 reserve,) = _curve(token);
        assertEq(address(launchpad).balance, reserve + launchpad.mindBalance(token));
    }

    // ---------------------------------------------------------------------------------------------
    // Pause scope: createMind and buy only
    // ---------------------------------------------------------------------------------------------

    function test_pauseScope() public {
        address token = _createMind();
        uint256 bought = _buy(alice, token, 1 ether);
        address token2 = _createMind();
        _complete(bob, token2);
        address token3 = _createMind();
        _complete(bob, token3);
        launchpad.graduate(token3);

        vm.prank(owner);
        launchpad.pause();
        assertTrue(launchpad.paused());

        vm.prank(creator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        launchpad.createMind("X", "X", METADATA_URI, MODEL_ID, PERSONA_HASH, 0);
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        launchpad.buy{value: 1 ether}(token, 0, block.timestamp);

        // Everything else keeps working.
        _sell(alice, token, bought / 2);
        launchpad.graduate(token2);
        launchpad.harvest(token3);
        vm.prank(alice);
        launchpad.fundMind{value: 1 ether}(token);
        vm.prank(operator);
        launchpad.drawCompute(token, 0.1 ether, bytes32(0));
        vm.prank(operator);
        launchpad.setMindStatus(token, IMindCore.MindStatus.Dormant);
        vm.prank(creator);
        launchpad.setCreatorPaused(token, true);
        vm.prank(owner);
        launchpad.withdrawProtocolFees(owner);
        launchpad.quoteSell(token, 1e18);

        vm.prank(owner);
        launchpad.unpause();
        _buy(alice, token, 0.1 ether);
        assertGt(MindToken(token).balanceOf(alice), 0);
    }
}
