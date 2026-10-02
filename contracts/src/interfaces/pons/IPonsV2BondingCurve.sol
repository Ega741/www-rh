// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPonsV2BondingCurve
/// @notice Minimal local interface of a Pons V2 launch's `PonsV2BondingCurve` (one per launch) with only the members
///         SPEC §9.1 relies on. Native-quote launches: `buy` requires `msg.value == quoteIn` and refunds unspent quote
///         to `msg.sender`; fees and creator tax are charged on the quote leg and credited to the fee escrow on
///         `sweepFees` (callable by Pons' fee sweep operator or the curve's current creator fee recipient).
interface IPonsV2BondingCurve {
    /// @notice A buy: `quoteIn` = quote actually spent (fee and tax included, refund excluded).
    event CurveBuy(
        address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax
    );
    /// @notice A sell: `quoteOut` = quote paid out (fee and tax excluded).
    event CurveSell(
        address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax
    );
    /// @notice A capped buy refunded `refund` of unspent quote to `buyer` (the caller of `buy`).
    event CurveBuyRefunded(address indexed buyer, uint256 refund);
    /// @notice Pending fees were distributed (creator share credited to the creator fee recipient in the escrow).
    event FeesSwept(uint256 protocolAmount, uint256 buybackAmount, uint256 creatorAmount);
    /// @notice The curve graduated: reserves handed to `recipient` (the factory).
    event CurveCompleted(address recipient, uint256 quoteOut, uint256 tokenOut);

    /// @notice Buys with `quoteIn` of the quote asset (`msg.value == quoteIn` for native launches); a buy that would
    ///         exceed {sellableTokens} is filled up to it and the rest refunded to `msg.sender`.
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256 tokensOut);
    /// @notice Sells `tokensIn` (pulled with `transferFrom`) for quote paid to `recipient`.
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256 quoteOut);
    /// @notice Tradeable reserves: quote includes the phantom reserve and excludes pending fees.
    function getReserves() external view returns (uint256 quoteReserve_, uint256 tokenReserve_);
    /// @notice Tokens still buyable before graduation.
    function sellableTokens() external view returns (uint256);
    /// @notice Base trade fee (bps of the quote leg).
    function feeBps() external view returns (uint256);
    /// @notice Creator tax (bps of the quote leg).
    function creatorTaxBps() external view returns (uint256);
    /// @notice Whether the curve has graduated (trading halted).
    function graduated() external view returns (bool);
    /// @notice Whether the sellable allocation is exhausted but the curve has not graduated yet.
    function readyToGraduate() external view returns (bool);
    /// @notice Real quote reserve at which the curve graduates.
    function graduationThreshold() external view returns (uint256);
    /// @notice Real quote held from trading, net of pending fees and tax.
    function realQuoteReserve() external view returns (uint256);
    /// @notice Distributes pending fees through the escrow; reverts `NotFeeSweepOperator()` for unauthorized callers.
    function sweepFees(uint256 minBuybackTokensOut) external;
}
