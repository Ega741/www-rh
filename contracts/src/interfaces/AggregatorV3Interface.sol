// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title AggregatorV3Interface
/// @notice Minimal subset of the Chainlink aggregator interface used by `ChainlinkPriceSource`.
interface AggregatorV3Interface {
    /// @notice Number of decimals in `answer`.
    function decimals() external view returns (uint8);

    /// @notice Data of the latest completed round.
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
