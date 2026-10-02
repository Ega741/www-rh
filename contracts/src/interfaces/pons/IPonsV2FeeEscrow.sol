// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPonsV2FeeEscrow
/// @notice Minimal local interface of Pons V2's claimable fee ledger (`PonsV2FeeEscrow`, Robinhood Chain 4663:
///         0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e), native ETH side only (SPEC §9.1).
interface IPonsV2FeeEscrow {
    /// @notice `amount` wei was credited to `recipient` by `depositor`.
    event Credited(address indexed recipient, address indexed depositor, uint256 amount);
    /// @notice `recipient` claimed `amount` wei.
    event Claimed(address indexed recipient, uint256 amount);

    /// @notice Credits `msg.value` to `recipient` (permissionless).
    function credit(address recipient) external payable;
    /// @notice Pays the caller's whole ETH balance to the caller with an ETH call and returns it.
    function claim() external returns (uint256 amount);
    /// @notice Claimable ETH balance of `recipient`.
    function balanceOf(address recipient) external view returns (uint256);
}
