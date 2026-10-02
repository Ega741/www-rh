// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IMindCore} from "./IMindCore.sol";

/// @title IMindLaunchpad
/// @notice External interface of {MindLaunchpad}: token factory + bonding curve + fee router + mind vault +
///         mind registry of "worldwideweb on Robinhood Chain". The venue-independent part (mind registry, vault,
///         roles, shared events/errors) is {IMindCore}; this interface adds the bonding curve and graduation
///         (SPEC §2.3).
interface IMindLaunchpad is IMindCore {
    // ---------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------

    /// @notice Lifecycle of a coin's bonding curve.
    enum CurvePhase {
        Bonding,
        Complete,
        Graduated
    }

    /// @notice Bonding-curve state of a coin.
    struct CurveState {
        uint128 realEthReserve;
        uint128 tokensSold;
        CurvePhase phase;
        address pool; // after graduation
        uint256 positionId; // after graduation (0 for MockGraduator)
    }

    /// @notice Protocol fee parameters, all in basis points.
    struct FeeParams {
        uint16 tradeFeeBps;
        uint16 mindShareBps;
        uint16 graduationFeeBps;
    }

    // ---------------------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------------------

    /// @notice A curve trade. `ethAmount` = ETH used (buy, after refund) or ETH paid out (sell);
    ///         `fee` = total fee; `realEthReserve`/`tokensSold` = curve state after the trade.
    event Trade(
        address indexed token,
        address indexed trader,
        bool isBuy,
        uint256 ethAmount,
        uint256 tokenAmount,
        uint256 fee,
        uint256 realEthReserve,
        uint256 tokensSold
    );
    /// @notice The curve sold out (`tokensSold == CURVE_SUPPLY`); the coin can now be graduated.
    event CurveCompleted(address indexed token, uint256 realEthReserve);
    /// @notice A `Complete` curve that was not graduated within `graduationGrace()` was reopened by a sell: the
    ///         phase is `Bonding` again (emitted before that sell's `FeeAccrued`/`Trade`).
    event CurveReopened(address indexed token);
    /// @notice The coin's liquidity was moved to the DEX through `graduatorOf(token)`.
    event Graduated(
        address indexed token,
        address pool,
        uint256 positionId,
        uint256 ethLiquidity,
        uint256 tokenLiquidity,
        uint256 graduationFee
    );
    /// @notice The graduator used for future graduations changed.
    event GraduatorUpdated(address newGraduator);
    /// @notice Fee parameters changed.
    event FeeParamsUpdated(uint16 tradeFeeBps, uint16 mindShareBps, uint16 graduationFeeBps);
    /// @notice The graduation grace period (after which a `Complete` curve accepts sells again) changed.
    event GraduationGraceUpdated(uint32 graceSeconds);

    // ---------------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------------

    /// @notice The curve is not in the phase required by the call.
    error WrongPhase();
    /// @notice Output below the caller's minimum.
    error Slippage();
    /// @notice `block.timestamp > deadline`.
    error Expired();
    /// @notice `setGraduationGrace` outside [1 hour, 30 days].
    error InvalidGraduationGrace();
    /// @notice `setGraduator` with a non-zero address that has no code or whose `launchpad()` is not this
    ///         launchpad.
    error InvalidGraduator();
    /// @notice Bubbled up from `UniswapV3Graduator.graduate` (declared here so clients can decode `graduate`
    ///         reverts): the DEX pool's price could not be brought within the graduator's tolerance of the price
    ///         implied by the graduation amounts. The coin stays `Complete`; anyone may retry later.
    error PoolPriceSkewed(uint160 expectedSqrtPriceX96, uint160 actualSqrtPriceX96);
    /// @notice `msg.value < creationFee()`.
    error InsufficientCreationFee();
    /// @notice No graduator is configured.
    error GraduatorNotSet();
    /// @notice `sell`/`quoteSell` with more tokens than the curve has sold.
    error ExceedsTokensSold();

    // ---------------------------------------------------------------------------------------------
    // User
    // ---------------------------------------------------------------------------------------------

    /// @notice Creates a new coin + mind. `msg.value >= creationFee()`; the remainder
    ///         (`msg.value - creationFee`) is an initial buy for `msg.sender` (skipped when 0).
    /// @param name         ERC20 name (1..64 bytes).
    /// @param symbol       ERC20 symbol (1..16 bytes).
    /// @param metadataURI  URI of the metadata JSON (at most 2048 bytes).
    /// @param modelId      keccak256 of the model id string (non-zero).
    /// @param personaHash  keccak256 of the persona prompt text.
    /// @param minTokensOut Slippage bound for the initial buy (ignored when there is none).
    /// @return token       Address of the new {MindToken}.
    function createMind(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        bytes32 modelId,
        bytes32 personaHash,
        uint256 minTokensOut
    ) external payable returns (address token);

    /// @notice Buys `token` on its bonding curve with `msg.value`. ETH not needed by the completing buy is
    ///         refunded.
    /// @param token        The coin.
    /// @param minTokensOut Minimum tokens to receive, else `Slippage()`.
    /// @param deadline     Unix timestamp after which the call reverts with `Expired()`.
    /// @return tokensOut   Tokens received.
    function buy(address token, uint256 minTokensOut, uint256 deadline) external payable returns (uint256 tokensOut);

