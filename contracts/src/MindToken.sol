// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

import {CurveMath} from "./libraries/CurveMath.sol";

/// @title MindToken
/// @notice Plain ERC20 + ERC20Permit coin created by {MindLaunchpad}. The whole supply
///         (`CurveMath.TOTAL_SUPPLY`) is minted once to the launchpad; no owner, no transfer restrictions.
contract MindToken is ERC20, ERC20Permit {
    /// @notice The launchpad that deployed this token and received the full supply.
    address public immutable launchpad;
    /// @notice The account that created the coin (creator of its mind).
    address public immutable creator;

    /// @param name_      ERC20 name.
    /// @param symbol_    ERC20 symbol.
    /// @param launchpad_ Receives `TOTAL_SUPPLY`.
    /// @param creator_   The coin's creator (informational).
    constructor(string memory name_, string memory symbol_, address launchpad_, address creator_)
        ERC20(name_, symbol_)
        ERC20Permit(name_)
    {
        launchpad = launchpad_;
        creator = creator_;
        _mint(launchpad_, CurveMath.TOTAL_SUPPLY);
    }
}
