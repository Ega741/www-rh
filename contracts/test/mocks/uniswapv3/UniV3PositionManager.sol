// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {INonfungiblePositionManager} from "../../../src/interfaces/uniswap/INonfungiblePositionManager.sol";
import {IUniswapV3Factory} from "../../../src/interfaces/uniswap/IUniswapV3Factory.sol";
import {IUniswapV3Pool} from "../../../src/interfaces/uniswap/IUniswapV3Pool.sol";
import {UniV3Math as M} from "./UniV3Math.sol";
import {UniV3Pool} from "./UniV3Pool.sol";

/// @notice NonfungiblePositionManager model following v3-periphery: `createAndInitializePoolIfNecessary` creates
///         and/or initializes the pool only when needed (an initialized pool keeps its price); `mint` validates the
///         ticks, computes `LiquidityAmounts.getLiquidityForAmounts` at slot0's price, adds the position to the pool,
///         applies the "Price slippage check" against the minimums and pulls exactly the owed amounts. NFTs are
///         recorded with `_mint` semantics (no receiver callback). `collect` pays the position's swap fees plus
///         fees seeded with {accrueFees}; {burnAll} is a test shortcut for decreaseLiquidity + collect.
contract UniV3PositionManager is INonfungiblePositionManager {
    using SafeERC20 for IERC20;

    struct Position {
        address owner;
        address pool;
        uint256 rangeId;
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint128 owed0; // seeded with accrueFees
        uint128 owed1;
    }

    IUniswapV3Factory public immutable factory;
    uint256 public nextId = 1;
    mapping(uint256 tokenId => Position) internal _positions;

    event Minted(
        uint256 indexed tokenId, address indexed recipient, uint128 liquidity, uint256 amount0, uint256 amount1
    );

    error UnorderedTokens();
    error PoolMissing();
    error PoolNotInitialized();
    error InvalidTicks();
    error Expired();
    error PriceSlippageCheck();
    error NotOwner();

    constructor(address factory_) {
        factory = IUniswapV3Factory(factory_);
    }

    /// @inheritdoc INonfungiblePositionManager
    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)
        external
        payable
        returns (address pool)
    {
        if (token0 >= token1) revert UnorderedTokens();
        pool = factory.getPool(token0, token1, fee);
        if (pool == address(0)) {
            pool = factory.createPool(token0, token1, fee);
            IUniswapV3Pool(pool).initialize(sqrtPriceX96);
        } else {
            (uint160 current,,,,,,) = IUniswapV3Pool(pool).slot0();
            if (current == 0) IUniswapV3Pool(pool).initialize(sqrtPriceX96);
        }
    }

    /// @inheritdoc INonfungiblePositionManager
    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > params.deadline) revert Expired();
        if (params.token0 >= params.token1) revert UnorderedTokens();
        address pool = factory.getPool(params.token0, params.token1, params.fee);
        if (pool == address(0)) revert PoolMissing();
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(pool).slot0();
        if (sqrtPriceX96 == 0) revert PoolNotInitialized();
        int24 spacing = IUniswapV3Pool(pool).tickSpacing();
        if (
            params.tickLower >= params.tickUpper || params.tickLower < M.MIN_TICK || params.tickUpper > M.MAX_TICK
                || params.tickLower % spacing != 0 || params.tickUpper % spacing != 0
        ) revert InvalidTicks();

        uint160 a = M.getSqrtRatioAtTick(params.tickLower);
        uint160 b = M.getSqrtRatioAtTick(params.tickUpper);
        liquidity = M.getLiquidityForAmounts(sqrtPriceX96, a, b, params.amount0Desired, params.amount1Desired);
        uint256 rangeId;
        (rangeId, amount0, amount1) = UniV3Pool(pool).mintRange(a, b, liquidity);
        if (amount0 < params.amount0Min || amount1 < params.amount1Min) revert PriceSlippageCheck();
        if (amount0 > 0) IERC20(params.token0).safeTransferFrom(msg.sender, pool, amount0);
        if (amount1 > 0) IERC20(params.token1).safeTransferFrom(msg.sender, pool, amount1);

        tokenId = nextId++;
        _positions[tokenId] = Position({
            owner: params.recipient,
            pool: pool,
            rangeId: rangeId,
            token0: params.token0,
            token1: params.token1,
            fee: params.fee,
            tickLower: params.tickLower,
            tickUpper: params.tickUpper,
            liquidity: liquidity,
            owed0: 0,
            owed1: 0
        });
        emit Minted(tokenId, params.recipient, liquidity, amount0, amount1);
    }

    /// @inheritdoc INonfungiblePositionManager
    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1) {
        Position storage p = _positions[params.tokenId];
        if (msg.sender != p.owner) revert NotOwner();
        (amount0, amount1) =
            UniV3Pool(p.pool).collectRange(p.rangeId, params.recipient, params.amount0Max, params.amount1Max);
        uint256 seeded0 = Math.min(p.owed0, params.amount0Max - amount0);
        uint256 seeded1 = Math.min(p.owed1, params.amount1Max - amount1);
        // Both are capped by the uint128 owed values above.
        // forge-lint: disable-next-line(unsafe-typecast)
        p.owed0 -= uint128(seeded0);
        // forge-lint: disable-next-line(unsafe-typecast)
        p.owed1 -= uint128(seeded1);
        if (seeded0 > 0) IERC20(p.token0).safeTransfer(params.recipient, seeded0);
        if (seeded1 > 0) IERC20(p.token1).safeTransfer(params.recipient, seeded1);
        amount0 += seeded0;
        amount1 += seeded1;
    }

    /// @inheritdoc INonfungiblePositionManager
    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        )
    {
        Position storage p = _positions[tokenId];
        return (0, address(0), p.token0, p.token1, p.fee, p.tickLower, p.tickUpper, p.liquidity, 0, 0, p.owed0, p.owed1);
    }

    /// @notice Owner of a position.
    function ownerOf(uint256 tokenId) external view returns (address) {
        return _positions[tokenId].owner;
    }

    /// @notice Pool of a position.
    function poolOf(uint256 tokenId) external view returns (address) {
        return _positions[tokenId].pool;
    }

    /// @notice Test helper: pulls `amount0`/`amount1` of the position's tokens from the caller and makes them
    ///         collectable as fees.
    function accrueFees(uint256 tokenId, uint128 amount0, uint128 amount1) external {
        Position storage p = _positions[tokenId];
        if (amount0 > 0) IERC20(p.token0).safeTransferFrom(msg.sender, address(this), amount0);
        if (amount1 > 0) IERC20(p.token1).safeTransferFrom(msg.sender, address(this), amount1);
        p.owed0 += amount0;
        p.owed1 += amount1;
    }

    /// @notice Test helper (decreaseLiquidity(all) + collect(principal)): the owner withdraws the position's
    ///         liquidity at the current price to `recipient`. Fees stay collectable with {collect}.
    function burnAll(uint256 tokenId, address recipient) external returns (uint256 amount0, uint256 amount1) {
        Position storage p = _positions[tokenId];
        if (msg.sender != p.owner) revert NotOwner();
        p.liquidity = 0;
        return UniV3Pool(p.pool).burnRange(p.rangeId, recipient);
    }
}
