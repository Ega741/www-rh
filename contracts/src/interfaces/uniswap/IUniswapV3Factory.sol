// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IUniswapV3Factory
/// @notice Minimal subset of the Uniswap v3 factory used by {UniswapV3Graduator}.
interface IUniswapV3Factory {
    /// @notice Returns the pool for the pair/fee, or address(0) if none exists. Order of tokens does not matter.
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);

    /// @notice Tick spacing enabled for `fee`, or 0 if the fee tier is not enabled.
    function feeAmountTickSpacing(uint24 fee) external view returns (int24);

    /// @notice Creates a pool for the pair/fee. Reverts if it already exists.
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
}
