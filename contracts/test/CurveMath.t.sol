// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {CurveMath} from "../src/libraries/CurveMath.sol";
import {BaseTest} from "./utils/BaseTest.sol";

/// @notice Pure curve math: rounding never favours the trader, prices are monotone, completion is exact.
contract CurveMathTest is BaseTest {
    uint256 internal constant MAX_BUY = 100 ether;

    /// @dev A curve state reachable by trading: one buy of `seedBuy` (bounded below completion) followed by a sell
    ///      of `sellBps` of the bought tokens.
    function _state(uint256 seedBuy, uint256 sellBps) internal pure returns (uint256 reserve, uint256 sold) {
        seedBuy = bound(seedBuy, 0, 4 ether);
        sellBps = bound(sellBps, 0, 10_000);
        if (seedBuy == 0) return (0, 0);
        (uint256 out, uint256 used, uint256 fee) = CurveMath.quoteBuy(0, 0, seedBuy, FEE_BPS);
        reserve = used - fee;
        sold = out;
        if (sold == CURVE_SUPPLY) {
            // Keep the state tradable: sell 1 % back.
            sellBps = bound(sellBps, 100, 10_000);
        }
        uint256 tokensIn = sold * sellBps / 10_000;
        if (tokensIn > 0) {
            (uint256 ethOut, uint256 sellFee) = CurveMath.quoteSell(reserve, sold, tokensIn, FEE_BPS);
            reserve -= ethOut + sellFee;
            sold -= tokensIn;
        }
    }

    function _k(uint256 reserve, uint256 sold) internal pure returns (uint256) {
        return (CurveMath.VIRTUAL_ETH + reserve) * (CurveMath.VIRTUAL_TOKENS - sold);
    }

    // ---------------------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------------------

    function test_constants() public pure {
        assertEq(CurveMath.TOTAL_SUPPLY, CurveMath.CURVE_SUPPLY + CurveMath.LP_SUPPLY);
        assertEq(CurveMath.VIRTUAL_ETH, 1.365 ether);
        assertEq(CurveMath.VIRTUAL_TOKENS, 1_073_000_000e18);
    }

    function test_completesAtFourEthNet() public pure {
        // Without fees the curve sells out after exactly 1.365 * 800 / 273 = 4 ETH.
        assertEq(CurveMath.minEthToComplete(0, 0, 0), 4 ether);
        uint256 withFee = CurveMath.minEthToComplete(0, 0, FEE_BPS);
        (uint256 out, uint256 used, uint256 fee) = CurveMath.quoteBuy(0, 0, withFee, FEE_BPS);
        assertEq(out, CURVE_SUPPLY);
        assertEq(used - fee, 4 ether);
        assertApproxEqAbs(withFee, 4.0404 ether, 0.0001 ether);
    }

    function test_initialAndFinalPrice() public pure {
        // x0 / y0 = 1.365 / 1.073e9 ETH per token.
        assertEq(CurveMath.price(0, 0), uint256(1.365 ether) * 1e18 / 1_073_000_000e18);
        // Final price = 5.365 / 2.73e8 ETH per token ~ 1.965e-8 ETH.
        assertApproxEqRel(CurveMath.price(4 ether, CURVE_SUPPLY), 19_652_014_652, 1e12);
        assertEq(CurveMath.marketCap(0, 0), CurveMath.price(0, 0) * 1e9);
        assertEq(CurveMath.progressBps(CURVE_SUPPLY / 2), 5000);
    }

    // ---------------------------------------------------------------------------------------------
    // Rounding: the trader never profits from a round trip
    // ---------------------------------------------------------------------------------------------

    function testFuzz_buyThenSellNeverProfits(uint256 seedBuy, uint256 sellBps, uint256 ethIn) public pure {
        (uint256 reserve, uint256 sold) = _state(seedBuy, sellBps);
        ethIn = bound(ethIn, 1, MAX_BUY);
        (uint256 tokensOut, uint256 ethUsed, uint256 fee) = CurveMath.quoteBuy(reserve, sold, ethIn, FEE_BPS);
        vm.assume(tokensOut > 0);
        uint256 r1 = reserve + ethUsed - fee;
        uint256 s1 = sold + tokensOut;
        (uint256 ethOut,) = CurveMath.quoteSell(r1, s1, tokensOut, FEE_BPS);
        assertLe(ethOut, ethUsed, "round trip profit");
        // Even without fees the curve itself never pays back more than it took.
        (uint256 tokensOut0, uint256 ethUsed0,) = CurveMath.quoteBuy(reserve, sold, ethIn, 0);
        (uint256 ethOut0,) = CurveMath.quoteSell(reserve + ethUsed0, sold + tokensOut0, tokensOut0, 0);
        assertLe(ethOut0, ethUsed0, "fee-less round trip profit");
    }

    function testFuzz_sellThenBuyNeverProfits(uint256 seedBuy, uint256 sellBps, uint256 tokensBps) public pure {
        (uint256 reserve, uint256 sold) = _state(seedBuy, sellBps);
        vm.assume(sold > 0);
        uint256 tokensIn = bound(tokensBps, 1, 10_000) * sold / 10_000;
        vm.assume(tokensIn > 0);
        (uint256 ethOut, uint256 fee) = CurveMath.quoteSell(reserve, sold, tokensIn, FEE_BPS);
        vm.assume(ethOut > 0);
        uint256 r1 = reserve - ethOut - fee;
        uint256 s1 = sold - tokensIn;
        (uint256 tokensBack,,) = CurveMath.quoteBuy(r1, s1, ethOut, FEE_BPS);
        assertLe(tokensBack, tokensIn, "round trip profit");
    }

    function testFuzz_kNeverDecreases(uint256 seedBuy, uint256 sellBps, uint256 ethIn, uint256 tokensBps)
        public
        pure
    {
        (uint256 reserve, uint256 sold) = _state(seedBuy, sellBps);
        uint256 k0 = _k(reserve, sold);
        assertGe(k0, CurveMath.VIRTUAL_ETH * CurveMath.VIRTUAL_TOKENS);
        ethIn = bound(ethIn, 1, MAX_BUY);
        (uint256 out, uint256 used, uint256 fee) = CurveMath.quoteBuy(reserve, sold, ethIn, FEE_BPS);
        assertGe(_k(reserve + used - fee, sold + out), k0, "buy decreased k");
        if (sold > 0) {
            uint256 tokensIn = bound(tokensBps, 1, 10_000) * sold / 10_000;
            (uint256 ethOut, uint256 sellFee) = CurveMath.quoteSell(reserve, sold, tokensIn, FEE_BPS);
            assertGe(_k(reserve - ethOut - sellFee, sold - tokensIn), k0, "sell decreased k");
        }
    }

    function testFuzz_sellNeverExceedsReserve(uint256 seedBuy, uint256 sellBps) public pure {
        (uint256 reserve, uint256 sold) = _state(seedBuy, sellBps);
        (uint256 ethOut, uint256 fee) = CurveMath.quoteSell(reserve, sold, sold, FEE_BPS);
        assertLe(ethOut + fee, reserve);
    }

    // ---------------------------------------------------------------------------------------------
    // Monotonicity
    // ---------------------------------------------------------------------------------------------

    function testFuzz_priceMonotone(uint256 seedBuy, uint256 sellBps, uint256 ethIn, uint256 tokensBps) public pure {
        (uint256 reserve, uint256 sold) = _state(seedBuy, sellBps);
        uint256 p0 = CurveMath.price(reserve, sold);
        ethIn = bound(ethIn, 1, MAX_BUY);
        (uint256 out, uint256 used, uint256 fee) = CurveMath.quoteBuy(reserve, sold, ethIn, FEE_BPS);
        assertGe(CurveMath.price(reserve + used - fee, sold + out), p0, "buy lowered price");
        if (sold > 0) {
            uint256 tokensIn = bound(tokensBps, 1, 10_000) * sold / 10_000;
            (uint256 ethOut, uint256 sellFee) = CurveMath.quoteSell(reserve, sold, tokensIn, FEE_BPS);
            assertLe(CurveMath.price(reserve - ethOut - sellFee, sold - tokensIn), p0, "sell raised price");
        }
    }

    function testFuzz_quoteBuyMonotoneInEthIn(uint256 seedBuy, uint256 sellBps, uint256 ethIn) public pure {
        (uint256 reserve, uint256 sold) = _state(seedBuy, sellBps);
        ethIn = bound(ethIn, 1, MAX_BUY);
        (uint256 a,,) = CurveMath.quoteBuy(reserve, sold, ethIn, FEE_BPS);
        (uint256 b,,) = CurveMath.quoteBuy(reserve, sold, ethIn + 1, FEE_BPS);
        assertGe(b, a);
    }

    function testFuzz_quoteSellMonotoneInTokensIn(uint256 seedBuy, uint256 sellBps, uint256 tokensIn) public pure {
        (uint256 reserve, uint256 sold) = _state(seedBuy, sellBps);
        vm.assume(sold > 1);
        tokensIn = bound(tokensIn, 1, sold - 1);
        (uint256 a,) = CurveMath.quoteSell(reserve, sold, tokensIn, FEE_BPS);
        (uint256 b,) = CurveMath.quoteSell(reserve, sold, tokensIn + 1, FEE_BPS);
        assertGe(b, a);
    }

    // ---------------------------------------------------------------------------------------------
    // Completion
    // ---------------------------------------------------------------------------------------------

    function testFuzz_quoteBuyBounds(uint256 seedBuy, uint256 sellBps, uint256 ethIn, uint16 feeBps) public pure {
        (uint256 reserve, uint256 sold) = _state(seedBuy, sellBps);
        ethIn = bound(ethIn, 1, MAX_BUY);
        uint256 f = bound(feeBps, 0, 500);
        (uint256 out, uint256 used, uint256 fee) = CurveMath.quoteBuy(reserve, sold, ethIn, f);
        assertLe(out, CURVE_SUPPLY - sold, "over the curve supply");
        assertLe(used, ethIn, "charged more than sent");
        assertLe(fee, used, "fee above ethUsed");
        if (out < CURVE_SUPPLY - sold) {
            assertEq(used, ethIn, "partial buy must use everything");
            assertEq(fee, ethIn * f / 10_000);
        }
    }

    function testFuzz_minEthToCompleteIsExact(uint256 seedBuy, uint256 sellBps, uint16 feeBps) public pure {
        (uint256 reserve, uint256 sold) = _state(seedBuy, sellBps);
        vm.assume(sold < CURVE_SUPPLY);
        uint256 f = bound(feeBps, 0, 500);
        uint256 minEth = CurveMath.minEthToComplete(reserve, sold, f);
        (uint256 out, uint256 used, uint256 fee) = CurveMath.quoteBuy(reserve, sold, minEth, f);
        assertEq(out, CURVE_SUPPLY - sold, "minimal amount must complete");
        assertEq(used, minEth, "minimal amount leaves no refund");
        // The reserve lands exactly on the minimal completing net amount.
        uint256 x = CurveMath.VIRTUAL_ETH + reserve;
        uint256 y = CurveMath.VIRTUAL_TOKENS - sold;
        assertEq(used - fee, Math.ceilDiv(x * y, y - (CURVE_SUPPLY - sold)) - x);
        (uint256 outLess,,) = CurveMath.quoteBuy(reserve, sold, minEth - 1, f);
        assertLt(outLess, CURVE_SUPPLY - sold, "one wei less must not complete");
    }

    function testFuzz_completingBuyRefundsExcess(uint256 seedBuy, uint256 sellBps, uint256 extra) public pure {
        (uint256 reserve, uint256 sold) = _state(seedBuy, sellBps);
        vm.assume(sold < CURVE_SUPPLY);
        uint256 minEth = CurveMath.minEthToComplete(reserve, sold, FEE_BPS);
        extra = bound(extra, 1, MAX_BUY);
        (uint256 outMin, uint256 usedMin, uint256 feeMin) = CurveMath.quoteBuy(reserve, sold, minEth, FEE_BPS);
        (uint256 out, uint256 used, uint256 fee) = CurveMath.quoteBuy(reserve, sold, minEth + extra, FEE_BPS);
        assertEq(out, outMin);
        // Paying more never moves the reserve beyond the minimal completing net amount.
        assertEq(used - fee, usedMin - feeMin);
        assertLe(used, minEth + extra);
        assertEq(used, CurveMath.ethForTokens(reserve, sold, CURVE_SUPPLY - sold, FEE_BPS));
    }

    function test_roundingGuardAtMinimalCompletingAmount() public pure {
        (bool found, uint256 seed, uint256 minEth) = _findGuardState(1 ether, 1, 50);
        assertTrue(found, "no guard state found");
        (uint256 out0,, uint256 fee0) = CurveMath.quoteBuy(0, 0, seed, FEE_BPS);
        uint256 reserve = seed - fee0;
        uint256 grossUp = CurveMath.ethForTokens(reserve, out0, CURVE_SUPPLY - out0, FEE_BPS);
        assertEq(grossUp, minEth + 1, "gross-up exceeds the minimal amount by 1 wei");
        (uint256 out, uint256 used, uint256 fee) = CurveMath.quoteBuy(reserve, out0, minEth, FEE_BPS);
        assertEq(out, CURVE_SUPPLY - out0);
        assertEq(used, minEth, "guard clamps ethUsed to ethIn");
        assertEq(fee, minEth * FEE_BPS / 10_000, "fee absorbs the clamp");
    }

    function testFuzz_ethForTokensBuysAtLeastThatMany(uint256 seedBuy, uint256 sellBps, uint256 tokensBps)
        public
        pure
    {
        (uint256 reserve, uint256 sold) = _state(seedBuy, sellBps);
        vm.assume(sold < CURVE_SUPPLY);
        uint256 want = bound(tokensBps, 1, 10_000) * (CURVE_SUPPLY - sold) / 10_000;
        vm.assume(want > 0);
        uint256 ethIn = CurveMath.ethForTokens(reserve, sold, want, FEE_BPS);
        (uint256 out,,) = CurveMath.quoteBuy(reserve, sold, ethIn, FEE_BPS);
        assertGe(out, want);
    }

    function testFuzz_splitFee(uint256 fee, uint16 shareBps) public pure {
        fee = bound(fee, 0, 1e30);
        uint256 share = bound(shareBps, 0, 10_000);
        (uint256 mindAmount, uint256 protocolAmount) = CurveMath.splitFee(fee, share);
        assertEq(mindAmount + protocolAmount, fee);
        assertEq(mindAmount, fee * share / 10_000);
    }
}
