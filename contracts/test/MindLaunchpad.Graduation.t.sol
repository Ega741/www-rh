// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MindToken} from "../src/MindToken.sol";
import {MockGraduator} from "../src/MockGraduator.sol";
import {IMindLaunchpad} from "../src/interfaces/IMindLaunchpad.sol";
import {ConfigurableGraduator} from "./mocks/ConfigurableGraduator.sol";
import {BaseTest} from "./utils/BaseTest.sol";

/// @notice graduate / harvest through graduators, receive() gating and the balance check (directives D1, D2).
contract MindLaunchpadGraduationTest is BaseTest {
    ConfigurableGraduator internal cfg;

    function setUp() public override {
        super.setUp();
        cfg = new ConfigurableGraduator(address(launchpad));
        vm.deal(address(cfg), 100 ether);
    }

    function _useCfg() internal {
        vm.prank(owner);
        launchpad.setGraduator(address(cfg));
    }

    // ---------------------------------------------------------------------------------------------
    // MockGraduator
    // ---------------------------------------------------------------------------------------------

    function test_graduate_withMockGraduator() public {
        address token = _createMind();
        _complete(alice, token);
        (uint256 reserve,) = _curve(token);
        uint256 gradFee = reserve * 250 / 10_000;
        uint256 ethLiquidity = reserve - gradFee;
        uint256 mindFee = gradFee * 7000 / 10_000;
        uint256 mindBefore = launchpad.mindBalance(token);
        uint256 protocolBefore = launchpad.protocolBalance();

        vm.expectEmit(true, false, false, true, address(launchpad));
        emit IMindLaunchpad.FeeAccrued(token, mindFee, gradFee - mindFee);
        vm.expectEmit(true, false, false, true, address(mockGraduator));
        emit MockGraduator.MockGraduated(token, LP_SUPPLY, ethLiquidity);
        vm.expectEmit(true, false, false, true, address(launchpad));
        emit IMindLaunchpad.Graduated(token, address(mockGraduator), 0, ethLiquidity, LP_SUPPLY, gradFee);
        vm.prank(stranger); // permissionless
        launchpad.graduate(token);

        IMindLaunchpad.CurveState memory c = launchpad.getCurve(token);
        assertEq(uint8(c.phase), uint8(IMindLaunchpad.CurvePhase.Graduated));
        assertEq(c.realEthReserve, 0);
        assertEq(c.tokensSold, CURVE_SUPPLY);
        assertEq(c.pool, address(mockGraduator));
        assertEq(c.positionId, 0);
        assertEq(launchpad.graduatorOf(token), address(mockGraduator));
        assertEq(launchpad.mindBalance(token), mindBefore + mindFee);
        assertEq(launchpad.protocolBalance(), protocolBefore + gradFee - mindFee);
        assertEq(address(mockGraduator).balance, ethLiquidity);
        assertEq(mockGraduator.ethHeld(token), ethLiquidity);
        assertEq(mockGraduator.tokensHeld(token), LP_SUPPLY);
        assertEq(MindToken(token).balanceOf(address(mockGraduator)), LP_SUPPLY);
        assertEq(MindToken(token).balanceOf(address(launchpad)), 0);
        assertEq(address(launchpad).balance, launchpad.mindBalance(token) + launchpad.protocolBalance());

        // Harvest through the mock is a no-op that still emits.
        vm.expectEmit(true, false, false, true, address(launchpad));
        emit IMindLaunchpad.Harvested(token, 0, 0);
        launchpad.harvest(token);

        vm.expectRevert(IMindLaunchpad.WrongPhase.selector);
        launchpad.graduate(token);
        vm.expectRevert(IMindLaunchpad.WrongPhase.selector);
        launchpad.buy{value: 1 ether}(token, 0, block.timestamp);
    }

    function test_graduate_reverts() public {
        address token = _createMind();
        vm.expectRevert(IMindLaunchpad.WrongPhase.selector);
        launchpad.graduate(token);
        vm.expectRevert(IMindLaunchpad.WrongPhase.selector);
        launchpad.harvest(token);
        vm.expectRevert(IMindLaunchpad.NotAMind.selector);
        launchpad.graduate(address(0xBEEF));
        vm.expectRevert(IMindLaunchpad.NotAMind.selector);
        launchpad.harvest(address(0xBEEF));

        _complete(alice, token);
        vm.prank(owner);
        launchpad.setGraduator(address(0));
        vm.expectRevert(IMindLaunchpad.GraduatorNotSet.selector);
        launchpad.graduate(token);
    }

    function test_graduationFeeParamsApply() public {
        vm.prank(owner);
        launchpad.setFeeParams(IMindLaunchpad.FeeParams(100, 5000, 1000));
        address token = _createMind();
        _complete(alice, token);
        (uint256 reserve,) = _curve(token);
        uint256 mindBefore = launchpad.mindBalance(token);
        launchpad.graduate(token);
        uint256 gradFee = reserve / 10;
        assertEq(launchpad.mindBalance(token) - mindBefore, gradFee / 2);
        assertEq(address(mockGraduator).balance, reserve - gradFee);
    }

    // ---------------------------------------------------------------------------------------------
    // setGraduator / graduatorOf / isGraduator
    // ---------------------------------------------------------------------------------------------

    function test_setGraduator_recordsEveryGraduatorAndAffectsOnlyFutureGraduations() public {
        assertTrue(launchpad.isGraduator(address(mockGraduator)));
        assertFalse(launchpad.isGraduator(address(cfg)));

        address t1 = _createMind();
        _complete(alice, t1);
        launchpad.graduate(t1);
        assertEq(launchpad.graduatorOf(t1), address(mockGraduator));

        vm.expectEmit(false, false, false, true, address(launchpad));
        emit IMindLaunchpad.GraduatorUpdated(address(cfg));
        _useCfg();
        assertEq(launchpad.graduator(), address(cfg));
        assertTrue(launchpad.isGraduator(address(cfg)));
        assertTrue(launchpad.isGraduator(address(mockGraduator)), "never unset");

        vm.prank(owner);
        launchpad.setGraduator(address(0));
        assertFalse(launchpad.isGraduator(address(0)));
        assertTrue(launchpad.isGraduator(address(cfg)));
        _useCfg();

        // t1 keeps harvesting through its own graduator.
        cfg.setHarvestBehaviour(1 ether, 0, 0);
        uint256 mindBefore = launchpad.mindBalance(t1);
        launchpad.harvest(t1);
        assertEq(launchpad.mindBalance(t1), mindBefore, "harvest went to the mock, not the new graduator");

        address t2 = _createMind();
        _complete(alice, t2);
        launchpad.graduate(t2);
        assertEq(launchpad.graduatorOf(t2), address(cfg));
        assertEq(launchpad.getCurve(t2).positionId, 7);
    }

    // ---------------------------------------------------------------------------------------------
    // ETH returned by the graduator
    // ---------------------------------------------------------------------------------------------

    function test_graduate_creditsReturnedEth() public {
        _useCfg();
        cfg.setGraduateBehaviour(1000, 0); // send back 10 %
        address token = _createMind();
        _complete(alice, token);
        (uint256 reserve,) = _curve(token);
        uint256 ethLiquidity = reserve - reserve * 250 / 10_000;
        uint256 returned = ethLiquidity / 10;
        uint256 mindBefore = launchpad.mindBalance(token);

        vm.expectEmit(true, false, false, true, address(launchpad));
        emit IMindLaunchpad.Graduated(token, address(cfg), 7, ethLiquidity, LP_SUPPLY, reserve * 250 / 10_000);
        vm.expectEmit(true, true, false, true, address(launchpad));
        emit IMindLaunchpad.MindFunded(token, address(cfg), returned);
        launchpad.graduate(token);

        uint256 gradFee = reserve * 250 / 10_000;
        uint256 mindFee = gradFee * 7000 / 10_000;
        assertEq(launchpad.mindBalance(token), mindBefore + mindFee + returned);
        assertEq(address(launchpad).balance, launchpad.mindBalance(token) + launchpad.protocolBalance());
    }

    function test_graduate_balanceMismatchReverts() public {
        _useCfg();
        address token = _createMind();
        _complete(alice, token);

        // Over-reporting: claims 1 wei more than it sent.
        cfg.setGraduateBehaviour(1000, 1);
        vm.expectRevert(IMindLaunchpad.BalanceMismatch.selector);
        launchpad.graduate(token);

        // Under-reporting: sends more than it claims.
        cfg.setGraduateBehaviour(1000, -1);
        vm.expectRevert(IMindLaunchpad.BalanceMismatch.selector);
        launchpad.graduate(token);

        // Reporting a return without sending anything.
        cfg.setGraduateBehaviour(0, 5);
        vm.expectRevert(IMindLaunchpad.BalanceMismatch.selector);
        launchpad.graduate(token);

        // Honest again: succeeds, state was rolled back by the failures.
        cfg.setGraduateBehaviour(0, 0);
        launchpad.graduate(token);
        assertEq(uint8(launchpad.getCurve(token).phase), uint8(IMindLaunchpad.CurvePhase.Graduated));
    }

    function test_graduate_returningMoreThanSentIsCredited() public {
        _useCfg();
        cfg.setGraduateBehaviour(10_000, 0);
        cfg.setExtra(0.5 ether);
        address token = _createMind();
        _complete(alice, token);
        (uint256 reserve,) = _curve(token);
        uint256 ethLiquidity = reserve - reserve * 250 / 10_000;
        uint256 mindBefore = launchpad.mindBalance(token);
        launchpad.graduate(token);
        uint256 gradFee = reserve * 250 / 10_000;
        uint256 mindFee = gradFee * 7000 / 10_000;
        assertEq(launchpad.mindBalance(token), mindBefore + mindFee + ethLiquidity + 0.5 ether);
    }

    function test_harvest_creditsEthAndChecksBalance() public {
        _useCfg();
        address token = _createMind();
        _complete(alice, token);
        launchpad.graduate(token);
        uint256 mindBefore = launchpad.mindBalance(token);

        cfg.setHarvestBehaviour(0.3 ether, 12e18, 0);
        vm.expectEmit(true, true, false, true, address(launchpad));
        emit IMindLaunchpad.MindFunded(token, address(cfg), 0.3 ether);
        vm.expectEmit(true, false, false, true, address(launchpad));
        emit IMindLaunchpad.Harvested(token, 0.3 ether, 12e18);
        vm.prank(stranger);
        launchpad.harvest(token);
        assertEq(launchpad.mindBalance(token), mindBefore + 0.3 ether);

        cfg.setHarvestBehaviour(0.3 ether, 0, 1);
        vm.expectRevert(IMindLaunchpad.BalanceMismatch.selector);
        launchpad.harvest(token);
        cfg.setHarvestBehaviour(0.3 ether, 0, -1);
        vm.expectRevert(IMindLaunchpad.BalanceMismatch.selector);
        launchpad.harvest(token);

        // Nothing to harvest: no MindFunded, still Harvested.
        cfg.setHarvestBehaviour(0, 0, 0);
        vm.recordLogs();
        launchpad.harvest(token);
        assertEq(vm.getRecordedLogs().length, 1);
    }

    // ---------------------------------------------------------------------------------------------
    // receive() gating
    // ---------------------------------------------------------------------------------------------

    function test_receive_rejectsNonGraduators() public {
        vm.prank(alice);
        (bool ok, bytes memory err) = address(launchpad).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(err, abi.encodeWithSelector(IMindLaunchpad.DirectEthNotAccepted.selector));

        // Calls with unknown data are rejected too (no fallback).
        vm.prank(alice);
        (ok,) = address(launchpad).call{value: 1 ether}(hex"deadbeef");
        assertFalse(ok);
    }

    function test_receive_acceptsGraduatorsWithoutAccounting() public {
        vm.deal(address(mockGraduator), 1 ether);
        vm.prank(address(mockGraduator));
        (bool ok,) = address(launchpad).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(launchpad).balance, 1 ether);
        assertEq(launchpad.protocolBalance(), 0);

        // A former graduator stays accepted.
        _useCfg();
        vm.deal(address(mockGraduator), 1 ether);
        vm.prank(address(mockGraduator));
        (ok,) = address(launchpad).call{value: 1 ether}("");
        assertTrue(ok);
    }
}
