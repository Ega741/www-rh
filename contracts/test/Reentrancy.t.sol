// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {MindToken} from "../src/MindToken.sol";
import {IMindCore} from "../src/interfaces/IMindCore.sol";
import {IMindLaunchpad} from "../src/interfaces/IMindLaunchpad.sol";
import {ReentrantReceiver} from "./mocks/ReentrantReceiver.sol";
import {BaseTest} from "./utils/BaseTest.sol";

/// @notice Malicious ETH receivers cannot re-enter any ETH-sending function.
contract ReentrancyTest is BaseTest {
    address internal token;
    ReentrantReceiver internal attacker;

    function setUp() public override {
        super.setUp();
        token = _createMind();
        attacker = new ReentrantReceiver(launchpad);
        vm.deal(address(attacker), 100 ether);
        attacker.configure(token, ReentrantReceiver.Mode.Accept, false);
        attacker.doBuy{value: 1 ether}(0);
    }

    function _assertBlocked() internal view {
        assertFalse(attacker.reentrySucceeded());
        assertEq(bytes4(attacker.reentryError()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
    }

    function test_sell_reenterSellIsBlocked() public {
        uint256 balance = MindToken(token).balanceOf(address(attacker));
        attacker.configure(token, ReentrantReceiver.Mode.ReenterSell, false);
        uint256 ethOut = attacker.doSell(balance / 2);
        assertGt(ethOut, 0);
        assertEq(attacker.receiveCount(), 1);
        _assertBlocked();
        assertEq(MindToken(token).balanceOf(address(attacker)), balance - balance / 2, "only the outer sell executed");
    }

    function test_sell_reentryBubblingFailsTheSell() public {
        uint256 balance = MindToken(token).balanceOf(address(attacker));
        (uint256 reserve, uint256 sold) = _curve(token);
        attacker.configure(token, ReentrantReceiver.Mode.ReenterSell, true);
        vm.expectRevert(IMindCore.EthTransferFailed.selector);
        attacker.doSell(balance / 2);
        (uint256 reserveAfter, uint256 soldAfter) = _curve(token);
        assertEq(reserveAfter, reserve);
        assertEq(soldAfter, sold);
    }

    function test_sell_reenterBuyIsBlocked() public {
        attacker.configure(token, ReentrantReceiver.Mode.ReenterBuy, false);
        attacker.doSell(1e24);
        _assertBlocked();
    }

    function test_completingBuyRefund_reentryIsBlocked() public {
        attacker.configure(token, ReentrantReceiver.Mode.ReenterSell, false);
        attacker.doBuy{value: 10 ether}(0);
        _assertBlocked();
        assertEq(uint8(launchpad.getCurve(token).phase), uint8(IMindLaunchpad.CurvePhase.Complete));

        address token2 = _createMind();
        attacker.configure(token2, ReentrantReceiver.Mode.ReenterGraduate, false);
        attacker.doBuy{value: 10 ether}(0);
        _assertBlocked();
        assertEq(uint8(launchpad.getCurve(token2).phase), uint8(IMindLaunchpad.CurvePhase.Complete));
    }

    function test_drawCompute_reentryIsBlocked() public {
        vm.prank(alice);
        launchpad.fundMind{value: 1 ether}(token);
        attacker.configure(token, ReentrantReceiver.Mode.ReenterDraw, false);
        vm.prank(owner);
        launchpad.setComputeTreasury(address(attacker));
        vm.prank(operator);
        launchpad.drawCompute(token, 0.1 ether, bytes32(0));
        _assertBlocked();
        assertEq(launchpad.mindBalance(token), 0.9 ether + _feeShare());
    }

    function test_withdrawProtocolFees_reentryIsBlocked() public {
        attacker.configure(token, ReentrantReceiver.Mode.ReenterSell, false);
        vm.prank(owner);
        launchpad.withdrawProtocolFees(address(attacker));
        _assertBlocked();
    }

    function _feeShare() internal pure returns (uint256) {
        uint256 fee = 1 ether / 100;
        return fee * 7000 / 10_000;
    }
}
