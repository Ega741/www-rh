// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IGraduator} from "./interfaces/IGraduator.sol";
import {INonfungiblePositionManager} from "./interfaces/uniswap/INonfungiblePositionManager.sol";
import {IUniswapV3Factory} from "./interfaces/uniswap/IUniswapV3Factory.sol";
import {IUniswapV3Pool} from "./interfaces/uniswap/IUniswapV3Pool.sol";
import {IWETH9} from "./interfaces/uniswap/IWETH9.sol";

/// @title UniswapV3Graduator
/// @notice Moves a graduated coin's liquidity (`LP_SUPPLY` tokens + the curve's ETH as WETH) into a full-range
///         Uniswap v3 position owned by this contract forever, and harvests the position's fees: the ETH side
///         goes back to the launchpad (credited to the coin's mind vault there), the token side is burned.
/// @dev A pool that already exists and is initialized at another price never blocks graduation (directive D3):
///      the position is minted at the pool's current price with zero minimums, unused ETH is returned to the
///      launchpad, unused tokens are burned, and {GraduatedAtSkewedPrice} is emitted. The LP NFT is never
///      transferred out; nothing in this contract can move it.
contract UniswapV3Graduator is IGraduator, Ownable2Step, IERC721Receiver {
    using SafeERC20 for IERC20;

    /// @dev Uniswap v3 tick bounds (TickMath.MIN_TICK / MAX_TICK).
    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;
    /// @notice Unused and harvested tokens are burned by sending them here.
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @dev Scratch data of one graduation (memory struct keeps the stack shallow).
    struct Deployment {
        address token0;
        address token1;
        uint256 amount0;
        uint256 amount1;
        uint256 used0;
        uint256 used1;
    }

    /// @notice The {MindLaunchpad} allowed to call {graduate} / {harvest}; receives all returned ETH.
    address public immutable launchpad;
    /// @notice Uniswap v3 NonfungiblePositionManager.
    INonfungiblePositionManager public immutable positionManager;
    /// @notice Uniswap v3 factory.
    IUniswapV3Factory public immutable factory;
    /// @notice Canonical WETH9.
    IWETH9 public immutable weth9;
    /// @notice Pool fee tier used for every graduation (e.g. 10000 = 1 %).
    uint24 public immutable feeTier;
    /// @notice Tick spacing of {feeTier}, read from the factory at deployment.
    int24 public immutable tickSpacing;

    /// @notice LP position id per token (0 = not graduated through this contract).
    mapping(address token => uint256) public positionOf;
    /// @notice Pool per token.
    mapping(address token => address) public poolOf;

    /// @notice Liquidity for `token` was deployed into `pool` as position `positionId`.
    event LiquidityDeployed(
        address indexed token,
        address indexed pool,
        uint256 positionId,
        uint256 tokensUsed,
        uint256 ethUsed,
        uint256 ethReturned,
        uint256 tokensBurned
    );
    /// @notice The pool already existed at a price different from the one implied by the graduation amounts;
    ///         liquidity was minted at the pool's price and the leftovers returned (ETH) / burned (tokens).
    event GraduatedAtSkewedPrice(address token, uint160 expectedSqrtPriceX96, uint160 actualSqrtPriceX96);
    /// @notice Position fees of `token` were collected.
    event FeesHarvested(address indexed token, uint256 ethOut, uint256 tokensBurned);
    /// @notice The owner rescued an ERC20 sent here by mistake.
    event ERC20Rescued(address indexed token, address indexed to, uint256 amount);

    /// @notice Caller is not {launchpad}.
    error NotLaunchpad();
    /// @notice `token` has already been graduated through this contract.
    error AlreadyGraduated();
    /// @notice `token` has no position here.
    error NoPosition();
    /// @notice {feeTier} is not enabled on the factory.
    error FeeTierNotEnabled();
    /// @notice A required address is zero.
    error ZeroAddress();
    /// @notice Zero ETH or token amount.
    error ZeroAmount();
    /// @notice Plain ETH is accepted only from WETH9 (unwrapping).
    error UnexpectedEth();
    /// @notice Returning ETH to the launchpad failed.
    error EthTransferFailed();

    modifier onlyLaunchpad() {
        if (msg.sender != launchpad) revert NotLaunchpad();
        _;
    }

    /// @param initialOwner     Initial owner (may rescue stray ERC20s; has no power over positions).
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
            launchpad_ == address(0) || positionManager_ == address(0) || factory_ == address(0)
                || weth9_ == address(0)
        ) revert ZeroAddress();
        int24 spacing = IUniswapV3Factory(factory_).feeAmountTickSpacing(feeTier_);
        if (spacing <= 0) revert FeeTierNotEnabled();
        launchpad = launchpad_;
        positionManager = INonfungiblePositionManager(positionManager_);
        factory = IUniswapV3Factory(factory_);
        weth9 = IWETH9(weth9_);
        feeTier = feeTier_;
        tickSpacing = spacing;
    }

    /// @dev Only WETH9 may push ETH here (on `withdraw`). The launchpad pays through {graduate}.
    receive() external payable {
        if (msg.sender != address(weth9)) revert UnexpectedEth();
    }

    // ---------------------------------------------------------------------------------------------
    // IGraduator
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IGraduator
    /// @dev 1. wrap `msg.value`; 2. order `token0 < token1` and derive `sqrtPriceX96` solely from the amounts;
    ///      3. create/initialize the pool at that price, or use an existing initialized pool at its own price;
    ///      4. mint a full-range position (zero minimums) owned by this contract;
    ///      5. unwrap and return unused ETH to the launchpad, burn unused tokens.
    function graduate(address token, uint256 tokenAmount)
        external
        payable
        onlyLaunchpad
        returns (address pool, uint256 positionId, uint256 ethReturned)
    {
        if (msg.value == 0 || tokenAmount == 0) revert ZeroAmount();
        if (positionOf[token] != 0) revert AlreadyGraduated();
        weth9.deposit{value: msg.value}();

        Deployment memory d;
        bool tokenIs0 = token < address(weth9);
        (d.token0, d.token1, d.amount0, d.amount1) = tokenIs0
            ? (token, address(weth9), tokenAmount, msg.value)
            : (address(weth9), token, msg.value, tokenAmount);

        uint160 expected = computeSqrtPriceX96(d.amount0, d.amount1);
        uint160 actual;
        (pool, actual) = _ensurePool(d.token0, d.token1, expected);

        (positionId, d.used0, d.used1) = _mintFullRange(d);
        positionOf[token] = positionId;
        poolOf[token] = pool;

        (uint256 tokensUsed, uint256 ethUsed) = tokenIs0 ? (d.used0, d.used1) : (d.used1, d.used0);
        ethReturned = msg.value - ethUsed;
        uint256 tokensBurned = tokenAmount - tokensUsed;

        if (actual != expected) emit GraduatedAtSkewedPrice(token, expected, actual);
        emit LiquidityDeployed(token, pool, positionId, tokensUsed, ethUsed, ethReturned, tokensBurned);

        _burnTokens(token, tokensBurned);
        _returnEth(ethReturned);
    }

    /// @inheritdoc IGraduator
    function harvest(address token) external onlyLaunchpad returns (uint256 ethOut, uint256 tokensBurned) {
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
        emit FeesHarvested(token, ethOut, tokensBurned);
        _burnTokens(token, tokensBurned);
        _returnEth(ethOut);
    }

    // ---------------------------------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------------------------------

    /// @notice Rescues an ERC20 sent here by mistake. Between calls this contract holds no graduation tokens or
    ///         WETH (everything is deposited, returned or burned within {graduate}/{harvest}); LP positions are
    ///         ERC721s held by the position manager's ledger and cannot be moved by this function.
    /// @param token  The ERC20 to rescue.
    /// @param to     Recipient.
    /// @param amount Amount to send.
    function rescueERC20(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit ERC20Rescued(token, to, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Views / pure helpers
    // ---------------------------------------------------------------------------------------------

    /// @notice Full-range tick bounds for {tickSpacing}: `(MIN_TICK / spacing) * spacing` and the mirror.
    function tickBounds() public view returns (int24 tickLower, int24 tickUpper) {
        int24 spacing = tickSpacing;
        // Division first is intentional: round the bounds towards zero to a multiple of `spacing`.
        // forge-lint: disable-next-line(divide-before-multiply)
        tickLower = (MIN_TICK / spacing) * spacing;
        // forge-lint: disable-next-line(divide-before-multiply)
        tickUpper = (MAX_TICK / spacing) * spacing;
    }

    /// @notice `sqrt(mulDiv(amount1, 2^192, amount0))` as a Q64.96 number (Uniswap v3 `sqrtPriceX96`), with
    ///         `amount0`/`amount1` the amounts of the ordered `token0 < token1` pair.
    /// @dev Reverts (Math.mulDiv overflow) when `amount1 / amount0 >= 2^64`; graduation amounts are ~5e7 apart at
    ///      most. The square root of a uint256 is below 2^128, so the uint160 cast is lossless.
    function computeSqrtPriceX96(uint256 amount0, uint256 amount1) public pure returns (uint160) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint160(Math.sqrt(Math.mulDiv(amount1, 1 << 192, amount0)));
    }

    /// @inheritdoc IERC721Receiver
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    /// @dev Returns the pool for the pair and its price. A missing or uninitialized pool is created/initialized
    ///      at `expected`; an initialized pool is used as is, at its current price.
    function _ensurePool(address token0, address token1, uint160 expected)
        internal
        returns (address pool, uint160 actual)
    {
        pool = factory.getPool(token0, token1, feeTier);
        if (pool != address(0)) (actual,,,,,,) = IUniswapV3Pool(pool).slot0();
        if (actual == 0) {
            pool = positionManager.createAndInitializePoolIfNecessary(token0, token1, feeTier, expected);
            actual = expected;
        }
    }

    /// @dev Mints a full-range position to this contract and returns the amounts actually used.
    function _mintFullRange(Deployment memory d) internal returns (uint256 positionId, uint256 used0, uint256 used1) {
        (int24 tickLower, int24 tickUpper) = tickBounds();
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

    /// @dev Burns `amount` of `token` by sending it to {BURN_ADDRESS}.
    function _burnTokens(address token, uint256 amount) internal {
        if (amount == 0) return;
        IERC20(token).safeTransfer(BURN_ADDRESS, amount);
    }
}
