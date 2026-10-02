// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {INonfungiblePositionManager} from "../../../src/interfaces/uniswap/INonfungiblePositionManager.sol";
import {IUniswapV3Factory} from "../../../src/interfaces/uniswap/IUniswapV3Factory.sol";
import {IUniswapV3Pool} from "../../../src/interfaces/uniswap/IUniswapV3Pool.sol";
import {AuditUniV3Math as M} from "./AuditUniV3Math.sol";

/// @notice Audit-only Uniswap v3 pool model with the real liquidity math for ONE range of liquidity (enough for
///         a graduator that mints a single full-range position): `initialize` is permissionless and accepts any
///         price in [MIN_SQRT_RATIO, MAX_SQRT_RATIO) like the real pool, `mint` reverts on zero liquidity like
///         `UniswapV3Pool.mint` (`require(amount > 0)`), and `swapExactIn` uses SqrtPriceMath (fee taken on input).
contract AuditPool is IUniswapV3Pool {
    using SafeERC20 for IERC20;

    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    address internal immutable _manager;

    uint160 public sqrtPriceX96;
    uint128 public liquidity; // liquidity of the single range below
    uint160 public rangeLower;
    uint160 public rangeUpper;

    error AlreadyInitialized();
    error InvalidPrice();
    error NotManager();
    error ZeroLiquidity();
    error RangeMismatch();
    error CrossesRange();

    constructor(address t0, address t1, uint24 fee_, int24 spacing, address manager) {
        token0 = t0;
        token1 = t1;
        fee = fee_;
        tickSpacing = spacing;
        _manager = manager;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96, 0, 0, 1, 1, 0, true);
    }

    function initialize(uint160 p) external {
        if (sqrtPriceX96 != 0) revert AlreadyInitialized();
        if (p < M.MIN_SQRT_RATIO || p >= M.MAX_SQRT_RATIO) revert InvalidPrice();
        sqrtPriceX96 = p;
    }

    /// @dev Called by the manager; amounts are computed with the pool's current price exactly like
    ///      `UniswapV3Pool._modifyPosition` (rounding up).
    function mintRange(uint160 a, uint160 b, uint128 amount) external returns (uint256 amount0, uint256 amount1) {
        if (msg.sender != _manager) revert NotManager();
        if (amount == 0) revert ZeroLiquidity(); // UniswapV3Pool.mint: require(amount > 0)
        if (liquidity != 0 && (a != rangeLower || b != rangeUpper)) revert RangeMismatch();
        rangeLower = a;
        rangeUpper = b;
        uint160 p = sqrtPriceX96;
        if (p <= a) {
            amount0 = M.getAmount0Delta(a, b, amount, true);
        } else if (p < b) {
            amount0 = M.getAmount0Delta(p, b, amount, true);
            amount1 = M.getAmount1Delta(a, p, amount, true);
        } else {
            amount1 = M.getAmount1Delta(a, b, amount, true);
        }
        liquidity += amount;
    }

    /// @notice Exact-input swap through the single range. Price moves freely (at zero cost) through the empty region
    ///         outside the range, as in the real pool. The caller must have approved `amountIn` to this pool.
    function swapExactIn(bool zeroForOne, uint256 amountIn, address recipient) external returns (uint256 amountOut) {
        uint256 amountLessFee = amountIn * (1e6 - fee) / 1e6;
        uint160 p = sqrtPriceX96;
        uint160 next;
        if (zeroForOne) {
            if (p > rangeUpper) p = rangeUpper;
            next = M.nextSqrtPriceFromAmount0In(p, liquidity, amountLessFee);
            if (next < rangeLower) revert CrossesRange();
            amountOut = M.getAmount1Delta(next, p, liquidity, false);
            IERC20(token0).safeTransferFrom(msg.sender, address(this), amountIn);
            IERC20(token1).safeTransfer(recipient, amountOut);
        } else {
            if (p < rangeLower) p = rangeLower;
            next = M.nextSqrtPriceFromAmount1In(p, liquidity, amountLessFee);
            if (next > rangeUpper) revert CrossesRange();
            amountOut = M.getAmount0Delta(p, next, liquidity, false);
            IERC20(token1).safeTransferFrom(msg.sender, address(this), amountIn);
            IERC20(token0).safeTransfer(recipient, amountOut);
        }
        sqrtPriceX96 = next;
    }

    /// @notice Zero-liquidity price move (what any `swap` does when no liquidity is in range): free for anyone.
    function movePriceWithoutLiquidity(uint160 p) external {
        require(liquidity == 0, "has liquidity");
        sqrtPriceX96 = p;
    }
}

