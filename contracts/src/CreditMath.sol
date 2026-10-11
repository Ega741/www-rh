// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title CreditMath
/// @notice Integer-only conversion between raw token amounts and micro-dollars (µUSD, 1 USD = 1e6 µUSD).
/// @dev `priceE18` is USD per one whole token scaled by 1e18. With `S = 10**(decimals + 12)`:
///      `usdMicro = floor(amount * priceE18 / S)` and `tokens = ceil(usdMicro * S / priceE18)`.
///      Both use `Math.mulDiv`, so the 512-bit intermediate product never overflows; only a result
///      that does not fit in 256 bits reverts. Callers MUST guarantee `decimals <= 36`.
library CreditMath {
    /// @notice Thrown by {tokensForUsdMicro} when `priceE18 == 0` (no price → no inverse quote).
    error ZeroPrice();

    /// @notice Quote a raw token amount in µUSD, rounding down.
    /// @param amount Raw token units (`decimals` of the token).
    /// @param priceE18 USD per whole token, scaled by 1e18.
    /// @param decimals Token decimals (≤ 36).
    /// @return usdMicro `floor(amount * priceE18 / 10**(decimals + 12))`.
    function usdMicro(uint256 amount, uint256 priceE18, uint8 decimals) internal pure returns (uint256) {
        return Math.mulDiv(amount, priceE18, _scale(decimals));
    }

    /// @notice Inverse quote: the smallest raw token amount worth at least `usdMicro_`.
    /// @param usdMicro_ Target value in µUSD.
    /// @param priceE18 USD per whole token, scaled by 1e18; MUST be non-zero.
    /// @param decimals Token decimals (≤ 36).
    /// @return tokens `ceil(usdMicro_ * 10**(decimals + 12) / priceE18)`.
    function tokensForUsdMicro(uint256 usdMicro_, uint256 priceE18, uint8 decimals) internal pure returns (uint256) {
        if (priceE18 == 0) revert ZeroPrice();
        return Math.mulDiv(usdMicro_, _scale(decimals), priceE18, Math.Rounding.Ceil);
    }

    /// @dev `10**(decimals + 12)`; fits in uint256 for `decimals <= 36` (max 1e48).
    function _scale(uint8 decimals) private pure returns (uint256) {
        return 10 ** (uint256(decimals) + 12);
    }
}
