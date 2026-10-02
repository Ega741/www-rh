// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IUniswapV3Factory} from "../../src/interfaces/uniswap/IUniswapV3Factory.sol";
import {MockUniswapV3Pool} from "./MockUniswapV3Pool.sol";

/// @notice Uniswap v3 factory stand-in with the canonical fee tiers (500/10, 3000/60, 10000/200).
contract MockUniswapV3Factory is IUniswapV3Factory {
    mapping(uint24 fee => int24) public feeAmountTickSpacing;
    mapping(address tokenA => mapping(address tokenB => mapping(uint24 fee => address))) public getPool;

    /// @notice Pools created by this factory point their `addLiquidity` hook at this manager.
    address public manager;

    error IdenticalTokens();
    error FeeNotEnabled();
    error PoolExists();

    constructor() {
        feeAmountTickSpacing[500] = 10;
        feeAmountTickSpacing[3000] = 60;
        feeAmountTickSpacing[10_000] = 200;
    }

    /// @notice Sets the position manager allowed to report liquidity to newly created pools.
    function setManager(address manager_) external {
        manager = manager_;
    }

    /// @notice Enables an extra fee tier.
    function enableFeeAmount(uint24 fee, int24 tickSpacing) external {
        feeAmountTickSpacing[fee] = tickSpacing;
    }

    /// @inheritdoc IUniswapV3Factory
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool) {
        if (tokenA == tokenB) revert IdenticalTokens();
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        int24 spacing = feeAmountTickSpacing[fee];
        if (spacing == 0) revert FeeNotEnabled();
        if (getPool[token0][token1][fee] != address(0)) revert PoolExists();
        pool = address(new MockUniswapV3Pool(token0, token1, fee, spacing, manager));
        getPool[token0][token1][fee] = pool;
        getPool[token1][token0][fee] = pool;
    }
}
