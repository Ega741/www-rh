// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";

/// @title MockAggregatorV3
/// @notice Settable Chainlink-style aggregator for tests.
contract MockAggregatorV3 is AggregatorV3Interface {
    uint8 private immutable _decimals;
    uint80 public roundId;
    int256 public answer;
    uint256 public updatedAt;

    constructor(uint8 decimals_) {
        _decimals = decimals_;
    }

    /// @notice Set the next round's data.
    function set(int256 answer_, uint256 updatedAt_) external {
        roundId++;
        answer = answer_;
        updatedAt = updatedAt_;
    }

    /// @inheritdoc AggregatorV3Interface
    function decimals() external view returns (uint8) {
        return _decimals;
    }

    /// @inheritdoc AggregatorV3Interface
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }
}
