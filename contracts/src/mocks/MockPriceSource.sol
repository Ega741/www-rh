// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPriceSource} from "../interfaces/IPriceSource.sol";

/// @title MockPriceSource
/// @notice {IPriceSource} with a freely settable `(priceE18, updatedAt)` pair for tests.
contract MockPriceSource is IPriceSource {
    uint256 public priceE18;
    uint256 public updatedAt;

    constructor(uint256 priceE18_, uint256 updatedAt_) {
        priceE18 = priceE18_;
        updatedAt = updatedAt_;
    }

    /// @notice Set the reported pair.
    function set(uint256 priceE18_, uint256 updatedAt_) external {
        priceE18 = priceE18_;
        updatedAt = updatedAt_;
    }

    /// @inheritdoc IPriceSource
    function latestPrice() external view returns (uint256, uint256) {
        return (priceE18, updatedAt);
    }
}
