// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {IPriceSource} from "./interfaces/IPriceSource.sol";

/// @title ChainlinkPriceSource
/// @notice Adapts a Chainlink `AggregatorV3Interface` feed quoting the credit token in USD to {IPriceSource}.
/// @dev Non-positive answers are reported as unavailable (`priceE18 == 0`); the feed's `updatedAt` is passed
///      through so the desk applies its own staleness window.
contract ChainlinkPriceSource is IPriceSource {
    /// @notice The Chainlink feed (TOKEN / USD).
    AggregatorV3Interface public immutable feed;
    /// @notice Decimals of the feed's answer, read once at construction.
    uint8 public immutable feedDecimals;

    error ZeroAddress();
    error BadDecimals();

    /// @param feed_ Chainlink aggregator quoting the token in USD; must be non-zero with `decimals() <= 36`.
    constructor(AggregatorV3Interface feed_) {
        if (address(feed_) == address(0)) revert ZeroAddress();
        uint8 d = feed_.decimals();
        if (d > 36) revert BadDecimals();
        feed = feed_;
        feedDecimals = d;
    }

    /// @inheritdoc IPriceSource
    function latestPrice() external view returns (uint256 priceE18, uint256 updatedAt) {
        (, int256 answer,, uint256 ts,) = feed.latestRoundData();
        if (answer <= 0) return (0, ts);
        uint256 a = uint256(answer);
        if (feedDecimals == 18) priceE18 = a;
        else if (feedDecimals < 18) priceE18 = a * 10 ** (18 - uint256(feedDecimals));
        else priceE18 = a / 10 ** (uint256(feedDecimals) - 18);
        updatedAt = ts;
    }
}
