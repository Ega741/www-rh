// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {INonfungiblePositionManager} from "../../src/interfaces/uniswap/INonfungiblePositionManager.sol";
import {IUniswapV3Factory} from "../../src/interfaces/uniswap/IUniswapV3Factory.sol";
import {IUniswapV3Pool} from "../../src/interfaces/uniswap/IUniswapV3Pool.sol";
import {MockUniswapV3Pool} from "./MockUniswapV3Pool.sol";

/// @notice Position manager stand-in. `mint` uses the pool's current price to decide how much of each token a
///         full-range position takes (the side in excess is left with the caller), pulls those amounts into the
///         pool and mints an incrementing position id. `collect` pays fees seeded with {accrueFees}.
contract MockNonfungiblePositionManager is INonfungiblePositionManager {
    using SafeERC20 for IERC20;

    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;
    uint256 internal constant Q96 = 1 << 96;

    struct Position {
        address owner;
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint128 owed0;
        uint128 owed1;
    }

    IUniswapV3Factory public immutable factory;
    uint256 public nextId = 1;
    mapping(uint256 tokenId => Position) internal _positions;

    event Minted(uint256 indexed tokenId, address indexed recipient, uint256 amount0, uint256 amount1);

    error UnorderedTokens();
    error PoolMissing();
    error PoolNotInitialized();
    error InvalidTicks();
    error Expired();
    error MinAmounts();
    error NotOwner();
    error ZeroLiquidity();

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
            params.tickLower >= params.tickUpper || params.tickLower < MIN_TICK || params.tickUpper > MAX_TICK
                || params.tickLower % spacing != 0 || params.tickUpper % spacing != 0
        ) revert InvalidTicks();

        (amount0, amount1) = _amountsAtPrice(sqrtPriceX96, params.amount0Desired, params.amount1Desired);
        if (amount0 < params.amount0Min || amount1 < params.amount1Min) revert MinAmounts();
        // Liquidity is only bookkeeping here; a one-sided deposit (price at the range edge) still counts.
        uint256 l = Math.sqrt(amount0 * amount1);
        if (l == 0) l = Math.max(amount0, amount1);
        if (l == 0) revert ZeroLiquidity();
        liquidity = uint128(Math.min(l, type(uint128).max));

        IERC20(params.token0).safeTransferFrom(msg.sender, pool, amount0);
        IERC20(params.token1).safeTransferFrom(msg.sender, pool, amount1);
        MockUniswapV3Pool(pool).addLiquidity(liquidity);

        tokenId = nextId++;
        _positions[tokenId] = Position({
            owner: params.recipient,
            token0: params.token0,
            token1: params.token1,
            fee: params.fee,
            tickLower: params.tickLower,
            tickUpper: params.tickUpper,
            liquidity: liquidity,
            owed0: 0,
            owed1: 0
        });
        emit Minted(tokenId, params.recipient, amount0, amount1);
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

    /// @inheritdoc INonfungiblePositionManager
    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1) {
        Position storage p = _positions[params.tokenId];
        if (msg.sender != p.owner) revert NotOwner();
        amount0 = Math.min(p.owed0, params.amount0Max);
        amount1 = Math.min(p.owed1, params.amount1Max);
        // Both amounts are capped by the uint128 owed values above.
        // forge-lint: disable-next-line(unsafe-typecast)
        p.owed0 -= uint128(amount0);
        // forge-lint: disable-next-line(unsafe-typecast)
        p.owed1 -= uint128(amount1);
        if (amount0 > 0) IERC20(p.token0).safeTransfer(params.recipient, amount0);
        if (amount1 > 0) IERC20(p.token1).safeTransfer(params.recipient, amount1);
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

    /// @dev Full-range deposit at price `P = (sqrtPriceX96 / 2^96)^2` (token1 per token0): the side in excess of
    ///      `P` is only partially used.
    function _amountsAtPrice(uint160 sqrtPriceX96, uint256 desired0, uint256 desired1)
        internal
        pure
        returns (uint256 amount0, uint256 amount1)
    {
        uint256 needed1 = Math.mulDiv(Math.mulDiv(desired0, sqrtPriceX96, Q96), sqrtPriceX96, Q96);
        if (needed1 <= desired1) return (desired0, needed1);
        uint256 needed0 = Math.mulDiv(Math.mulDiv(desired1, Q96, sqrtPriceX96), Q96, sqrtPriceX96);
        return (Math.min(needed0, desired0), desired1);
    }
}
