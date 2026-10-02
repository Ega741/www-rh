// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AuditUniV3Math as M} from "./mocks/AuditUniV3Math.sol";

/// @notice Sanity checks that the audit port of TickMath reproduces the canonical Uniswap v3 constants, so the
///         realistic PoC mocks built on it are trustworthy.
contract AuditUniV3MathTest is Test {
    function test_tickMathMatchesCanonicalConstants() public pure {
        assertEq(M.getSqrtRatioAtTick(M.MIN_TICK), M.MIN_SQRT_RATIO);
        assertEq(M.getSqrtRatioAtTick(M.MAX_TICK), M.MAX_SQRT_RATIO);
        assertEq(M.getSqrtRatioAtTick(0), uint160(1 << 96));
    }
}
