// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPonsV2BondingCurve} from "./interfaces/pons/IPonsV2BondingCurve.sol";
import {IPonsV2FeeEscrow} from "./interfaces/pons/IPonsV2FeeEscrow.sol";
import {IPonsV2LaunchFactory} from "./interfaces/pons/IPonsV2LaunchFactory.sol";
import {IPonsV2MemeHook} from "./interfaces/pons/IPonsV2MemeHook.sol";

/// @title MindAccount
/// @notice Per-mind creator fee recipient of a Pons V2 launch (SPEC §9.2, §9.7), deployed by {PonsMindRegistry} as an
///         EIP-1167 clone of one implementation. Pons credits the creator fee share and creator tax to this account in
///         the fee escrow; only the registry can make the account claim them (forwarded to the registry's counted
///         return window), sweep pending Pons fees, hand the recipient role to another address, or move ERC-20 tokens
///         it received (e.g. memecoin from a Pons rescue) to the mind's creator.
/// @dev Holds no ETH between transactions: {claim} forwards its whole balance (escrow payout plus anything sent to
///      it directly) to the registry, which credits it to the mind vault. ETH leaves only through {claim}.
contract MindAccount {
    using SafeERC20 for IERC20;

    address private _registry;

    /// @notice {initialize} was already called (or this is the implementation, locked at construction).
    error AlreadyInitialized();
    /// @notice Caller is not the registry.
    error NotRegistry();
    /// @notice `initialize(address(0))` or `sweepTokens(_, address(0))`.
    error ZeroAddress();
    /// @notice Forwarding the claimed ETH to the registry failed.
    error EthTransferFailed();

    modifier onlyRegistry() {
        if (msg.sender != _registry) revert NotRegistry();
        _;
    }

    /// @dev Locks the implementation: it is bound to the registry that deployed it and can never be initialized.
    ///      Clones run {initialize} against their own (empty) storage.
    constructor() {
        _registry = msg.sender;
    }

    /// @notice Accepts ETH from anyone (escrow payouts; direct transfers are forwarded on the next {claim}).
    receive() external payable {}

    /// @notice Binds a fresh clone to `registry_`. Called by the registry in the transaction that deploys the clone.
    function initialize(address registry_) external {
        if (_registry != address(0)) revert AlreadyInitialized();
        if (registry_ == address(0)) revert ZeroAddress();
        _registry = registry_;
    }

    /// @notice The registry controlling this account.
    function registry() external view returns (address) {
        return _registry;
    }

    /// @notice Registry only: claims this account's ETH balance from `escrow` (skipped when it is zero) and sends the
    ///         account's whole ETH balance to the registry with a full-gas call.
    /// @return amount Wei sent to the registry.
    function claim(IPonsV2FeeEscrow escrow) external onlyRegistry returns (uint256 amount) {
        if (escrow.balanceOf(address(this)) != 0) escrow.claim();
        amount = address(this).balance;
        if (amount != 0) {
            (bool ok,) = msg.sender.call{value: amount}("");
            if (!ok) revert EthTransferFailed();
        }
    }

    /// @notice Registry only: `curve.sweepFees(minBuybackTokensOut)` as the curve's creator fee recipient (Pons lets
    ///         the current recipient sweep when no internal buyback is pending).
    function sweepCurve(IPonsV2BondingCurve curve, uint256 minBuybackTokensOut) external onlyRegistry {
        curve.sweepFees(minBuybackTokensOut);
    }

    /// @notice Registry only: `hook.sweepPoolFees(...)` as the graduated pool's creator.
    function sweepPool(IPonsV2MemeHook hook, bytes32 poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut)
        external
        onlyRegistry
    {
        hook.sweepPoolFees(poolId, minConversionQuoteOut, minBuybackTokensOut);
    }

    /// @notice Registry only: `factory.transferCreatorFeeRecipient(token, to)` as the current recipient.
    function transferFeeRecipient(IPonsV2LaunchFactory factory, address token, address to) external onlyRegistry {
        factory.transferCreatorFeeRecipient(token, to);
    }

    /// @notice Registry only: transfers this account's whole balance of `erc20` to `to` (nothing when it is zero).
    ///         Never moves ETH.
    function sweepTokens(address erc20, address to) external onlyRegistry {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = IERC20(erc20).balanceOf(address(this));
        if (amount != 0) IERC20(erc20).safeTransfer(to, amount);
    }
}
