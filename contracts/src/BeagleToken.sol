// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title BeagleToken
/// @notice BEAGLE: fixed-supply ERC-20 with burn and EIP-2612 permit. Used on anvil/testnet; on mainnet the
///         desk accepts whatever ERC-20 the project launched (e.g. on Pons).
/// @dev No owner and no mint after construction: the whole supply goes to `recipient`.
contract BeagleToken is ERC20, ERC20Burnable, ERC20Permit {
    /// @notice Total and only supply ever minted: one billion tokens (18 decimals).
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    /// @param recipient Receives {TOTAL_SUPPLY}; the zero address is rejected by ERC20 (`ERC20InvalidReceiver`).
    constructor(address recipient) ERC20("Beagle", "BEAGLE") ERC20Permit("Beagle") {
        _mint(recipient, TOTAL_SUPPLY);
    }
}
