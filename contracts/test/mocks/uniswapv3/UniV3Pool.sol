// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IUniswapV3Pool, IUniswapV3SwapCallback} from "../../../src/interfaces/uniswap/IUniswapV3Pool.sol";
import {UniV3Math as M} from "./UniV3Math.sol";

/// @notice Uniswap v3 pool model with the real liquidity and swap math (test/mocks/uniswapv3/UniV3Math.sol) for a
///         handful of positions. Each position is a price range `[lower, upper)` (sqrt prices of its ticks) with its
///         own liquidity; the active liquidity at a price is the sum over the ranges containing it, and swaps step
///         from range boundary to range boundary exactly like tick crossing. Like the real pool:
///         - `initialize` is permissionless and accepts any price in [MIN_SQRT_RATIO, MAX_SQRT_RATIO);
///         - `swap` (exact input) checks the price limit ('SPL'), moves the price for free through regions without
///           liquidity, pays the output, calls `uniswapV3SwapCallback` on the caller even when both deltas are zero
///           and checks the input arrived ('IIA'); it is locked while running ('LOK');
///         - swap fees (taken from the input) accrue to the in-range positions pro rata to their liquidity;
///         - minting zero liquidity reverts.
///         Simplifications: exact output is not supported, `slot0().tick` is not tracked (always 0), positions are
///         minted/burned by the factory's position manager only, and its token transfers happen after `mintRange`.
contract UniV3Pool is IUniswapV3Pool {
    using SafeERC20 for IERC20;

    struct Range {
        uint160 lower;
        uint160 upper;
        uint128 liquidity;
        uint256 fees0;
        uint256 fees1;
    }

    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    address public immutable manager;

    uint160 public sqrtPriceX96;
    bool internal _unlocked;
    Range[] internal _ranges;

    error AlreadyInitialized();
    error InvalidPrice();
    error NotManager();
    error ZeroLiquidity();
    error InvalidRange();
    error Locked();
    error ZeroAmountSpecified();
    error ExactOutputNotSupported();
    error PriceLimit();
    error InsufficientInput();

    modifier lock() {
        if (!_unlocked) revert Locked();
        _unlocked = false;
        _;
        _unlocked = true;
    }

    modifier onlyManager() {
        if (msg.sender != manager) revert NotManager();
        _;
    }

    constructor(address token0_, address token1_, uint24 fee_, int24 tickSpacing_, address manager_) {
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
        tickSpacing = tickSpacing_;
        manager = manager_;
    }

    // ---------------------------------------------------------------------------------------------
    // IUniswapV3Pool
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IUniswapV3Pool
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96, 0, 0, 1, 1, 0, _unlocked);
    }

    /// @inheritdoc IUniswapV3Pool
    function initialize(uint160 p) external {
        if (sqrtPriceX96 != 0) revert AlreadyInitialized();
        if (p < M.MIN_SQRT_RATIO || p >= M.MAX_SQRT_RATIO) revert InvalidPrice();
        sqrtPriceX96 = p;
        _unlocked = true;
    }

    /// @inheritdoc IUniswapV3Pool
    function liquidity() external view returns (uint128 active) {
        uint160 p = sqrtPriceX96;
        for (uint256 i; i < _ranges.length; ++i) {
            Range storage r = _ranges[i];
            if (r.lower <= p && p < r.upper) active += r.liquidity;
        }
    }

    /// @inheritdoc IUniswapV3Pool
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external lock returns (int256 amount0, int256 amount1) {
        if (amountSpecified == 0) revert ZeroAmountSpecified();
        if (amountSpecified < 0) revert ExactOutputNotSupported();
        uint160 p = sqrtPriceX96;
        bool limitOk = zeroForOne
            ? sqrtPriceLimitX96 < p && sqrtPriceLimitX96 > M.MIN_SQRT_RATIO
            : sqrtPriceLimitX96 > p && sqrtPriceLimitX96 < M.MAX_SQRT_RATIO;
        if (!limitOk) revert PriceLimit();

        (uint256 amountIn, uint256 amountOut) =
            _swap(zeroForOne, SafeCast.toUint256(amountSpecified), sqrtPriceLimitX96);
        int256 inSigned = SafeCast.toInt256(amountIn);
        int256 outSigned = -SafeCast.toInt256(amountOut);
        (amount0, amount1) = zeroForOne ? (inSigned, outSigned) : (outSigned, inSigned);
        _settle(recipient, zeroForOne, amount0, amount1, data);
    }

    // ---------------------------------------------------------------------------------------------
    // Test helpers
    // ---------------------------------------------------------------------------------------------

    /// @notice Exact-input swap paid with `transferFrom` (approve this pool first) and no price limit; returns the
    ///         output sent to `recipient`. Only the input actually consumed is pulled.
    function swapExactIn(bool zeroForOne, uint256 amountIn, address recipient) external returns (uint256 amountOut) {
        return swapExactInTo(zeroForOne, amountIn, zeroForOne ? M.MIN_SQRT_RATIO + 1 : M.MAX_SQRT_RATIO - 1, recipient);
    }

    /// @notice Like {swapExactIn} but stops at `limit` (input left over is not pulled), e.g. to arbitrage the pool
    ///         back to a target price.
    function swapExactInTo(bool zeroForOne, uint256 amountIn, uint160 limit, address recipient)
        public
        lock
        returns (uint256 amountOut)
    {
        uint256 consumed;
        (consumed, amountOut) = _swap(zeroForOne, amountIn, limit);
        (address tokenIn, address tokenOut) = zeroForOne ? (token0, token1) : (token1, token0);
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), consumed);
        if (amountOut > 0) IERC20(tokenOut).safeTransfer(recipient, amountOut);
    }

    /// @notice Number of positions ever minted.
    function rangesLength() external view returns (uint256) {
        return _ranges.length;
    }

    /// @notice A position's range, liquidity and accrued (uncollected) fees.
    function rangeAt(uint256 id) external view returns (Range memory) {
        return _ranges[id];
    }

    // ---------------------------------------------------------------------------------------------
    // Position manager hooks
    // ---------------------------------------------------------------------------------------------

    /// @notice Adds a position of `amount` liquidity on [a, b); returns its id and the token amounts owed for it at
    ///         the current price (rounded up, like `UniswapV3Pool._modifyPosition`). The manager transfers them.
    function mintRange(uint160 a, uint160 b, uint128 amount)
        external
        lock
        onlyManager
        returns (uint256 id, uint256 amount0, uint256 amount1)
    {
        if (amount == 0) revert ZeroLiquidity(); // UniswapV3Pool.mint: require(amount > 0)
        if (a >= b || a < M.MIN_SQRT_RATIO || b > M.MAX_SQRT_RATIO) revert InvalidRange();
        (amount0, amount1) = M.getAmountsForLiquidity(sqrtPriceX96, a, b, amount, true);
        id = _ranges.length;
        _ranges.push(Range({lower: a, upper: b, liquidity: amount, fees0: 0, fees1: 0}));
    }

    /// @notice Removes all liquidity of position `id` and sends its token amounts at the current price (rounded
    ///         down) to `recipient`. Accrued fees stay collectable.
    function burnRange(uint256 id, address recipient)
        external
        lock
        onlyManager
        returns (uint256 amount0, uint256 amount1)
    {
        Range storage r = _ranges[id];
        (amount0, amount1) = M.getAmountsForLiquidity(sqrtPriceX96, r.lower, r.upper, r.liquidity, false);
        r.liquidity = 0;
        if (amount0 > 0) IERC20(token0).safeTransfer(recipient, amount0);
        if (amount1 > 0) IERC20(token1).safeTransfer(recipient, amount1);
    }

    /// @notice Sends up to `max0`/`max1` of position `id`'s accrued fees to `recipient`.
    function collectRange(uint256 id, address recipient, uint256 max0, uint256 max1)
        external
        lock
        onlyManager
        returns (uint256 amount0, uint256 amount1)
    {
        Range storage r = _ranges[id];
        amount0 = r.fees0 < max0 ? r.fees0 : max0;
        amount1 = r.fees1 < max1 ? r.fees1 : max1;
        r.fees0 -= amount0;
        r.fees1 -= amount1;
        if (amount0 > 0) IERC20(token0).safeTransfer(recipient, amount0);
        if (amount1 > 0) IERC20(token1).safeTransfer(recipient, amount1);
    }

    // ---------------------------------------------------------------------------------------------
    // Swap engine
    // ---------------------------------------------------------------------------------------------

    /// @dev Pays the output, calls back the swapper and checks the input arrived (UniswapV3Pool.swap's tail).
    function _settle(address recipient, bool zeroForOne, int256 amount0, int256 amount1, bytes calldata data) internal {
        (address tokenIn, address tokenOut) = zeroForOne ? (token0, token1) : (token1, token0);
        (int256 owed, int256 paid) = zeroForOne ? (amount0, amount1) : (amount1, amount0);
        if (paid < 0) IERC20(tokenOut).safeTransfer(recipient, SafeCast.toUint256(-paid));
        uint256 balanceBefore = IERC20(tokenIn).balanceOf(address(this));
        IUniswapV3SwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        if (IERC20(tokenIn).balanceOf(address(this)) < balanceBefore + SafeCast.toUint256(owed)) {
            revert InsufficientInput();
        }
    }

    /// @dev Exact-input swap from the current price towards `limit`, one constant-liquidity segment at a time
    ///      (SwapMath.computeSwapStep with the segment's active liquidity; zero liquidity moves the price for free).
    ///      Returns the input consumed (fees included) and the output.
    function _swap(bool zeroForOne, uint256 amountRemaining, uint160 limit)
        internal
        returns (uint256 amountIn, uint256 amountOut)
    {
        uint160 p = sqrtPriceX96;
        while (amountRemaining != 0 && p != limit) {
            (uint160 target, uint128 active) = _segment(zeroForOne, p, limit);
            (uint160 next, uint256 stepIn, uint256 stepOut, uint256 stepFee) =
                M.computeSwapStep(p, target, active, amountRemaining, fee);
            _accrueFees(zeroForOne, p, active, stepFee);
            amountRemaining -= stepIn + stepFee;
            amountIn += stepIn + stepFee;
            amountOut += stepOut;
            p = next;
        }
        sqrtPriceX96 = p;
    }

    /// @dev Next boundary in the swap direction (capped by `limit`) and the liquidity active up to it: moving down
    ///      from `p` the segment is (target, p], moving up it is [p, target).
    function _segment(bool zeroForOne, uint160 p, uint160 limit)
        internal
        view
        returns (uint160 target, uint128 active)
    {
        target = limit;
        for (uint256 i; i < _ranges.length; ++i) {
            Range storage r = _ranges[i];
            if (r.liquidity == 0) continue;
            if (zeroForOne) {
                if (r.lower < p && r.lower > target) target = r.lower;
                if (r.upper < p && r.upper > target) target = r.upper;
                if (r.lower < p && r.upper >= p) active += r.liquidity;
            } else {
                if (r.lower > p && r.lower < target) target = r.lower;
                if (r.upper > p && r.upper < target) target = r.upper;
                if (r.lower <= p && r.upper > p) active += r.liquidity;
            }
        }
    }

    /// @dev Credits `stepFee` (input token) to the positions active in the segment starting at `p`, pro rata.
    function _accrueFees(bool zeroForOne, uint160 p, uint128 active, uint256 stepFee) internal {
        if (stepFee == 0 || active == 0) return;
        for (uint256 i; i < _ranges.length; ++i) {
            Range storage r = _ranges[i];
            if (r.liquidity == 0) continue;
            bool inSegment = zeroForOne ? (r.lower < p && r.upper >= p) : (r.lower <= p && r.upper > p);
            if (!inSegment) continue;
            uint256 share = stepFee * r.liquidity / active;
            if (zeroForOne) r.fees0 += share;
            else r.fees1 += share;
        }
    }
}
