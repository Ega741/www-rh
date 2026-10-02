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

/// @notice SPEC §2.6 invariants under random trading (including post-grace sells that reopen Complete curves),
///         graduation, harvesting, funding and draws.
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

    /// @dev `completedAt` is set exactly while the curve is (or was, once graduated) complete; a reopened curve is
    ///      Bonding with `completedAt == 0`.
    function invariant_completedAtMatchesPhase() public view {
        uint256 n = handler.tokensLength();
        for (uint256 i; i < n; ++i) {
            address token = handler.tokens(i);
            IMindLaunchpad.CurvePhase phase = launchpad.getCurve(token).phase;
            uint64 completedAt = launchpad.completedAt(token);
            if (phase == IMindLaunchpad.CurvePhase.Bonding) assertEq(completedAt, 0);
            // forge-lint: disable-next-line(block-timestamp)
            else assertTrue(completedAt != 0 && completedAt <= block.timestamp);
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

    /// @dev Deterministic check that the handler's post-grace sell path works (the fuzzer reaches it randomly).
    function test_handler_postGraceSellReopens() public {
        handler.buy(1, 0, 5 ether); // completes tokens[0]
        address token = handler.tokens(0);
        assertEq(uint8(launchpad.getCurve(token).phase), uint8(IMindLaunchpad.CurvePhase.Complete));
        handler.sell(1, 0, 5000); // still inside the grace: skipped
        assertEq(handler.calls("sellAfterGrace"), 0);
        handler.warpPastGrace(0, 0);
        handler.sell(1, 0, 5000);
        assertEq(handler.calls("sellAfterGrace"), 1);
        assertEq(uint8(launchpad.getCurve(token).phase), uint8(IMindLaunchpad.CurvePhase.Bonding));
        invariant_ethAccountingExact();
        invariant_tokenBalanceWhileBonding();
        invariant_completedAtMatchesPhase();
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
