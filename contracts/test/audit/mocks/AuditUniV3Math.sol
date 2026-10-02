// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Audit-only port of the Uniswap v3 core/periphery math needed to model a full-range position and swaps
///         faithfully: TickMath.getSqrtRatioAtTick, LiquidityAmounts.getLiquidityForAmount{0,1,s},
///         SqrtPriceMath.getAmount{0,1}Delta and the next-price helpers. Only used by test/audit PoCs.
library AuditUniV3Math {
    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;
    uint256 internal constant Q96 = 1 << 96;

    error TickOutOfRange();
    error Uint128Overflow();

    function getSqrtRatioAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
        if (absTick > uint256(int256(MAX_TICK))) revert TickOutOfRange();
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
        sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
    }

    function _toUint128(uint256 x) private pure returns (uint128 y) {
        if (x > type(uint128).max) revert Uint128Overflow();
        y = uint128(x);
    }

    function getLiquidityForAmount0(uint160 a, uint160 b, uint256 amount0) internal pure returns (uint128) {
        if (a > b) (a, b) = (b, a);
        uint256 intermediate = Math.mulDiv(a, b, Q96);
        return _toUint128(Math.mulDiv(amount0, intermediate, b - a));
    }

    function getLiquidityForAmount1(uint160 a, uint160 b, uint256 amount1) internal pure returns (uint128) {
        if (a > b) (a, b) = (b, a);
        return _toUint128(Math.mulDiv(amount1, Q96, b - a));
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

    function getAmount0Delta(uint160 a, uint160 b, uint128 liquidity, bool roundUp) internal pure returns (uint256) {
        if (a > b) (a, b) = (b, a);
        uint256 numerator1 = uint256(liquidity) << 96;
        uint256 numerator2 = b - a;
        return roundUp
            ? Math.ceilDiv(Math.mulDiv(numerator1, numerator2, b, Math.Rounding.Ceil), a)
            : Math.mulDiv(numerator1, numerator2, b) / a;
    }

    function getAmount1Delta(uint160 a, uint160 b, uint128 liquidity, bool roundUp) internal pure returns (uint256) {
        if (a > b) (a, b) = (b, a);
        return roundUp
            ? Math.mulDiv(liquidity, b - a, Q96, Math.Rounding.Ceil)
            : Math.mulDiv(liquidity, b - a, Q96);
    }

    /// @dev SqrtPriceMath.getNextSqrtPriceFromAmount0RoundingUp with add = true (token0 in, price down).
    function nextSqrtPriceFromAmount0In(uint160 p, uint128 liquidity, uint256 amount) internal pure returns (uint160) {
        uint256 numerator1 = uint256(liquidity) << 96;
        return uint160(Math.mulDiv(numerator1, p, numerator1 + amount * p, Math.Rounding.Ceil));
    }

    /// @dev SqrtPriceMath.getNextSqrtPriceFromAmount1RoundingDown with add = true (token1 in, price up).
    function nextSqrtPriceFromAmount1In(uint160 p, uint128 liquidity, uint256 amount) internal pure returns (uint160) {
        return uint160(uint256(p) + Math.mulDiv(amount, Q96, liquidity));
    }
}