/// @notice Audit-only factory: permissionless `createPool` (no code check on the tokens, like the real factory).
contract AuditFactory is IUniswapV3Factory {
    mapping(uint24 => int24) public feeAmountTickSpacing;
    mapping(address => mapping(address => mapping(uint24 => address))) public getPool;
    address public manager;

    constructor() {
        feeAmountTickSpacing[500] = 10;
        feeAmountTickSpacing[3000] = 60;
        feeAmountTickSpacing[10_000] = 200;
    }

    function setManager(address m) external {
        manager = m;
    }

    function createPool(address a, address b, uint24 fee) external returns (address pool) {
        require(a != b && feeAmountTickSpacing[fee] != 0 && getPool[a][b][fee] == address(0), "createPool");
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        pool = address(new AuditPool(t0, t1, fee, feeAmountTickSpacing[fee], manager));
        getPool[t0][t1][fee] = pool;
        getPool[t1][t0][fee] = pool;
    }
}

/// @notice Audit-only NonfungiblePositionManager: `createAndInitializePoolIfNecessary` and `mint` follow
///         v3-periphery (LiquidityAmounts.getLiquidityForAmounts on slot0's price, then pool.mint, then the
///         "Price slippage check" against the minimums). The NFT is recorded with `_mint` semantics (no callback).
contract AuditPositionManager is INonfungiblePositionManager {
    using SafeERC20 for IERC20;

    IUniswapV3Factory public immutable factory;
    uint256 public nextId = 1;
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => address) public poolOfId;
    mapping(uint256 => uint128) public liquidityOf;

    constructor(address f) {
        factory = IUniswapV3Factory(f);
    }

    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)
        external
        payable
        returns (address pool)
    {
        require(token0 < token1, "order");
        pool = factory.getPool(token0, token1, fee);
        if (pool == address(0)) {
            pool = factory.createPool(token0, token1, fee);
            IUniswapV3Pool(pool).initialize(sqrtPriceX96);
        } else {
            (uint160 existing,,,,,,) = IUniswapV3Pool(pool).slot0();
            if (existing == 0) IUniswapV3Pool(pool).initialize(sqrtPriceX96);
        }
    }

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        require(block.timestamp <= params.deadline, "Transaction too old");
        address pool = factory.getPool(params.token0, params.token1, params.fee);
        (uint160 p,,,,,,) = IUniswapV3Pool(pool).slot0();
        uint160 a = M.getSqrtRatioAtTick(params.tickLower);
        uint160 b = M.getSqrtRatioAtTick(params.tickUpper);
        liquidity = M.getLiquidityForAmounts(p, a, b, params.amount0Desired, params.amount1Desired);
        (amount0, amount1) = AuditPool(pool).mintRange(a, b, liquidity);
        require(amount0 >= params.amount0Min && amount1 >= params.amount1Min, "Price slippage check");
        if (amount0 > 0) IERC20(params.token0).safeTransferFrom(msg.sender, pool, amount0);
        if (amount1 > 0) IERC20(params.token1).safeTransferFrom(msg.sender, pool, amount1);
        tokenId = nextId++;
        ownerOf[tokenId] = params.recipient;
        poolOfId[tokenId] = pool;
        liquidityOf[tokenId] = liquidity;
    }

    function collect(CollectParams calldata) external payable returns (uint256, uint256) {
        return (0, 0);
    }

    function positions(uint256 tokenId)
        external
        view
        returns (uint96, address, address, address, uint24, int24, int24, uint128 liquidity, uint256, uint256, uint128, uint128)
    {
        liquidity = liquidityOf[tokenId];
    }
}
