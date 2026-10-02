// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPonsV2FeeEscrow} from "../../../src/interfaces/pons/IPonsV2FeeEscrow.sol";

/// @notice Model of `PonsV2FeeEscrow` (native side): permissionless crediting with attached ETH, claims paid to the
///         caller with a full-gas ETH call, `NoBalance()` when there is nothing to claim.
contract MockPonsFeeEscrow is IPonsV2FeeEscrow, ReentrancyGuard {
    mapping(address recipient => uint256) private _balances;

    error NoBalance();
    error TransferFailed();
    error ZeroAddress();
    error InsufficientBalance(uint256 requested, uint256 available);

    function credit(address recipient) external payable {
        if (recipient == address(0)) revert ZeroAddress();
        _balances[recipient] += msg.value;
        emit Credited(recipient, msg.sender, msg.value);
    }

    function claim() external nonReentrant returns (uint256 amount) {
        amount = _balances[msg.sender];
        if (amount == 0) revert NoBalance();
        _pay(amount);
    }

    function claim(uint256 amount) external nonReentrant returns (uint256) {
        uint256 available = _balances[msg.sender];
        if (amount == 0 || available == 0) revert NoBalance();
        if (amount > available) revert InsufficientBalance(amount, available);
        _pay(amount);
        return amount;
    }

    function balanceOf(address recipient) external view returns (uint256) {
        return _balances[recipient];
    }

    function _pay(uint256 amount) private {
        _balances[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Claimed(msg.sender, amount);
    }
}
