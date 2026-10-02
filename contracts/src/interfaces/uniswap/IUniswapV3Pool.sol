// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IUniswapV3Pool
/// @notice Minimal subset of the Uniswap v3 pool used by {UniswapV3Graduator}.
interface IUniswapV3Pool {
    /// @notice The 0th storage slot of the pool. `sqrtPriceX96 == 0` means the pool is not initialized.
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function tickSpacing() external view returns (int24);
    function liquidity() external view returns (uint128);

    /// @notice Sets the initial price. Reverts if already initialized.
    function initialize(uint160 sqrtPriceX96) external;
}
