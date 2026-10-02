// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IUniswapV3Pool} from "../../src/interfaces/uniswap/IUniswapV3Pool.sol";

/// @notice Uniswap v3 pool stand-in: stores the pair, fee, spacing and a settable price (`slot0`/`initialize`).
///         Tokens deposited by the mock position manager simply sit here.
contract MockUniswapV3Pool is IUniswapV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    uint128 public liquidity;

    uint160 internal _sqrtPriceX96;
    address internal immutable _manager;

    error AlreadyInitialized();
    error InvalidPrice();
    error NotManager();

    constructor(address token0_, address token1_, uint24 fee_, int24 tickSpacing_, address manager_) {
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
        tickSpacing = tickSpacing_;
        _manager = manager_;
    }

    /// @inheritdoc IUniswapV3Pool
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (_sqrtPriceX96, 0, 0, 1, 1, 0, true);
    }

    /// @inheritdoc IUniswapV3Pool
    function initialize(uint160 sqrtPriceX96) external {
        if (_sqrtPriceX96 != 0) revert AlreadyInitialized();
        if (sqrtPriceX96 == 0) revert InvalidPrice();
        _sqrtPriceX96 = sqrtPriceX96;
    }

    /// @notice Called by the mock position manager when it mints a position.
    function addLiquidity(uint128 amount) external {
        if (msg.sender != _manager) revert NotManager();
        liquidity += amount;
    }
}
