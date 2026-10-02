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
import {IUniswapV3Pool} from "./interfaces/uniswap/IUniswapV3Pool.sol";
import {IWETH9} from "./interfaces/uniswap/IWETH9.sol";

/// @title UniswapV3Graduator
/// @notice Moves a graduated coin's liquidity (`LP_SUPPLY` tokens + the curve's ETH as WETH) into a full-range
///         Uniswap v3 position owned by this contract forever, and harvests the position's fees: the ETH side
///         goes back to the launchpad (credited to the coin's mind vault there), the token side is burned
///         (SPEC §2.4).
/// @dev A pool that already exists and is initialized at another price never blocks graduation (directive D3):
///      the position is minted at the pool's current price with zero minimums, unused ETH is returned to the
///      launchpad, unused tokens are burned, and {GraduatedAtSkewedPrice} is emitted. The owner has no privileged
///      function in this version; the LP NFT can never leave this contract.
contract UniswapV3Graduator is IGraduator, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Uniswap v3 `TickMath.MIN_TICK`.
    int24 internal constant MIN_TICK = -887272;
    /// @dev Unused and harvested tokens are burned by sending them here.
    address internal constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @dev Scratch data of one graduation (memory struct keeps the stack shallow).
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

    /// @notice LP position id per token (0 = not graduated through this contract).
    mapping(address token => uint256) public positionOf;
    /// @notice Pool per token.
    mapping(address token => address) public poolOf;

    /// @notice The pool already existed at a price different from the one implied by the graduation amounts;
    ///         liquidity was minted at the pool's price and the leftovers returned (ETH) / burned (tokens).
    event GraduatedAtSkewedPrice(address indexed token, uint160 expectedSqrtPriceX96, uint160 actualSqrtPriceX96);

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

    modifier onlyLaunchpad() {
        if (msg.sender != launchpad) revert NotLaunchpad();
        _;
    }

    /// @param initialOwner     Initial owner (Ownable2Step; no privileged functions in this version).
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
    }

    /// @dev Only WETH9 may push ETH here (on `withdraw`). The launchpad pays through {graduate}.
    receive() external payable {
        if (msg.sender != address(weth9)) revert UnexpectedEthSender();
    }

    // ---------------------------------------------------------------------------------------------
    // IGraduator
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IGraduator
    /// @dev 1. wrap `msg.value`; 2. order `token0 < token1` and derive `sqrtPriceX96` solely from the amounts;
    ///      3. create/initialize the pool at that price if needed (an initialized pool keeps its own price);
    ///      4. mint a full-range position (zero minimums) owned by this contract;
    ///      5. unwrap and return unused ETH to the launchpad, burn unused tokens.
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
        (uint160 actual,,,,,,) = IUniswapV3Pool(pool).slot0();
        if (actual != expected) emit GraduatedAtSkewedPrice(token, expected, actual);

        (positionId, d.used0, d.used1) = _mintFullRange(d);
        positionOf[token] = positionId;
        poolOf[token] = pool;

        (uint256 tokensUsed, uint256 ethUsed) = tokenIs0 ? (d.used0, d.used1) : (d.used1, d.used0);
        ethReturned = msg.value - ethUsed;
        _burnTokens(token, tokenAmount - tokensUsed);
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
    // Internals
    // ---------------------------------------------------------------------------------------------

    /// @dev Mints a full-range position to this contract and returns the amounts actually used.
    function _mintFullRange(Deployment memory d) internal returns (uint256 positionId, uint256 used0, uint256 used1) {
        IERC20(d.token0).forceApprove(address(positionManager), d.amount0);
        IERC20(d.token1).forceApprove(address(positionManager), d.amount1);
        (positionId,, used0, used1) = positionManager.mint(
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

    /// @dev Unwraps `amount` WETH and sends the ETH to the launchpad (accepted by its graduator-gated `receive`).
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
