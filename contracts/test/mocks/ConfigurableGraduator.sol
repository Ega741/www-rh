// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IGraduator} from "../../src/interfaces/IGraduator.sol";

/// @notice Test graduator with knobs: how much ETH it sends back on {graduate}/{harvest} and how much it
///         *reports* (to exercise the launchpad's balance check).
contract ConfigurableGraduator is IGraduator {
    address public immutable launchpad;

    uint256 public returnBps; // share of msg.value sent back on graduate
    int256 public reportDelta; // reported = sent + delta
    uint256 public harvestEth; // ETH sent back on harvest (from this contract's balance)
    uint256 public harvestTokens; // reported tokensBurned
    uint256 public positionToReturn = 7;
    bool public sendExtraOnGraduate; // also push `extra` of own ETH back on graduate
    uint256 public extra;

    error NotLaunchpad();
    error SendFailed();

    constructor(address launchpad_) {
        launchpad = launchpad_;
    }

    receive() external payable {}

    function setGraduateBehaviour(uint256 returnBps_, int256 reportDelta_) external {
        returnBps = returnBps_;
        reportDelta = reportDelta_;
    }

    function setExtra(uint256 extra_) external {
        sendExtraOnGraduate = extra_ > 0;
        extra = extra_;
    }

    function setHarvestBehaviour(uint256 harvestEth_, uint256 harvestTokens_, int256 reportDelta_) external {
        harvestEth = harvestEth_;
        harvestTokens = harvestTokens_;
        reportDelta = reportDelta_;
    }

    /// @inheritdoc IGraduator
    function graduate(address, uint256) external payable returns (address pool, uint256 positionId, uint256 ethReturned) {
        if (msg.sender != launchpad) revert NotLaunchpad();
        uint256 sent = msg.value * returnBps / 10_000;
        if (sendExtraOnGraduate) sent += extra;
        _send(sent);
        return (address(this), positionToReturn, _report(sent));
    }

    /// @inheritdoc IGraduator
    function harvest(address) external returns (uint256 ethOut, uint256 tokensBurned) {
        if (msg.sender != launchpad) revert NotLaunchpad();
        _send(harvestEth);
        return (_report(harvestEth), harvestTokens);
    }

    /// @dev `actual + reportDelta` (test amounts are far below 2^255).
    function _report(uint256 actual) internal view returns (uint256) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint256(int256(actual) + reportDelta);
    }

    function _send(uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = launchpad.call{value: amount}("");
        if (!ok) revert SendFailed();
    }
}
