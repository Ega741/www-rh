// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Vm} from "forge-std/Vm.sol";

import {MindToken} from "../src/MindToken.sol";
import {IMindLaunchpad} from "../src/interfaces/IMindLaunchpad.sol";
import {CurveMath} from "../src/libraries/CurveMath.sol";
import {BaseTest} from "./utils/BaseTest.sol";

/// @notice Escape hatch for `Complete` curves (audit Medium-5): `completedAt`, `graduationGrace`, sells reopening a
///         curve that was not graduated within the grace period, and graduation afterwards.
contract MindLaunchpadEscapeHatchTest is BaseTest {
    uint32 internal constant GRACE = 1 days;

    function _completed() internal returns (address token, uint256 aliceTokens, uint64 completedAt) {
        token = _createMind();
        _buy(bob, token, 1 ether);
        aliceTokens = _buy(alice, token, 10 ether);
        completedAt = uint64(block.timestamp);
        assertEq(uint8(launchpad.getCurve(token).phase), uint8(IMindLaunchpad.CurvePhase.Complete));
    }

    function _trySell(address who, address token, uint256 amount) internal returns (bool ok, bytes memory err) {
        vm.startPrank(who);
        MindToken(token).approve(address(launchpad), amount);
        (ok, err) = address(launchpad).call(abi.encodeCall(IMindLaunchpad.sell, (token, amount, 0, block.timestamp)));
        vm.stopPrank();
    }

    function test_defaults() public view {
        assertEq(launchpad.graduationGrace(), GRACE);
        assertEq(launchpad.completedAt(address(0xBEEF)), 0);
    }

    function test_completedAt_recordedOnCompletion() public {
        address token = _createMind();
        _buy(bob, token, 1 ether);
        assertEq(launchpad.completedAt(token), 0);
        vm.warp(block.timestamp + 123);
        _buy(alice, token, 10 ether);
        assertEq(launchpad.completedAt(token), block.timestamp);
        // Kept after graduation.
        launchpad.graduate(token);
        assertEq(launchpad.completedAt(token), block.timestamp);
    }

    function test_sellBlockedDuringGrace() public {
        (address token, uint256 aliceTokens, uint64 completedAt) = _completed();
        vm.warp(uint256(completedAt) + GRACE - 1);
        (bool ok, bytes memory err) = _trySell(alice, token, aliceTokens);
        assertFalse(ok);
        assertEq(err, abi.encodeWithSelector(IMindLaunchpad.WrongPhase.selector));
        vm.expectRevert(IMindLaunchpad.WrongPhase.selector);
        launchpad.quoteSell(token, 1e18);
        // Buys never reopen a curve.
        vm.prank(bob);
        vm.expectRevert(IMindLaunchpad.WrongPhase.selector);
        launchpad.buy{value: 1 ether}(token, 0, block.timestamp);
    }

    function test_sellAfterGrace_reopensTheCurve() public {
        (address token, uint256 aliceTokens, uint64 completedAt) = _completed();
        vm.warp(uint256(completedAt) + GRACE);

        // Buys stay Bonding-only until a sell reopens the curve.
        vm.prank(bob);
        vm.expectRevert(IMindLaunchpad.WrongPhase.selector);
        launchpad.buy{value: 1 ether}(token, 0, block.timestamp);

        uint256 amount = aliceTokens / 2;
        (uint256 reserve, uint256 sold) = _curve(token);
        (uint256 quoteOut, uint256 quoteFee) = launchpad.quoteSell(token, amount);
        (uint256 refOut, uint256 refFee) = CurveMath.quoteSell(reserve, sold, amount, FEE_BPS);
        assertEq(quoteOut, refOut);
        assertEq(quoteFee, refFee);

        uint256 mindFee = quoteFee * 7000 / 10_000;
        vm.startPrank(alice);
        MindToken(token).approve(address(launchpad), amount);
        vm.expectEmit(true, false, false, true, address(launchpad));
        emit IMindLaunchpad.CurveReopened(token);
        vm.expectEmit(true, false, false, true, address(launchpad));
        emit IMindLaunchpad.FeeAccrued(token, mindFee, quoteFee - mindFee);
        vm.expectEmit(true, true, false, true, address(launchpad));
        emit IMindLaunchpad.Trade(
            token, alice, false, quoteOut, amount, quoteFee, reserve - quoteOut - quoteFee, sold - amount
        );
        uint256 ethOut = launchpad.sell(token, amount, quoteOut, block.timestamp);
        vm.stopPrank();
        assertEq(ethOut, quoteOut);

        IMindLaunchpad.CurveState memory c = launchpad.getCurve(token);
        assertEq(uint8(c.phase), uint8(IMindLaunchpad.CurvePhase.Bonding));
        assertEq(c.tokensSold, sold - amount);
        assertEq(c.realEthReserve, reserve - quoteOut - quoteFee);
        assertEq(launchpad.completedAt(token), 0, "reset on reopen");
        assertEq(MindToken(token).balanceOf(address(launchpad)), TOTAL_SUPPLY - c.tokensSold);
        vm.expectRevert(IMindLaunchpad.WrongPhase.selector);
        launchpad.graduate(token);

        // Ordinary Bonding trading resumes; a further sell does not emit CurveReopened again.
        vm.recordLogs();
        _sell(alice, token, amount / 2);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != IMindLaunchpad.CurveReopened.selector, "reopened only once");
        }
        _buy(bob, token, 0.1 ether);
    }

    function test_reopenedCurve_recompletesAndGraduates() public {
        (address token, uint256 aliceTokens, uint64 completedAt) = _completed();
        vm.warp(uint256(completedAt) + GRACE + 1 hours);
        _sell(alice, token, aliceTokens / 4);

        vm.warp(block.timestamp + 5 hours);
        _buy(bob, token, 10 ether);
        assertEq(uint8(launchpad.getCurve(token).phase), uint8(IMindLaunchpad.CurvePhase.Complete));
        assertEq(launchpad.completedAt(token), block.timestamp, "new completion time");
        // The new completion starts a new grace period.
        (bool ok,) = _trySell(alice, token, 1e18);
        assertFalse(ok);

        launchpad.graduate(token);
        IMindLaunchpad.CurveState memory c = launchpad.getCurve(token);
        assertEq(uint8(c.phase), uint8(IMindLaunchpad.CurvePhase.Graduated));
        assertEq(c.realEthReserve, 0);
        assertEq(address(launchpad).balance, launchpad.mindBalance(token) + launchpad.protocolBalance());
        (ok,) = _trySell(alice, token, 1e18);
        assertFalse(ok, "no sells once graduated");
    }

    function test_graduateStillWorksAfterGraceWithoutSells() public {
        (address token,, uint64 completedAt) = _completed();
        vm.warp(uint256(completedAt) + 10 days);
        launchpad.graduate(token);
        assertEq(uint8(launchpad.getCurve(token).phase), uint8(IMindLaunchpad.CurvePhase.Graduated));
    }

    /// @dev The use case: graduation is impossible (no graduator); after the grace every holder exits on the curve.
    function test_holdersExitWhenGraduationIsImpossible() public {
        (address token, uint256 aliceTokens, uint64 completedAt) = _completed();
        uint256 bobTokens = MindToken(token).balanceOf(bob);
        vm.prank(owner);
        launchpad.setGraduator(address(0));
        vm.expectRevert(IMindLaunchpad.GraduatorNotSet.selector);
        launchpad.graduate(token);

        vm.warp(uint256(completedAt) + GRACE);
        uint256 aliceOut = _sell(alice, token, aliceTokens);
        uint256 bobOut = _sell(bob, token, bobTokens);
        assertGt(aliceOut + bobOut, 3.8 ether);
        (uint256 reserve, uint256 sold) = _curve(token);
        assertEq(sold, 0);
        assertLe(reserve, 10, "rounding dust only");
        assertGe(address(launchpad).balance, reserve + launchpad.mindBalance(token) + launchpad.protocolBalance());
    }

    function test_setGraduationGrace() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        launchpad.setGraduationGrace(2 hours);

        vm.startPrank(owner);
        vm.expectRevert(IMindLaunchpad.InvalidGraduationGrace.selector);
        launchpad.setGraduationGrace(1 hours - 1);
        vm.expectRevert(IMindLaunchpad.InvalidGraduationGrace.selector);
        launchpad.setGraduationGrace(30 days + 1);
        vm.expectEmit(false, false, false, true, address(launchpad));
        emit IMindLaunchpad.GraduationGraceUpdated(1 hours);
        launchpad.setGraduationGrace(1 hours);
        launchpad.setGraduationGrace(30 days);
        vm.stopPrank();
        assertEq(launchpad.graduationGrace(), 30 days);
    }

    function test_graduationGrace_appliesToWaitingCurves() public {
        (address token, uint256 aliceTokens, uint64 completedAt) = _completed();
        vm.warp(uint256(completedAt) + 2 hours);
        (bool ok,) = _trySell(alice, token, aliceTokens);
        assertFalse(ok);

        vm.prank(owner);
        launchpad.setGraduationGrace(1 hours);
        (uint256 ethOut,) = launchpad.quoteSell(token, aliceTokens / 2);
        assertGt(ethOut, 0);

        vm.prank(owner);
        launchpad.setGraduationGrace(3 hours);
        vm.expectRevert(IMindLaunchpad.WrongPhase.selector);
        launchpad.quoteSell(token, aliceTokens / 2);
    }

    function testFuzz_sellRuleAroundTheGrace(uint32 grace, uint32 elapsed) public {
        grace = uint32(bound(grace, 1 hours, 30 days));
        elapsed = uint32(bound(elapsed, 0, 31 days));
        vm.prank(owner);
        launchpad.setGraduationGrace(grace);
        (address token, uint256 aliceTokens, uint64 completedAt) = _completed();
        vm.warp(uint256(completedAt) + elapsed);
        (bool ok,) = _trySell(alice, token, aliceTokens / 3);
        assertEq(ok, elapsed >= grace);
        IMindLaunchpad.CurvePhase expected = ok ? IMindLaunchpad.CurvePhase.Bonding : IMindLaunchpad.CurvePhase.Complete;
        assertEq(uint8(launchpad.getCurve(token).phase), uint8(expected));
    }
}
