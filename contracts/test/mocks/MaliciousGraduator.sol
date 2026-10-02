// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";

import {IGraduator} from "../../src/interfaces/IGraduator.sol";
import {IMindLaunchpad} from "../../src/interfaces/IMindLaunchpad.sol";

/// @dev Forwards `msg.value` to the launchpad with a plain call from its own address.
contract EthForwarder {
    constructor(address launchpad) payable {
        (bool ok, bytes memory err) = launchpad.call{value: msg.value}("");
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(err, 0x20), mload(err))
            }
        }
    }
}

/// @notice Graduator exercising the launchpad's ETH return counter: on {graduate} (all of `msg.value`) or {harvest}
///         (its whole balance) it returns the ETH in the configured way and reports the full amount as returned.
///         `Split` is the honest path (two separate full-gas calls); the other modes try to get ETH credited without
///         returning it through the counted `receive()`. With `honestGraduate`, {graduate} keeps the ETH and reports
///         0 (to set up harvest scenarios).
contract MaliciousGraduator is IGraduator {
    enum Mode {
        Split, // honest: returns in two plain calls
        FundMind, // pushes the ETH through fundMind (would be credited twice)
        TransferStipend, // returns with `transfer` (2300 gas)
        ForceSend, // raises the launchpad's balance without calling it (like selfdestruct / coinbase)
        ViaHelper // returns from another address
    }

    /// @dev Foundry cheatcodes, used to simulate a forced ETH transfer (no `receive()` call).
    Vm internal constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address public immutable launchpad;
    Mode public mode;
    bool public honestGraduate;

    error SendFailed();

    constructor(address launchpad_) {
        launchpad = launchpad_;
    }

    receive() external payable {}

    function setMode(Mode mode_, bool honestGraduate_) external {
        mode = mode_;
        honestGraduate = honestGraduate_;
    }

    /// @inheritdoc IGraduator
    function graduate(address token, uint256) external payable returns (address, uint256, uint256) {
        if (honestGraduate) return (address(this), 0, 0);
        _return(token, msg.value);
        return (address(this), 0, msg.value);
    }

    /// @inheritdoc IGraduator
    function harvest(address token) external returns (uint256, uint256) {
        uint256 amount = address(this).balance;
        _return(token, amount);
        return (amount, 0);
    }

    function _return(address token, uint256 amount) internal {
        Mode m = mode;
        if (m == Mode.Split) {
            _send(amount / 2);
            _send(amount - amount / 2);
        } else if (m == Mode.FundMind) {
            IMindLaunchpad(launchpad).fundMind{value: amount}(token);
        } else if (m == Mode.TransferStipend) {
            payable(launchpad).transfer(amount);
        } else if (m == Mode.ForceSend) {
            VM.deal(launchpad, launchpad.balance + amount);
        } else {
            new EthForwarder{value: amount}(launchpad);
        }
    }

    function _send(uint256 amount) internal {
        (bool ok,) = launchpad.call{value: amount}("");
        if (!ok) revert SendFailed();
    }
}
