// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPriceSource} from "./interfaces/IPriceSource.sol";

/// @title ManualPriceSource
/// @notice Operator-posted USD price with guard rails: the `poster` may move the price at most
///         `maxStepBps` per post and no more often than every `minInterval` seconds. The owner can
///         bypass the rails with {forcePrice} (bootstrap / emergency) and tune them with {setBounds}.
contract ManualPriceSource is Ownable2Step, IPriceSource {
    /// @notice Account allowed to call {post} (the gateway hot wallet).
    address public poster;
    /// @notice Current price, USD per whole token scaled by 1e18; `0` = unavailable.
    uint256 public priceE18;
    /// @notice Timestamp of the last {post} or {forcePrice}.
    uint256 public updatedAt;
    /// @notice Maximum relative move per post, in basis points of the previous price (default 25 %).
    uint16 public maxStepBps = 2500;
    /// @notice Minimum seconds between two posts (default 60).
    uint32 public minInterval = 60;

    /// @notice Emitted by {post}.
    event PricePosted(uint256 priceE18, uint256 updatedAt, address poster);
    /// @notice Emitted by {forcePrice}.
    event PriceForced(uint256 priceE18, uint256 updatedAt);
    /// @notice Emitted by the constructor and {setPoster}.
    event PosterSet(address poster);
    /// @notice Emitted by {setBounds}.
    event BoundsSet(uint16 maxStepBps, uint32 minInterval);

    error NotPoster();
    error ZeroPrice();
    error PriceStepTooLarge(uint256 oldPrice, uint256 newPrice);
    error PostTooSoon(uint256 nextAllowedAt);
    error BadBounds();

    /// @param owner_ Initial owner (Ownable2Step); must be non-zero.
    /// @param poster_ Initial poster; may be zero (posting disabled until {setPoster}).
    constructor(address owner_, address poster_) Ownable(owner_) {
        poster = poster_;
        emit PosterSet(poster_);
    }

    /// @notice Post a new price within the configured bounds. Only the poster.
    /// @dev Bounds apply only once a price exists (`priceE18 != 0`): `|new − old| * 10_000 <= old * maxStepBps`
    ///      and `block.timestamp >= updatedAt + minInterval`.
    /// @param newPriceE18 New price, USD per whole token scaled by 1e18; must be non-zero.
    function post(uint256 newPriceE18) external {
        if (msg.sender != poster) revert NotPoster();
        if (newPriceE18 == 0) revert ZeroPrice();
        uint256 old = priceE18;
        if (old != 0) {
            uint256 diff = newPriceE18 > old ? newPriceE18 - old : old - newPriceE18;
            // diff * 10_000 <= old * maxStepBps  <=>  diff <= floor(old * maxStepBps / 10_000)  (diff is an integer)
            if (diff > Math.mulDiv(old, maxStepBps, 10_000)) revert PriceStepTooLarge(old, newPriceE18);
            uint256 nextAllowedAt = updatedAt + minInterval;
            if (block.timestamp < nextAllowedAt) revert PostTooSoon(nextAllowedAt);
        }
        priceE18 = newPriceE18;
        updatedAt = block.timestamp;
        emit PricePosted(newPriceE18, block.timestamp, msg.sender);
    }

    /// @notice Set the price ignoring the bounds (bootstrap or emergency). Only the owner.
    /// @dev `0` marks the price unavailable, which makes the desk refuse quotes until the next post/force.
    /// @param newPriceE18 New price, USD per whole token scaled by 1e18.
    function forcePrice(uint256 newPriceE18) external onlyOwner {
        priceE18 = newPriceE18;
        updatedAt = block.timestamp;
        emit PriceForced(newPriceE18, block.timestamp);
    }

    /// @notice Replace the poster. Only the owner. Zero disables posting.
    /// @param newPoster Account allowed to call {post}.
    function setPoster(address newPoster) external onlyOwner {
        poster = newPoster;
        emit PosterSet(newPoster);
    }

    /// @notice Replace the guard rails. Only the owner.
    /// @param maxStepBps_ Max relative move per post in bps; `0 < maxStepBps_ <= 10_000`.
    /// @param minInterval_ Minimum seconds between posts.
    function setBounds(uint16 maxStepBps_, uint32 minInterval_) external onlyOwner {
        if (maxStepBps_ == 0 || maxStepBps_ > 10_000) revert BadBounds();
        maxStepBps = maxStepBps_;
        minInterval = minInterval_;
        emit BoundsSet(maxStepBps_, minInterval_);
    }

    /// @inheritdoc IPriceSource
    function latestPrice() external view returns (uint256, uint256) {
        return (priceE18, updatedAt);
    }
}
