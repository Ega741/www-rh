// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IGraduator} from "./interfaces/IGraduator.sol";
import {IMindLaunchpad} from "./interfaces/IMindLaunchpad.sol";
import {INonfungiblePositionManager} from "./interfaces/uniswap/INonfungiblePositionManager.sol";
import {IUniswapV3Factory} from "./interfaces/uniswap/IUniswapV3Factory.sol";
import {IUniswapV3Pool} from "./interfaces/uniswap/IUniswapV3Pool.sol";
import {IWETH9} from "./interfaces/uniswap/IWETH9.sol";

/// @title UniswapV3Graduator
/// @notice Moves a graduated coin's liquidity (`LP_SUPPLY` tokens + the curve's ETH) into a full-range
///         Uniswap v3 position owned by this contract forever, and harvests the position's fees back
///         into the coin's mind vault (ETH) while burning the token side. SPEC §2.4.
/// @dev The LP NFT is never transferred out; there is no rescue function for it.
contract UniswapV3Graduator is IGraduator, Ownable2Step, IERC721Receiver {
    using SafeERC20 for IERC20;

    /// @dev Uniswap v3 tick bounds.
    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;
    uint256 internal constant BPS = 10_000;
    /// @notice Collected tokens are burned by sending them here.
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @dev Scratch data of one graduation (memory struct keeps the stack shallow).
    struct Deployment {
        bool tokenIs0;
        address token0;
        address token1;
        uint256 amount0;
        uint256 amount1;
        uint256 used0;
        uint256 used1;
    }

    /// @notice The {MindLaunchpad} allowed to call {graduate} / {harvest}.
    address public immutable launchpad;
    /// @notice Uniswap v3 NonfungiblePositionManager.
    INonfungiblePositionManager public immutable positionManager;
    /// @notice Uniswap v3 factory.
    IUniswapV3Factory public immutable factory;
    /// @notice Canonical WETH9.
    IWETH9 public immutable weth9;
    /// @notice Pool fee tier used for every graduation (e.g. 10000 = 1 %).
    uint24 public immutable feeTier;

    /// @notice Max allowed deviation (bps) between an existing pool's price and the curve's final price.
    uint16 public maxDeviationBps = 2000;

    /// @notice LP position id per token (0 = not graduated through this contract).
    mapping(address token => uint256) public positionId;
    /// @notice Pool per token.
    mapping(address token => address) public poolOf;

    event MaxDeviationUpdated(uint16 maxDeviationBps);
    event LiquidityDeployed(
        address indexed token,
        address indexed pool,
        uint256 positionId,
        uint256 tokenAmount,
        uint256 ethAmount,
        uint256 targetPriceWei
    );
    event FeesHarvested(address indexed token, uint256 ethOut, uint256 tokensBurned);

    error NotLaunchpad();
    error PoolPriceSkewed();
    error NoPosition();
    error InvalidBps();
    error ZeroAddress();
    error ZeroAmount();
    error UnexpectedEth();

    modifier onlyLaunchpad() {
        if (msg.sender != launchpad) revert NotLaunchpad();
        _;
    }

    /// @param owner_           Initial owner (may tune {maxDeviationBps}).
    /// @param launchpad_       {MindLaunchpad}.
    /// @param positionManager_ Uniswap v3 NonfungiblePositionManager.
    /// @param factory_         Uniswap v3 factory.
    /// @param weth9_           WETH9.
    /// @param feeTier_         Pool fee tier (must be enabled on the factory).
    constructor(
        address owner_,
        address launchpad_,
        address positionManager_,
        address factory_,
        address weth9_,
        uint24 feeTier_
    ) Ownable(owner_) {
        if (
            launchpad_ == address(0) || positionManager_ == address(0) || factory_ == address(0)
                || weth9_ == address(0)
        ) revert ZeroAddress();
        launchpad = launchpad_;
        positionManager = INonfungiblePositionManager(positionManager_);
        factory = IUniswapV3Factory(factory_);
        weth9 = IWETH9(weth9_);
        feeTier = feeTier_;
    }

    /// @dev Only WETH9 may push ETH here (on `withdraw`). The launchpad pays through {graduate}.
    receive() external payable {
        if (msg.sender != address(weth9)) revert UnexpectedEth();
    }

    // ---------------------------------------------------------------------------------------------
    // IGraduator
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IGraduator
    function graduate(address token, uint256 tokenAmount, uint256 targetPriceWei)
        external
        payable
        onlyLaunchpad
        returns (address pool, uint256 tokenId)
    {
        if (msg.value == 0 || tokenAmount == 0) revert ZeroAmount();
        weth9.deposit{value: msg.value}();

        Deployment memory d;
        d.tokenIs0 = token < address(weth9);
        (d.token0, d.token1, d.amount0, d.amount1) = d.tokenIs0
            ? (token, address(weth9), tokenAmount, msg.value)
            : (address(weth9), token, msg.value, tokenAmount);

        pool = _ensurePool(d.token0, d.token1, computeSqrtPriceX96(d.amount0, d.amount1));
        (tokenId, d.used0, d.used1) = _mintFullRange(d);
        positionId[token] = tokenId;
        poolOf[token] = pool;

        (uint256 usedTokens, uint256 usedEth) = d.tokenIs0 ? (d.used0, d.used1) : (d.used1, d.used0);
        _creditEth(token, msg.value - usedEth);
        _burnTokens(token, tokenAmount - usedTokens);

        emit LiquidityDeployed(token, pool, tokenId, usedTokens, usedEth, targetPriceWei);
    }

    /// @inheritdoc IGraduator
    function harvest(address token) external onlyLaunchpad returns (uint256 ethOut, uint256 tokensBurned) {
        uint256 tokenId = positionId[token];
        if (tokenId == 0) revert NoPosition();
        (uint256 amount0, uint256 amount1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        (tokensBurned, ethOut) = token < address(weth9) ? (amount0, amount1) : (amount1, amount0);
        _creditEth(token, ethOut);
        _burnTokens(token, tokensBurned);
        emit FeesHarvested(token, ethOut, tokensBurned);
    }

    // ---------------------------------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------------------------------

    /// @notice Sets the max price deviation (bps, <= 10000) tolerated for pre-existing pools.
    function setMaxDeviationBps(uint16 newMaxDeviationBps) external onlyOwner {
        if (newMaxDeviationBps > BPS) revert InvalidBps();
        maxDeviationBps = newMaxDeviationBps;
        emit MaxDeviationUpdated(newMaxDeviationBps);
    }

    // ---------------------------------------------------------------------------------------------
    // Views / pure helpers
    // ---------------------------------------------------------------------------------------------

    /// @notice Full-range tick bounds for {feeTier}: `(MIN_TICK / spacing) * spacing` and the mirror.
    function tickBounds() public view returns (int24 tickLower, int24 tickUpper) {
        int24 spacing = factory.feeAmountTickSpacing(feeTier);
        if (spacing <= 0) revert InvalidBps();
        // Division first is intentional: round the tick bounds inwards to a multiple of `spacing`.
        // forge-lint: disable-next-line(divide-before-multiply)
        tickLower = (MIN_TICK / spacing) * spacing;
        // forge-lint: disable-next-line(divide-before-multiply)
        tickUpper = (MAX_TICK / spacing) * spacing;
    }

    /// @notice `sqrt(amount1 * 2^192 / amount0)` as a Q64.96 fixed-point number (Uniswap v3 `sqrtPriceX96`).
    function computeSqrtPriceX96(uint256 amount0, uint256 amount1) public pure returns (uint160) {
        uint256 ratioX192 = Math.mulDiv(amount1, 1 << 192, amount0);
        uint256 sqrtPrice = Math.sqrt(ratioX192);
        if (sqrtPrice > type(uint160).max) revert PoolPriceSkewed();
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint160(sqrtPrice);
    }

    /// @inheritdoc IERC721Receiver
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    /// @dev Returns the pool for the pair, creating/initializing it at `sqrtPriceX96` when it has no price
    ///      yet, or checking an existing price against `sqrtPriceX96` (reverts {PoolPriceSkewed}).
    function _ensurePool(address token0, address token1, uint160 sqrtPriceX96) internal returns (address pool) {
        pool = factory.getPool(token0, token1, feeTier);
        uint160 currentSqrtPriceX96;
        if (pool != address(0)) (currentSqrtPriceX96,,,,,,) = IUniswapV3Pool(pool).slot0();
        if (currentSqrtPriceX96 == 0) {
            pool = positionManager.createAndInitializePoolIfNecessary(token0, token1, feeTier, sqrtPriceX96);
        } else {
            _checkDeviation(currentSqrtPriceX96, sqrtPriceX96);
        }
    }

    /// @dev Mints a full-range position to this contract and returns the amounts actually used.
    function _mintFullRange(Deployment memory d) internal returns (uint256 tokenId, uint256 used0, uint256 used1) {
        (int24 tickLower, int24 tickUpper) = tickBounds();
        IERC20(d.token0).forceApprove(address(positionManager), d.amount0);
        IERC20(d.token1).forceApprove(address(positionManager), d.amount1);
        (tokenId,, used0, used1) = positionManager.mint(
            INonfungiblePositionManager.MintParams({
                token0: d.token0,
                token1: d.token1,
                fee: feeTier,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: d.amount0,
                amount1Desired: d.amount1,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(this),
                deadline: block.timestamp
            })
        );
        IERC20(d.token0).forceApprove(address(positionManager), 0);
        IERC20(d.token1).forceApprove(address(positionManager), 0);
    }

    /// @dev Reverts with {PoolPriceSkewed} if `|current^2 / target^2 - 1| > maxDeviationBps / 10000`.
    function _checkDeviation(uint160 current, uint160 target) internal view {
        // A pool price more than 4x the target is always skewed; this guard also keeps mulDiv in range.
        if (current > 2 * uint256(target)) revert PoolPriceSkewed();
        uint256 scaled = Math.mulDiv(current, current, target); // current^2 / target, in units of target
        uint256 diff = scaled > target ? scaled - target : target - scaled;
        if (diff * BPS / target > maxDeviationBps) revert PoolPriceSkewed();
    }

    /// @dev Unwraps `amount` WETH and credits it to `token`'s mind vault.
    function _creditEth(address token, uint256 amount) internal {
        if (amount == 0) return;
        weth9.withdraw(amount);
        IMindLaunchpad(launchpad).creditMind{value: amount}(token);
    }

    /// @dev Burns `amount` of `token` by sending it to {BURN_ADDRESS}.
    function _burnTokens(address token, uint256 amount) internal {
        if (amount == 0) return;
        IERC20(token).safeTransfer(BURN_ADDRESS, amount);
    }
}