    /// @notice Sells `tokensIn` of `token` on its bonding curve. Tokens are pulled with `transferFrom`
    ///         (approve the launchpad first); ETH is sent with `call{value}`. Allowed while `Bonding`, and while
    ///         `Complete` once `block.timestamp >= completedAt(token) + graduationGrace()` (escape hatch for a
    ///         coin that could not be graduated): such a sell first reopens the curve (phase `Bonding`,
    ///         `CurveReopened`).
    /// @param token     The coin.
    /// @param tokensIn  Tokens to sell.
    /// @param minEthOut Minimum ETH to receive, else `Slippage()`.
    /// @param deadline  Unix timestamp after which the call reverts with `Expired()`.
    /// @return ethOut   ETH received (net of fee).
    function sell(address token, uint256 tokensIn, uint256 minEthOut, uint256 deadline)
        external
        returns (uint256 ethOut);

    /// @notice Permissionless. Moves a `Complete` curve to the DEX through the current graduator, which is
    ///         recorded as `graduatorOf(token)`. ETH returned by the graduator is credited to the mind vault.
    /// @param token The coin.
    function graduate(address token) external;

    /// @notice Permissionless. Collects DEX fees of a `Graduated` coin through `graduatorOf(token)`; the ETH
    ///         side is credited to the mind vault, the token side is burned by the graduator.
    /// @param token The coin.
    function harvest(address token) external;

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice Quotes a buy of `ethIn` wei on `token`'s curve (SPEC §1). Reverts `WrongPhase()` unless Bonding and
    ///         `ZeroAmount()` for `ethIn == 0`.
    /// @return tokensOut Tokens out (capped at the remaining curve supply).
    /// @return ethUsed   ETH consumed including the fee; `ethIn - ethUsed` would be refunded.
    /// @return fee       Total fee included in `ethUsed`.
    function quoteBuy(address token, uint256 ethIn)
        external
        view
        returns (uint256 tokensOut, uint256 ethUsed, uint256 fee);

    /// @notice Quotes a sell of `tokensIn` on `token`'s curve (SPEC §1). Reverts `WrongPhase()` unless Bonding or
    ///         Complete past the graduation grace (same rule as {sell}), `ZeroAmount()` for `tokensIn == 0` and
    ///         `ExceedsTokensSold()` above `tokensSold`.
    /// @return ethOut ETH out, net of fee.
    /// @return fee    Fee taken.
    function quoteSell(address token, uint256 tokensIn) external view returns (uint256 ethOut, uint256 fee);

    /// @notice Current curve price in wei per 1e18 tokens (`x * 1e18 / y`). Reverts `WrongPhase()` once Graduated.
    function currentPrice(address token) external view returns (uint256 weiPer1e18Tokens);

    /// @notice Curve state of `token` (zero struct when not a mind).
    function getCurve(address token) external view returns (CurveState memory);

    /// @notice Current fee parameters.
    function feeParams() external view returns (FeeParams memory);

    /// @notice Graduator used for future graduations (`address(0)` = graduation disabled).
    function graduator() external view returns (address);

    /// @notice Graduator that holds `token`'s DEX liquidity (`address(0)` until graduated).
    function graduatorOf(address token) external view returns (address);

    /// @notice `block.timestamp` at which `token`'s curve last completed (0 while it never completed or after a
    ///         post-grace sell reopened it; kept after graduation).
    function completedAt(address token) external view returns (uint64);

    /// @notice Seconds after completion during which a `Complete` curve only waits for `graduate`; afterwards
    ///         sells are allowed again (they reopen the curve).
    function graduationGrace() external view returns (uint32);

    // solhint-disable func-name-mixedcase
    /// @notice Virtual ETH reserve (x0).
    function VIRTUAL_ETH() external view returns (uint256);
    /// @notice Virtual token reserve (y0).
    function VIRTUAL_TOKENS() external view returns (uint256);
    /// @notice Tokens sold on the curve.
    function CURVE_SUPPLY() external view returns (uint256);
    /// @notice Tokens sent to the DEX at graduation.
    function LP_SUPPLY() external view returns (uint256);
    /// @notice Total supply of every coin.
    function TOTAL_SUPPLY() external view returns (uint256);
    // solhint-enable func-name-mixedcase

    // ---------------------------------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------------------------------

    /// @notice Sets the graduator for future graduations; `address(0)` disables graduation. A non-zero graduator
    ///         must be a contract whose `launchpad()` is this launchpad, else `InvalidGraduator()`.
    function setGraduator(address newGraduator) external;
    /// @notice Bounds: trade <= 500, mindShare <= 10000, graduation <= 1000 (bps).
    function setFeeParams(FeeParams calldata params) external;
    /// @notice Sets the graduation grace period, within [1 hour, 30 days]. Applies to every `Complete` curve,
    ///         including those already waiting.
    function setGraduationGrace(uint32 graceSeconds) external;
}
