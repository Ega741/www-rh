// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IGraduator} from "./interfaces/IGraduator.sol";

/// @title MockGraduator
/// @notice Graduator for testnets without Uniswap v3, local Anvil e2e runs and unit tests: holds the
///         ETH + tokens it receives forever, returns `(pool = address(this), positionId = 0)`, and
///         `harvest` returns `(0, 0)`.
contract MockGraduator is IGraduator {
    /// @notice The only account allowed to call {graduate} / {harvest}.
    address public immutable launchpad;

    /// @notice ETH received per token.
    mapping(address token => uint256) public ethHeld;
    /// @notice Tokens received per token.
    mapping(address token => uint256) public tokensHeld;

    /// @notice Emitted on every {graduate} call.
    event MockGraduated(address indexed token, uint256 tokenAmount, uint256 ethAmount, uint256 targetPriceWei);

    error NotLaunchpad();

    /// @param launchpad_ The {MindLaunchpad} this graduator serves.
    constructor(address launchpad_) {
        launchpad = launchpad_;
    }

    /// @inheritdoc IGraduator
    function graduate(address token, uint256 tokenAmount, uint256 targetPriceWei)
        external
        payable
        returns (address pool, uint256 positionId)
    {
        if (msg.sender != launchpad) revert NotLaunchpad();
        ethHeld[token] += msg.value;
        tokensHeld[token] += tokenAmount;
        emit MockGraduated(token, tokenAmount, msg.value, targetPriceWei);
        return (address(this), 0);
    }

    /// @inheritdoc IGraduator
    function harvest(address) external view returns (uint256 ethOut, uint256 tokensBurned) {
        if (msg.sender != launchpad) revert NotLaunchpad();
        return (0, 0);
    }
}
