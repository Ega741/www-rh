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

    /// @notice Swaps token0 for token1 (`zeroForOne`) or token1 for token0. The caller is paid the output first and
    ///         must pay the input in {IUniswapV3SwapCallback.uniswapV3SwapCallback}.
    /// @param recipient         Receiver of the output.
    /// @param zeroForOne        Direction (true: token0 in, price falls).
    /// @param amountSpecified   Exact input when positive, exact output when negative.
    /// @param sqrtPriceLimitX96 The price cannot move past this value (Q64.96).
    /// @param data              Passed through to the callback.
    /// @return amount0 Delta of token0 owed by (positive) or paid to (negative) the caller.
    /// @return amount1 Delta of token1 owed by (positive) or paid to (negative) the caller.
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/// @title IUniswapV3SwapCallback
/// @notice Callback for {IUniswapV3Pool.swap}: the pool calls it on `msg.sender` after sending the output.
interface IUniswapV3SwapCallback {
    /// @notice Pays the pool. Positive deltas are owed to the pool by the end of the call; zero deltas (a swap that
    ///         only moved the price through a range without liquidity) owe nothing.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}
