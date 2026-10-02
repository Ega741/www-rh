// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";

import {MindLaunchpad} from "../../src/MindLaunchpad.sol";
import {MindToken} from "../../src/MindToken.sol";
import {IMindLaunchpad} from "../../src/interfaces/IMindLaunchpad.sol";
import {CurveMath} from "../../src/libraries/CurveMath.sol";
import {ConfigurableGraduator} from "../mocks/ConfigurableGraduator.sol";
import {LaunchpadHandler} from "./LaunchpadHandler.sol";

/// @notice SPEC §2.6 invariants under random trading, graduation, harvesting, funding and draws.
contract LaunchpadInvariantsTest is StdInvariant, Test {
    MindLaunchpad internal launchpad;
    ConfigurableGraduator internal graduator;
    LaunchpadHandler internal handler;

    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");

    function setUp() public {
        vm.warp(1_750_000_000);
        launchpad = new MindLaunchpad(owner, makeAddr("treasury"), makeAddr("computeTreasury"), operator);
        graduator = new ConfigurableGraduator(address(launchpad));
        vm.prank(owner);
        launchpad.setGraduator(address(graduator));
        handler = new LaunchpadHandler(launchpad, graduator, owner, operator);
        targetContract(address(handler));
    }

    /// @dev launchpad.balance >= Σ realEthReserve + Σ mindBalance + protocolBalance.
    function invariant_ethSolvency() public view {
        assertGe(address(launchpad).balance, _liabilities());
    }

    /// @dev Nothing sends unaccounted ETH in this setup, so the balance matches the liabilities exactly.
    function invariant_ethAccountingExact() public view {
        assertEq(address(launchpad).balance, _liabilities());
    }

    /// @dev While Bonding, the launchpad holds exactly TOTAL_SUPPLY - tokensSold of the coin.
    function invariant_tokenBalanceWhileBonding() public view {
        uint256 n = handler.tokensLength();
        for (uint256 i; i < n; ++i) {
            address token = handler.tokens(i);
            IMindLaunchpad.CurveState memory c = launchpad.getCurve(token);
            if (c.phase == IMindLaunchpad.CurvePhase.Bonding) {
                assertEq(MindToken(token).balanceOf(address(launchpad)), CurveMath.TOTAL_SUPPLY - c.tokensSold);
                assertLt(c.tokensSold, CurveMath.CURVE_SUPPLY);
            } else if (c.phase == IMindLaunchpad.CurvePhase.Complete) {
                assertEq(c.tokensSold, CurveMath.CURVE_SUPPLY);
                assertEq(MindToken(token).balanceOf(address(launchpad)), CurveMath.LP_SUPPLY);
            } else {
                assertEq(c.realEthReserve, 0);
                assertEq(MindToken(token).balanceOf(address(launchpad)), 0);
                assertEq(launchpad.graduatorOf(token), address(graduator));
            }
        }
    }

    /// @dev Rounding always favours the curve: k = x * y never decreases.
    function invariant_kNeverDecreases() public view {
        assertFalse(handler.kDecreased());
    }

    /// @dev The per-epoch draw cap is never exceeded.
    function invariant_drawCap() public view {
        (uint256 maxPerEpoch,) = launchpad.drawLimit();
        uint256 n = handler.tokensLength();
        for (uint256 i; i < n; ++i) {
            (uint256 drawn,) = launchpad.drawnInEpoch(handler.tokens(i));
            assertLe(drawn, maxPerEpoch);
        }
    }

    function _liabilities() internal view returns (uint256 total) {
        total = launchpad.protocolBalance();
        uint256 n = handler.tokensLength();
        for (uint256 i; i < n; ++i) {
            address token = handler.tokens(i);
            total += launchpad.getCurve(token).realEthReserve + launchpad.mindBalance(token);
        }
        assertEq(n, launchpad.mindsLength());
    }
}
