// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IUniswapV3Factory} from "../../../src/interfaces/uniswap/IUniswapV3Factory.sol";
import {UniV3Pool} from "./UniV3Pool.sol";

/// @notice Uniswap v3 factory model: canonical fee tiers (500/10, 3000/60, 10000/200) and a permissionless
///         `createPool` (no code check on the tokens, anyone may create any pair, like the real factory). Pools
///         accept positions from the position manager set with {setManager}.
contract UniV3Factory is IUniswapV3Factory {
    mapping(uint24 fee => int24) public feeAmountTickSpacing;
    mapping(address tokenA => mapping(address tokenB => mapping(uint24 fee => address))) public getPool;
    address public manager;

    error IdenticalTokens();
    error FeeNotEnabled();
    error PoolExists();

    constructor() {
        feeAmountTickSpacing[500] = 10;
        feeAmountTickSpacing[3000] = 60;
        feeAmountTickSpacing[10_000] = 200;
    }

    /// @notice Sets the position manager allowed to mint/burn positions in newly created pools.
    function setManager(address manager_) external {
        manager = manager_;
    }

    /// @inheritdoc IUniswapV3Factory
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool) {
        if (tokenA == tokenB) revert IdenticalTokens();
        int24 spacing = feeAmountTickSpacing[fee];
        if (spacing == 0) revert FeeNotEnabled();
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        if (getPool[token0][token1][fee] != address(0)) revert PoolExists();
        pool = address(new UniV3Pool(token0, token1, fee, spacing, manager));
        getPool[token0][token1][fee] = pool;
        getPool[token1][token0][fee] = pool;
    }
}
