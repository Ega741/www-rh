// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @notice Test port of the Uniswap v3 core/periphery math needed to model full-range and concentrated positions and
///         exact-input swaps faithfully: TickMath.getSqrtRatioAtTick, LiquidityAmounts.getLiquidityForAmount{0,1,s}
///         / getAmountsForLiquidity, SqrtPriceMath.getAmount{0,1}Delta / getNextSqrtPriceFromInput and
///         SwapMath.computeSwapStep (exact input). Same rounding as the originals.
library UniV3Math {
    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;
    uint256 internal constant Q96 = 1 << 96;

    error TickOutOfRange();
    error ZeroSqrtPrice();

    // ---------------------------------------------------------------------------------------------
    // TickMath
    // ---------------------------------------------------------------------------------------------

    function getSqrtRatioAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        uint256 absTick = SafeCast.toUint256(tick < 0 ? -int256(tick) : int256(tick));
        if (absTick > SafeCast.toUint256(int256(MAX_TICK))) revert TickOutOfRange();
        uint256 ratio =
            absTick & 0x1 != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : 0x100000000000000000000000000000000;
        if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
        if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
        if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
        if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
        if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
        if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
        if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
        if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
        if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
        if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
        if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
        if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
        if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
        if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
        if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
        if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
        if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
        if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
        if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;
        if (tick > 0) ratio = type(uint256).max / ratio;
        // The shifted ratio is below 2^160 for every tick in [MIN_TICK, MAX_TICK] (TickMath invariant).
        // forge-lint: disable-next-line(unsafe-typecast)
        sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
    }

    // ---------------------------------------------------------------------------------------------
    // LiquidityAmounts
    // ---------------------------------------------------------------------------------------------

    function getLiquidityForAmount0(uint160 a, uint160 b, uint256 amount0) internal pure returns (uint128) {
        if (a > b) (a, b) = (b, a);
        uint256 intermediate = Math.mulDiv(a, b, Q96);
        return SafeCast.toUint128(Math.mulDiv(amount0, intermediate, b - a));
    }

    function getLiquidityForAmount1(uint160 a, uint160 b, uint256 amount1) internal pure returns (uint128) {
        if (a > b) (a, b) = (b, a);
        return SafeCast.toUint128(Math.mulDiv(amount1, Q96, b - a));
    }

    function getLiquidityForAmounts(uint160 p, uint160 a, uint160 b, uint256 amount0, uint256 amount1)
        internal
        pure
        returns (uint128 liquidity)
    {
        if (a > b) (a, b) = (b, a);
        if (p <= a) {
            liquidity = getLiquidityForAmount0(a, b, amount0);
        } else if (p < b) {
            uint128 l0 = getLiquidityForAmount0(p, b, amount0);
            uint128 l1 = getLiquidityForAmount1(a, p, amount1);
            liquidity = l0 < l1 ? l0 : l1;
        } else {
            liquidity = getLiquidityForAmount1(a, b, amount1);
        }
    }

    /// @dev Token amounts of `liquidity` in [a, b] at price `p` (rounding up for deposits, down for withdrawals),
    ///      as `UniswapV3Pool._modifyPosition` computes them.
    function getAmountsForLiquidity(uint160 p, uint160 a, uint160 b, uint128 liquidity, bool roundUp)
        internal
        pure
        returns (uint256 amount0, uint256 amount1)
    {
        if (a > b) (a, b) = (b, a);
        if (p <= a) {
            amount0 = getAmount0Delta(a, b, liquidity, roundUp);
        } else if (p < b) {
            amount0 = getAmount0Delta(p, b, liquidity, roundUp);
            amount1 = getAmount1Delta(a, p, liquidity, roundUp);
        } else {
            amount1 = getAmount1Delta(a, b, liquidity, roundUp);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // SqrtPriceMath
    // ---------------------------------------------------------------------------------------------

    function getAmount0Delta(uint160 a, uint160 b, uint128 liquidity, bool roundUp) internal pure returns (uint256) {
        if (a > b) (a, b) = (b, a);
        if (a == 0) revert ZeroSqrtPrice();
        uint256 numerator1 = uint256(liquidity) << 96;
        uint256 numerator2 = b - a;
        return roundUp
            ? Math.ceilDiv(Math.mulDiv(numerator1, numerator2, b, Math.Rounding.Ceil), a)
            : Math.mulDiv(numerator1, numerator2, b) / a;
    }

    function getAmount1Delta(uint160 a, uint160 b, uint128 liquidity, bool roundUp) internal pure returns (uint256) {
        if (a > b) (a, b) = (b, a);
        return roundUp ? Math.mulDiv(liquidity, b - a, Q96, Math.Rounding.Ceil) : Math.mulDiv(liquidity, b - a, Q96);
    }

    /// @dev SqrtPriceMath.getNextSqrtPriceFromAmount0RoundingUp with add = true (token0 in, price down).
    function getNextSqrtPriceFromAmount0RoundingUp(uint160 p, uint128 liquidity, uint256 amount)
        internal
        pure
        returns (uint160)
    {
        if (amount == 0) return p;
        uint256 numerator1 = uint256(liquidity) << 96;
        unchecked {
            uint256 product = amount * p;
            if (product / amount == p) {
                uint256 denominator = numerator1 + product;
                if (denominator >= numerator1) {
                    return SafeCast.toUint160(Math.mulDiv(numerator1, p, denominator, Math.Rounding.Ceil));
                }
            }
        }
        return SafeCast.toUint160(Math.ceilDiv(numerator1, numerator1 / p + amount));
    }

    /// @dev SqrtPriceMath.getNextSqrtPriceFromAmount1RoundingDown with add = true (token1 in, price up).
    function getNextSqrtPriceFromAmount1RoundingDown(uint160 p, uint128 liquidity, uint256 amount)
        internal
        pure
        returns (uint160)
    {
        return SafeCast.toUint160(uint256(p) + Math.mulDiv(amount, Q96, liquidity));
    }

    function getNextSqrtPriceFromInput(uint160 p, uint128 liquidity, uint256 amountIn, bool zeroForOne)
        internal
        pure
        returns (uint160)
    {
        return zeroForOne
            ? getNextSqrtPriceFromAmount0RoundingUp(p, liquidity, amountIn)
            : getNextSqrtPriceFromAmount1RoundingDown(p, liquidity, amountIn);
    }

    // ---------------------------------------------------------------------------------------------
    // SwapMath (exact input)
    // ---------------------------------------------------------------------------------------------

    /// @dev SwapMath.computeSwapStep for `amountRemaining >= 0` (exact input). The fee is taken from the input.
    function computeSwapStep(
        uint160 current,
        uint160 target,
        uint128 liquidity,
        uint256 amountRemaining,
        uint24 feePips
    ) internal pure returns (uint160 next, uint256 amountIn, uint256 amountOut, uint256 feeAmount) {
        bool zeroForOne = current >= target;
        uint256 remainingLessFee = Math.mulDiv(amountRemaining, 1e6 - feePips, 1e6);
        amountIn = zeroForOne
            ? getAmount0Delta(target, current, liquidity, true)
            : getAmount1Delta(current, target, liquidity, true);
        if (remainingLessFee >= amountIn) {
            next = target;
        } else {
            next = getNextSqrtPriceFromInput(current, liquidity, remainingLessFee, zeroForOne);
        }
        bool reachedTarget = next == target;
        if (zeroForOne) {
            if (!reachedTarget) amountIn = getAmount0Delta(next, current, liquidity, true);
            amountOut = getAmount1Delta(next, current, liquidity, false);
        } else {
            if (!reachedTarget) amountIn = getAmount1Delta(current, next, liquidity, true);
            amountOut = getAmount0Delta(current, next, liquidity, false);
        }
        feeAmount = reachedTarget
            ? Math.mulDiv(amountIn, feePips, 1e6 - feePips, Math.Rounding.Ceil)
            : amountRemaining - amountIn;
    }
}
