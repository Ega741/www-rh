// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IPriceSource
/// @notice Minimal USD price oracle for the credit token, consumed by `CreditDesk`.
interface IPriceSource {
    /// @notice Latest observed price of one whole token in USD.
    /// @return priceE18 USD per 1 whole token scaled by 1e18; `0` means unavailable.
    /// @return updatedAt Unix time of the observation.
    function latestPrice() external view returns (uint256 priceE18, uint256 updatedAt);
}
