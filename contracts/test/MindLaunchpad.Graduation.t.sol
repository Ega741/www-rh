// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {MindToken} from "../src/MindToken.sol";
import {MockGraduator} from "../src/MockGraduator.sol";
import {IMindCore} from "../src/interfaces/IMindCore.sol";
import {IMindLaunchpad} from "../src/interfaces/IMindLaunchpad.sol";
import {ConfigurableGraduator} from "./mocks/ConfigurableGraduator.sol";
import {MaliciousGraduator} from "./mocks/MaliciousGraduator.sol";
import {MockWETH9} from "./mocks/MockWETH9.sol";
import {BaseTest} from "./utils/BaseTest.sol";

/// @notice graduate / harvest through graduators, receive() gating and the ETH return counter (directives D1, D2;
///         audit M-1), setGraduator sanity checks.
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
        emit IMindCore.FeeAccrued(token, mindFee, gradFee - mindFee);
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
        emit IMindCore.Harvested(token, 0, 0);
        launchpad.harvest(token);

        vm.expectRevert(IMindLaunchpad.WrongPhase.selector);
        launchpad.graduate(token);
        vm.expectRevert(IMindLaunchpad.WrongPhase.selector);
        launchpad.buy{value: 1 ether}(token, 0, block.timestamp);
        vm.expectRevert(IMindLaunchpad.WrongPhase.selector);
        launchpad.currentPrice(token);
    }

    function test_graduate_reverts() public {
        address token = _createMind();
        vm.expectRevert(IMindLaunchpad.WrongPhase.selector);
        launchpad.graduate(token);
        vm.expectRevert(IMindLaunchpad.WrongPhase.selector);
        launchpad.harvest(token);
        vm.expectRevert(IMindCore.NotAMind.selector);
        launchpad.graduate(address(0xBEEF));
        vm.expectRevert(IMindCore.NotAMind.selector);
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
    // setGraduator / graduatorOf
    // ---------------------------------------------------------------------------------------------

    function test_setGraduator_affectsOnlyFutureGraduations() public {
        address t1 = _createMind();
        _complete(alice, t1);
        launchpad.graduate(t1);
        assertEq(launchpad.graduatorOf(t1), address(mockGraduator));

        vm.expectEmit(false, false, false, true, address(launchpad));
        emit IMindLaunchpad.GraduatorUpdated(address(cfg));
        _useCfg();
        assertEq(launchpad.graduator(), address(cfg));

        vm.expectEmit(false, false, false, true, address(launchpad));
        emit IMindLaunchpad.GraduatorUpdated(address(0));
        vm.prank(owner);
        launchpad.setGraduator(address(0));
        assertEq(launchpad.graduator(), address(0));
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

        vm.expectEmit(true, true, false, true, address(launchpad));
        emit IMindCore.MindFunded(token, address(cfg), returned);
        vm.expectEmit(true, false, false, true, address(launchpad));
        emit IMindLaunchpad.Graduated(token, address(cfg), 7, ethLiquidity, LP_SUPPLY, reserve * 250 / 10_000);
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
        vm.expectRevert(IMindCore.EthReturnMismatch.selector);
        launchpad.graduate(token);

        // Under-reporting: sends more than it claims.
        cfg.setGraduateBehaviour(1000, -1);
        vm.expectRevert(IMindCore.EthReturnMismatch.selector);
        launchpad.graduate(token);

        // Reporting a return without sending anything.
        cfg.setGraduateBehaviour(0, 5);
        vm.expectRevert(IMindCore.EthReturnMismatch.selector);
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
        emit IMindCore.MindFunded(token, address(cfg), 0.3 ether);
        vm.expectEmit(true, false, false, true, address(launchpad));
        emit IMindCore.Harvested(token, 0.3 ether, 12e18);
        vm.prank(stranger);
        launchpad.harvest(token);
        assertEq(launchpad.mindBalance(token), mindBefore + 0.3 ether);

        cfg.setHarvestBehaviour(0.3 ether, 0, 1);
        vm.expectRevert(IMindCore.EthReturnMismatch.selector);
        launchpad.harvest(token);
        cfg.setHarvestBehaviour(0.3 ether, 0, -1);
        vm.expectRevert(IMindCore.EthReturnMismatch.selector);
        launchpad.harvest(token);

        // Nothing to harvest: no MindFunded, still Harvested.
        cfg.setHarvestBehaviour(0, 0, 0);
        vm.recordLogs();
        launchpad.harvest(token);
        assertEq(vm.getRecordedLogs().length, 1);
    }

    function test_setGraduator_sanityChecks() public {
        vm.startPrank(owner);
        // An EOA (e.g. a mistyped address).
        vm.expectRevert(IMindLaunchpad.InvalidGraduator.selector);
        launchpad.setGraduator(makeAddr("eoa"));
        // A contract without launchpad().
        address noLaunchpad = address(new MockWETH9());
        vm.expectRevert(IMindLaunchpad.InvalidGraduator.selector);
        launchpad.setGraduator(noLaunchpad);
        // A graduator wired to another launchpad.
        MockGraduator foreign = new MockGraduator(address(0xBEEF));
        vm.expectRevert(IMindLaunchpad.InvalidGraduator.selector);
        launchpad.setGraduator(address(foreign));
        vm.stopPrank();
        assertEq(launchpad.graduator(), address(mockGraduator), "unchanged by the failures");

        // Zero (disables graduation) and a correctly wired graduator are accepted.
        vm.startPrank(owner);
        launchpad.setGraduator(address(0));
        launchpad.setGraduator(address(cfg));
        vm.stopPrank();
        assertEq(launchpad.graduator(), address(cfg));
    }

    // ---------------------------------------------------------------------------------------------
    // ETH return counter (audit M-1)
    // ---------------------------------------------------------------------------------------------

    function _useMalicious(MaliciousGraduator.Mode mode) internal returns (MaliciousGraduator m) {
        m = new MaliciousGraduator(address(launchpad));
        m.setMode(mode, false);
        vm.prank(owner);
        launchpad.setGraduator(address(m));
    }

    function _liabilities() internal view returns (uint256 total) {
        total = launchpad.protocolBalance();
        for (uint256 i; i < launchpad.mindsLength(); ++i) {
            address t = launchpad.mindAt(i);
            total += launchpad.getCurve(t).realEthReserve + launchpad.mindBalance(t);
        }
    }

    /// @dev fundMind is nonReentrant: a graduator cannot push the liquidity back through it during graduate and also
    ///      report it as returned (the same wei would be credited twice).
    function test_graduate_fundMindDuringGraduateCannotDoubleCredit() public {
        address token = _createMind();
        _complete(alice, token);
        _useMalicious(MaliciousGraduator.Mode.FundMind);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        launchpad.graduate(token);
        assertEq(uint8(launchpad.getCurve(token).phase), uint8(IMindLaunchpad.CurvePhase.Complete));
        assertEq(address(launchpad).balance, _liabilities());
    }

    /// @dev Same on harvest: proceeds pushed through fundMind cannot also be reported; the honest return works.
    function test_harvest_fundMindDuringHarvestCannotDoubleCredit() public {
        address token = _createMind();
        _complete(alice, token);
        MaliciousGraduator m = _useMalicious(MaliciousGraduator.Mode.FundMind);
        m.setMode(MaliciousGraduator.Mode.FundMind, true); // graduate keeps the liquidity (like the mock)
        launchpad.graduate(token);
        assertEq(launchpad.graduatorOf(token), address(m));
        assertGt(address(m).balance, 3 ether);

        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        launchpad.harvest(token);

        // Returned through receive() in two calls instead: counted once, credited once.
        m.setMode(MaliciousGraduator.Mode.Split, true);
        uint256 proceeds = address(m).balance;
        uint256 mindBefore = launchpad.mindBalance(token);
        vm.expectEmit(true, true, false, true, address(launchpad));
        emit IMindCore.MindFunded(token, address(m), proceeds);
        launchpad.harvest(token);
        assertEq(launchpad.mindBalance(token), mindBefore + proceeds);
        assertEq(address(launchpad).balance, _liabilities());
    }

    /// @dev ETH that reaches the launchpad without a `receive()` call (a forced transfer such as selfdestruct,
    ///      simulated here by raising its balance) is invisible to the counter: reporting it as returned reverts.
    function test_graduate_forcedEthIsNotCounted() public {
        address token = _createMind();
        _complete(alice, token);
        _useMalicious(MaliciousGraduator.Mode.ForceSend);
        vm.expectRevert(IMindCore.EthReturnMismatch.selector);
        launchpad.graduate(token);
    }

    /// @dev The launchpad's receive() writes storage, so a 2300-gas `transfer` cannot return ETH (IGraduator NatSpec).
    function test_graduate_returnWithTransferStipendFails() public {
        address token = _createMind();
        _complete(alice, token);
        _useMalicious(MaliciousGraduator.Mode.TransferStipend);
        vm.expectRevert();
        launchpad.graduate(token);
        assertEq(uint8(launchpad.getCurve(token).phase), uint8(IMindLaunchpad.CurvePhase.Complete));
    }

    /// @dev During graduate, ETH from any address but the graduator being called is rejected.
    function test_graduate_returnFromAnotherAddressIsRejected() public {
        address token = _createMind();
        _complete(alice, token);
        _useMalicious(MaliciousGraduator.Mode.ViaHelper);
        vm.expectRevert(IMindCore.DirectEthNotAccepted.selector);
        launchpad.graduate(token);
    }

    /// @dev Several separate returns within one graduate call are summed by the counter.
    function test_graduate_counterSumsPartialReturns() public {
        address token = _createMind();
        _complete(alice, token);
        _useMalicious(MaliciousGraduator.Mode.Split);
        (uint256 reserve,) = _curve(token);
        uint256 gradFee = reserve * 250 / 10_000;
        uint256 ethLiquidity = reserve - gradFee;
        uint256 mindBefore = launchpad.mindBalance(token);
        launchpad.graduate(token);
        assertEq(launchpad.mindBalance(token), mindBefore + gradFee * 7000 / 10_000 + ethLiquidity);
        assertEq(address(launchpad).balance, _liabilities());
    }

    // ---------------------------------------------------------------------------------------------
    // receive() gating
    // ---------------------------------------------------------------------------------------------

    function test_receive_rejectsNonGraduators() public {
        vm.prank(alice);
        (bool ok, bytes memory err) = address(launchpad).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(err, abi.encodeWithSelector(IMindCore.DirectEthNotAccepted.selector));

        // Calls with unknown data are rejected too (no fallback).
        vm.prank(alice);
        (ok,) = address(launchpad).call{value: 1 ether}(hex"deadbeef");
        assertFalse(ok);
    }

    /// @dev Outside a graduate/harvest call nobody, not even the current or a former graduator, can send ETH.
    function test_receive_onlyFromTheGraduatorBeingCalled() public {
        vm.deal(address(mockGraduator), 1 ether);
        vm.prank(address(mockGraduator));
        (bool ok, bytes memory err) = address(launchpad).call{value: 1 ether}("");
        assertFalse(ok, "current graduator outside a call");
        assertEq(err, abi.encodeWithSelector(IMindCore.DirectEthNotAccepted.selector));

        _useCfg();
        vm.deal(address(mockGraduator), 1 ether);
        vm.prank(address(mockGraduator));
        (ok,) = address(launchpad).call{value: 1 ether}("");
        assertFalse(ok, "former graduator");
        vm.prank(address(cfg));
        (ok,) = address(launchpad).call{value: 1 ether}("");
        assertFalse(ok, "new graduator outside a call");
        assertEq(address(launchpad).balance, 0);

        // Inside its own graduate call the graduator's return is accepted and counted.
        cfg.setGraduateBehaviour(10_000, 0);
        address token = _createMind();
        _complete(alice, token);
        launchpad.graduate(token);
        assertEq(address(launchpad).balance, _liabilities());
    }
}
