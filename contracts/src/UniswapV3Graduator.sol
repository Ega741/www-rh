// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IGraduator} from "./interfaces/IGraduator.sol";
import {INonfungiblePositionManager} from "./interfaces/uniswap/INonfungiblePositionManager.sol";
import {IUniswapV3Factory} from "./interfaces/uniswap/IUniswapV3Factory.sol";
import {IUniswapV3Pool, IUniswapV3SwapCallback} from "./interfaces/uniswap/IUniswapV3Pool.sol";
import {IWETH9} from "./interfaces/uniswap/IWETH9.sol";

/// @title UniswapV3Graduator
/// @notice Moves a graduated coin's liquidity (`LP_SUPPLY` tokens + the curve's ETH as WETH) into a full-range
///         Uniswap v3 position owned by this contract forever, and harvests the position's fees: the ETH side
///         goes back to the launchpad (credited to the coin's mind vault there), the token side is burned
///         (SPEC §2.4).
/// @dev Anyone can create and initialize the WETH/coin pool before graduation, at any price. Liquidity is therefore
///      never minted at a price other than the one implied by the graduation amounts (`expected`): if the pool's
///      price differs, this contract first swaps through the pool towards `expected` (exact input, price limit
///      `expected`, selling at most half of the side that pushes the price the right way; without liquidity in the
///      way the price moves for free), then requires the price to be within {priceToleranceBps} of `expected`
///      (sqrt-price terms) or reverts {PoolPriceSkewed} (state unchanged; anyone can retry once the pool has been
///      arbitraged). Any liquidity the correction trades against is mispriced against `expected`, so its owner sells
///      to this contract below / buys from it above the fair price. Leftovers after the mint: WETH is unwrapped and
///      returned to the launchpad, tokens are burned. The owner can only tune {priceToleranceBps}; the LP NFT can
///      never leave this contract.
contract UniswapV3Graduator is IGraduator, IUniswapV3SwapCallback, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Uniswap v3 `TickMath.MIN_TICK`.
    int24 internal constant MIN_TICK = -887272;
    /// @dev Unused and harvested tokens are burned by sending them here.
    address internal constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant Q96 = 1 << 96;
    /// @dev The price correction sells at most this share of the side it sells.
    uint256 internal constant MAX_CORRECTION_BPS = 5000;
    /// @dev Extra slack of the mint minimums on top of `2 * priceToleranceBps`.
    uint256 internal constant MINT_SLACK_BPS = 100;
    uint16 internal constant DEFAULT_PRICE_TOLERANCE_BPS = 100;
    uint16 internal constant MAX_PRICE_TOLERANCE_BPS = 1000;

    /// @dev Scratch data of one graduation (memory struct keeps the stack shallow). `amount0`/`amount1` are the
    ///      amounts available for the position (updated by the price correction).
    struct Deployment {
        address token0;
        address token1;
        uint256 amount0;
        uint256 amount1;
        uint256 used0;
        uint256 used1;
    }

    /// @inheritdoc IGraduator
    address public immutable launchpad;
    /// @notice Uniswap v3 NonfungiblePositionManager.
    INonfungiblePositionManager public immutable positionManager;
    /// @notice Uniswap v3 factory.
    IUniswapV3Factory public immutable factory;
    /// @notice Canonical WETH9.
    IWETH9 public immutable weth9;
    /// @notice Pool fee tier used for every graduation (e.g. 10000 = 1 %).
    uint24 public immutable feeTier;
    /// @notice Lower tick of every position: `(MIN_TICK / tickSpacing) * tickSpacing` (-887200 for the 1 % tier).
    int24 public immutable tickLower;
    /// @notice Upper tick of every position: `-tickLower`.
    int24 public immutable tickUpper;

    /// @notice Maximum relative distance, in basis points of `sqrtPriceX96`, between the pool price and the price
    ///         implied by the graduation amounts at mint time (default 100 = 1 %, at most 1000).
    uint16 public priceToleranceBps;

    /// @notice LP position id per token (0 = not graduated through this contract).
    mapping(address token => uint256) public positionOf;
    /// @notice Pool per token.
    mapping(address token => address) public poolOf;

    /// @dev Pool of the price-correction swap in progress: the only caller {uniswapV3SwapCallback} accepts. Zero
    ///      outside that swap.
    address private _swapPool;

    /// @notice The pool's price differed from the one implied by the graduation amounts and a correction swap
    ///         towards `expectedSqrtPriceX96` was made before minting. `actualSqrtPriceX96` is the price before
    ///         the correction.
    event GraduatedAtSkewedPrice(address indexed token, uint160 expectedSqrtPriceX96, uint160 actualSqrtPriceX96);
    /// @notice {priceToleranceBps} changed.
    event PriceToleranceUpdated(uint16 toleranceBps);

    /// @notice Caller is not {launchpad}.
    error NotLaunchpad();
    /// @notice `token` has already been graduated through this contract.
    error AlreadyGraduated();
    /// @notice `token` has no position here.
    error NoPosition();
    /// @notice Plain ETH is accepted only from WETH9 (unwrapping).
    error UnexpectedEthSender();
    /// @notice {feeTier} is not enabled on the factory.
    error UnsupportedFeeTier();
    /// @notice A required address is zero.
    error ZeroAddress();
    /// @notice Returning ETH to the launchpad failed.
    error EthTransferFailed();
    /// @notice After the correction swap the pool price is still farther than {priceToleranceBps} from the expected
    ///         price (`actualSqrtPriceX96` = price after the correction). Nothing changes; retry later.
    error PoolPriceSkewed(uint160 expectedSqrtPriceX96, uint160 actualSqrtPriceX96);
    /// @notice {uniswapV3SwapCallback} called by anything but the pool of the correction swap in progress.
    error UnauthorizedCallback();
    /// @notice {setPriceToleranceBps} above 1000.
    error InvalidPriceTolerance();

    modifier onlyLaunchpad() {
        if (msg.sender != launchpad) revert NotLaunchpad();
        _;
    }

    /// @param initialOwner     Initial owner (Ownable2Step; may only tune {priceToleranceBps}).
    /// @param launchpad_       {MindLaunchpad}.
    /// @param positionManager_ Uniswap v3 NonfungiblePositionManager.
    /// @param factory_         Uniswap v3 factory.
    /// @param weth9_           WETH9.
    /// @param feeTier_         Pool fee tier (must be enabled on the factory).
    constructor(
        address initialOwner,
        address launchpad_,
        address positionManager_,
        address factory_,
        address weth9_,
        uint24 feeTier_
    ) Ownable(initialOwner) {
        if (
            launchpad_ == address(0) || positionManager_ == address(0) || factory_ == address(0) || weth9_ == address(0)
        ) revert ZeroAddress();
        int24 spacing = IUniswapV3Factory(factory_).feeAmountTickSpacing(feeTier_);
        if (spacing <= 0) revert UnsupportedFeeTier();
        launchpad = launchpad_;
        positionManager = INonfungiblePositionManager(positionManager_);
        factory = IUniswapV3Factory(factory_);
        weth9 = IWETH9(weth9_);
        feeTier = feeTier_;
        // Division first is intentional: round the bound towards zero to a multiple of `spacing`.
        // forge-lint: disable-next-line(divide-before-multiply)
        int24 lower = (MIN_TICK / spacing) * spacing;
        tickLower = lower;
        tickUpper = -lower;
        priceToleranceBps = DEFAULT_PRICE_TOLERANCE_BPS;
        emit PriceToleranceUpdated(DEFAULT_PRICE_TOLERANCE_BPS);
    }

    /// @dev Only WETH9 may push ETH here (on `withdraw`). The launchpad pays through {graduate}.
    receive() external payable {
        if (msg.sender != address(weth9)) revert UnexpectedEthSender();
    }

    // ---------------------------------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------------------------------

    /// @notice Sets {priceToleranceBps} (at most 1000 = 10 %; 0 requires the exact expected price).
    function setPriceToleranceBps(uint16 newToleranceBps) external onlyOwner {
        if (newToleranceBps > MAX_PRICE_TOLERANCE_BPS) revert InvalidPriceTolerance();
        priceToleranceBps = newToleranceBps;
        emit PriceToleranceUpdated(newToleranceBps);
    }

    // ---------------------------------------------------------------------------------------------
    // IGraduator
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IGraduator
    /// @dev 1. wrap `msg.value`; 2. order `token0 < token1` and derive `expected` solely from the amounts;
    ///      3. create/initialize the pool at `expected` if needed (an initialized pool keeps its own price);
    ///      4. if the pool price differs, swap towards `expected` (at most half of the sold side) and emit
    ///         {GraduatedAtSkewedPrice}; 5. require the price within {priceToleranceBps} of `expected`, else
    ///         {PoolPriceSkewed}; 6. mint a full-range position owned by this contract with the amounts that fit
    ///         the pool price and minimums `desired * (10000 - 2 * tolerance - 100) / 10000`;
    ///      7. unwrap and return unused WETH to the launchpad, burn unused tokens.
    function graduate(address token, uint256 tokenAmount)
        external
        payable
        onlyLaunchpad
        nonReentrant
        returns (address pool, uint256 positionId, uint256 ethReturned)
    {
        if (positionOf[token] != 0) revert AlreadyGraduated();
        weth9.deposit{value: msg.value}();

        Deployment memory d;
        bool tokenIs0 = token < address(weth9);
        (d.token0, d.token1, d.amount0, d.amount1) = tokenIs0
            ? (token, address(weth9), tokenAmount, msg.value)
            : (address(weth9), token, msg.value, tokenAmount);

        uint160 expected = SafeCast.toUint160(Math.sqrt(Math.mulDiv(d.amount1, 1 << 192, d.amount0)));
        pool = positionManager.createAndInitializePoolIfNecessary(d.token0, d.token1, feeTier, expected);
        uint160 price = _sqrtPrice(pool);
        if (price != expected) {
            _correctPrice(pool, d, expected, price);
            emit GraduatedAtSkewedPrice(token, expected, price);
            price = _sqrtPrice(pool);
        }
        uint256 tolerance = priceToleranceBps;
        uint256 distance = price > expected ? price - expected : expected - price;
        if (distance * BPS > uint256(expected) * tolerance) revert PoolPriceSkewed(expected, price);

        (positionId, d.used0, d.used1) = _mintFullRange(d, price, tolerance);
        positionOf[token] = positionId;
        poolOf[token] = pool;

        uint256 unused0 = d.amount0 - d.used0;
        uint256 unused1 = d.amount1 - d.used1;
        (uint256 tokensLeft, uint256 wethLeft) = tokenIs0 ? (unused0, unused1) : (unused1, unused0);
        ethReturned = wethLeft;
        _burnTokens(token, tokensLeft);
        _returnEth(ethReturned);
    }

    /// @inheritdoc IGraduator
    function harvest(address token) external onlyLaunchpad nonReentrant returns (uint256 ethOut, uint256 tokensBurned) {
        uint256 positionId = positionOf[token];
        if (positionId == 0) revert NoPosition();
        (uint256 amount0, uint256 amount1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: positionId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        (tokensBurned, ethOut) = token < address(weth9) ? (amount0, amount1) : (amount1, amount0);
        _burnTokens(token, tokensBurned);
        _returnEth(ethOut);
    }

    // ---------------------------------------------------------------------------------------------
    // Uniswap v3 swap callback
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IUniswapV3SwapCallback
    /// @dev Only the pool of the correction swap in progress (recorded by {graduate} right before the swap) may
    ///      call; it is paid the positive delta(s) in the pair's tokens (`data = abi.encode(token0, token1)`). A
    ///      swap that only moved the price through a range without liquidity reports zero deltas and owes nothing.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        if (msg.sender != _swapPool) revert UnauthorizedCallback();
        (address token0, address token1) = abi.decode(data, (address, address));
        if (amount0Delta > 0) IERC20(token0).safeTransfer(msg.sender, SafeCast.toUint256(amount0Delta));
        if (amount1Delta > 0) IERC20(token1).safeTransfer(msg.sender, SafeCast.toUint256(amount1Delta));
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    /// @dev Swaps through `pool` towards `expected` (exact input, price limit `expected`): token0 in when the price
    ///      must fall, token1 in when it must rise, selling at most `MAX_CORRECTION_BPS` of that side. Updates the
    ///      amounts available for the position with the swap deltas.
    function _correctPrice(address pool, Deployment memory d, uint160 expected, uint160 current) internal {
        bool zeroForOne = current > expected;
        uint256 cap = (zeroForOne ? d.amount0 : d.amount1) * MAX_CORRECTION_BPS / BPS;
        _swapPool = pool;
        (int256 delta0, int256 delta1) = IUniswapV3Pool(pool)
            .swap(address(this), zeroForOne, SafeCast.toInt256(cap), expected, abi.encode(d.token0, d.token1));
        _swapPool = address(0);
        d.amount0 = _applyDelta(d.amount0, delta0);
        d.amount1 = _applyDelta(d.amount1, delta1);
    }

    /// @dev Mints a full-range position to this contract with the largest amounts that fit the pool price and
    ///      returns the amounts actually used.
    function _mintFullRange(Deployment memory d, uint160 sqrtPriceX96, uint256 tolerance)
        internal
        returns (uint256 positionId, uint256 used0, uint256 used1)
    {
        (uint256 desired0, uint256 desired1) = _amountsAtPrice(sqrtPriceX96, d.amount0, d.amount1);
        uint256 minFactor = BPS - 2 * tolerance - MINT_SLACK_BPS;
        IERC20(d.token0).forceApprove(address(positionManager), desired0);
        IERC20(d.token1).forceApprove(address(positionManager), desired1);
        (positionId,, used0, used1) = positionManager.mint(
            INonfungiblePositionManager.MintParams({
                token0: d.token0,
                token1: d.token1,
                fee: feeTier,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: desired0,
                amount1Desired: desired1,
                amount0Min: Math.max(desired0 * minFactor / BPS, 1),
                amount1Min: Math.max(desired1 * minFactor / BPS, 1),
                recipient: address(this),
                deadline: block.timestamp
            })
        );
        IERC20(d.token0).forceApprove(address(positionManager), 0);
        IERC20(d.token1).forceApprove(address(positionManager), 0);
    }

    /// @dev Largest `(amount0, amount1) <= (available0, available1)` in the proportion of a full-range position at
    ///      `sqrtPriceX96` (token1 per token0 = price²). The full range spans ~±887k ticks, so the exact proportion
    ///      `price² · (1 - lower/sqrtP) / (1 - sqrtP/upper)` differs from `price²` by far less than 1e-12 at any
    ///      price a graduation can have; the position manager computes the exact amounts.
    function _amountsAtPrice(uint160 sqrtPriceX96, uint256 available0, uint256 available1)
        internal
        pure
        returns (uint256 amount0, uint256 amount1)
    {
        uint256 needed1 = Math.mulDiv(Math.mulDiv(available0, sqrtPriceX96, Q96), sqrtPriceX96, Q96);
        if (needed1 <= available1) return (available0, needed1);
        uint256 needed0 = Math.mulDiv(Math.mulDiv(available1, Q96, sqrtPriceX96), Q96, sqrtPriceX96);
        return (Math.min(needed0, available0), available1);
    }

    /// @dev Applies a pool delta (positive = paid to the pool, negative = received) to an available amount.
    function _applyDelta(uint256 amount, int256 delta) internal pure returns (uint256) {
        return delta >= 0 ? amount - SafeCast.toUint256(delta) : amount + SafeCast.toUint256(-delta);
    }

    /// @dev Current `sqrtPriceX96` of `pool`.
    function _sqrtPrice(address pool) internal view returns (uint160 sqrtPriceX96) {
        (sqrtPriceX96,,,,,,) = IUniswapV3Pool(pool).slot0();
    }

    /// @dev Unwraps `amount` WETH and sends the ETH to the launchpad with a full-gas call (its `receive()` counts it).
    function _returnEth(uint256 amount) internal {
        if (amount == 0) return;
        weth9.withdraw(amount);
        (bool ok,) = launchpad.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }

    /// @dev Burns `amount` of `token` by sending it to the burn address.
    function _burnTokens(address token, uint256 amount) internal {
        if (amount == 0) return;
        IERC20(token).safeTransfer(BURN_ADDRESS, amount);
    }
}
