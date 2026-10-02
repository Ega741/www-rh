// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title IWETH9
/// @notice Minimal canonical WETH9 interface.
interface IWETH9 is IERC20 {
    /// @notice Wraps `msg.value` ETH into WETH credited to the caller.
    function deposit() external payable;

    /// @notice Unwraps `amount` WETH of the caller and sends ETH back to it.
    function withdraw(uint256 amount) external;
}
