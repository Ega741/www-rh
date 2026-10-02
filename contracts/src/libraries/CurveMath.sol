// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title CurveMath
/// @notice Pure constant-product bonding-curve math with virtual reserves (SPEC §1). Used by
///         {MindLaunchpad} and by the fixture generator; mirrored bit-for-bit by the TypeScript package `packages/shared` (curve.ts).
/// @dev Let `x = VIRTUAL_ETH + realEthReserve`, `y = VIRTUAL_TOKENS - tokensSold`, `k = x*y`.
///      Rounding always favours the contract, so `k` never decreases across trades.
library CurveMath {
    /// @notice Minted once to the launchpad at creation.
    uint256 internal constant TOTAL_SUPPLY = 1_000_000_000e18;
    /// @notice Sold on the bonding curve.
    uint256 internal constant CURVE_SUPPLY = 800_000_000e18;
    /// @notice Reserved; goes to the DEX at graduation.
    uint256 internal constant LP_SUPPLY = 200_000_000e18;
    /// @notice Virtual ETH reserve (x0).
    uint256 internal constant VIRTUAL_ETH = 1.365 ether;
    /// @notice Virtual token reserve (y0).
    uint256 internal constant VIRTUAL_TOKENS = 1_073_000_000e18;
    /// @notice Basis points denominator.
    uint256 internal constant BPS = 10_000;

    /// @notice Quotes a buy.
    /// @param realEthReserve Current real ETH reserve of the curve.
    /// @param tokensSold     Tokens sold so far (<= CURVE_SUPPLY).
    /// @param ethIn          ETH offered by the buyer (wei).
    /// @param tradeFeeBps    Trade fee in bps.
    /// @return tokensOut Tokens the buyer receives (capped at the remaining curve supply).
    /// @return ethUsed   ETH actually consumed (`ethIn` unless the buy completes the curve); `ethIn - ethUsed`
    ///                   is refunded by the launchpad.
    /// @return fee       Total fee included in `ethUsed`; `ethUsed - fee` is added to the real reserve.
    /// @dev On the completing buy: `net' = ceilDiv(k, y - tokensOut) - x`,
    ///      `fee' = ceilDiv(net' * tradeFeeBps, BPS - tradeFeeBps)`, `ethUsed = net' + fee'`. Because
    ///      `fee` on the non-capped path is floored while `fee'` is ceiled, `net' + fee'` can exceed `ethIn`
    ///      by at most 2 wei when `net' == net`; in that case `ethUsed` is clamped to `ethIn` and the fee
    ///      absorbs the difference (`fee = ethIn - net'`), which keeps `net'` — and therefore `k` — exact.
    function quoteBuy(uint256 realEthReserve, uint256 tokensSold, uint256 ethIn, uint256 tradeFeeBps)
        internal
        pure
        returns (uint256 tokensOut, uint256 ethUsed, uint256 fee)
    {
        uint256 x = VIRTUAL_ETH + realEthReserve;
        uint256 y = VIRTUAL_TOKENS - tokensSold;
        uint256 k = x * y;

        fee = ethIn * tradeFeeBps / BPS;
        uint256 net = ethIn - fee;
        tokensOut = y - Math.ceilDiv(k, x + net);

        uint256 remaining = CURVE_SUPPLY - tokensSold;
        if (tokensOut > remaining) {
            tokensOut = remaining;
            uint256 netCapped = Math.ceilDiv(k, y - remaining) - x;
            uint256 feeCapped = Math.ceilDiv(netCapped * tradeFeeBps, BPS - tradeFeeBps);
            ethUsed = netCapped + feeCapped;
            if (ethUsed > ethIn) {
                ethUsed = ethIn;
                feeCapped = ethIn - netCapped;
            }
            fee = feeCapped;
        } else {
            ethUsed = ethIn;
        }
    }

    /// @notice Quotes a sell. Precondition: `tokensIn <= tokensSold` (the launchpad enforces it).
    /// @param realEthReserve Current real ETH reserve of the curve.
    /// @param tokensSold     Tokens sold so far.
    /// @param tokensIn       Tokens the seller gives back.
    /// @param tradeFeeBps    Trade fee in bps.
    /// @return ethOut ETH the seller receives (net of fee).
    /// @return fee    Fee taken; `ethOut + fee` is removed from the real reserve.
    function quoteSell(uint256 realEthReserve, uint256 tokensSold, uint256 tokensIn, uint256 tradeFeeBps)
        internal
        pure
        returns (uint256 ethOut, uint256 fee)
    {
        uint256 x = VIRTUAL_ETH + realEthReserve;
        uint256 y = VIRTUAL_TOKENS - tokensSold;
        uint256 k = x * y;

        uint256 ethGross = x - Math.ceilDiv(k, y + tokensIn);
        fee = ethGross * tradeFeeBps / BPS;
        ethOut = ethGross - fee;
    }

    /// @notice ETH (fee included) needed to buy exactly `tokensOut` tokens:
    ///         `net = ceilDiv(k, y - tokensOut) - x`, `fee = ceilDiv(net * tradeFeeBps, BPS - tradeFeeBps)`,
    ///         returns `net + fee` (the gross-up used for the completing buy). Precondition:
    ///         `tokensOut <= CURVE_SUPPLY - tokensSold`.
    function ethForTokens(uint256 realEthReserve, uint256 tokensSold, uint256 tokensOut, uint256 tradeFeeBps)
        internal
        pure
        returns (uint256)
    {
        uint256 x = VIRTUAL_ETH + realEthReserve;
        uint256 y = VIRTUAL_TOKENS - tokensSold;
        uint256 net = Math.ceilDiv(x * y, y - tokensOut) - x;
        return net + Math.ceilDiv(net * tradeFeeBps, BPS - tradeFeeBps);
    }

    /// @notice The smallest `ethIn` for which {quoteBuy} sells out the curve from the given state.
    /// @dev The completing net amount is `netNeeded = ceilDiv(k, y - remaining) - x`; the buy completes iff
    ///      `ethIn - ethIn * tradeFeeBps / BPS >= netNeeded`. That left side is non-decreasing in `ethIn` (it grows
    ///      by 0 or 1 per wei), so starting from the gross-up {ethForTokens} a few single-wei steps reach the
    ///      exact minimum. Precondition: `tokensSold < CURVE_SUPPLY`.
    function minEthToComplete(uint256 realEthReserve, uint256 tokensSold, uint256 tradeFeeBps)
        internal
        pure
        returns (uint256 ethIn)
    {
        uint256 x = VIRTUAL_ETH + realEthReserve;
        uint256 y = VIRTUAL_TOKENS - tokensSold;
        uint256 netNeeded = Math.ceilDiv(x * y, y - (CURVE_SUPPLY - tokensSold)) - x;
        ethIn = netNeeded + Math.ceilDiv(netNeeded * tradeFeeBps, BPS - tradeFeeBps);
        while (_netOf(ethIn, tradeFeeBps) < netNeeded) {
            ++ethIn;
        }
        while (ethIn > 0 && _netOf(ethIn - 1, tradeFeeBps) >= netNeeded) {
            --ethIn;
        }
    }

    /// @notice Spot price in wei per 1e18 tokens: `x * 1e18 / y`.
    function price(uint256 realEthReserve, uint256 tokensSold) internal pure returns (uint256) {
        return (VIRTUAL_ETH + realEthReserve) * 1e18 / (VIRTUAL_TOKENS - tokensSold);
    }

    /// @notice Display market cap in wei: `price * TOTAL_SUPPLY / 1e18`.
    function marketCap(uint256 realEthReserve, uint256 tokensSold) internal pure returns (uint256) {
        return price(realEthReserve, tokensSold) * TOTAL_SUPPLY / 1e18;
    }

    /// @notice Progress to graduation in bps: `tokensSold * 10000 / CURVE_SUPPLY`.
    function progressBps(uint256 tokensSold) internal pure returns (uint256) {
        return tokensSold * BPS / CURVE_SUPPLY;
    }

    /// @dev `ethIn` net of the (floored) trade fee.
    function _netOf(uint256 ethIn, uint256 tradeFeeBps) private pure returns (uint256) {
        return ethIn - ethIn * tradeFeeBps / BPS;
    }

    /// @notice Splits `fee` between the mind vault and the protocol.
    /// @return mindAmount     `fee * mindShareBps / 10000`.
    /// @return protocolAmount `fee - mindAmount`.
    function splitFee(uint256 fee, uint256 mindShareBps)
        internal
        pure
        returns (uint256 mindAmount, uint256 protocolAmount)
    {
        mindAmount = fee * mindShareBps / BPS;
        protocolAmount = fee - mindAmount;
    }
}
