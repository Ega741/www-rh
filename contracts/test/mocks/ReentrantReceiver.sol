// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IMindLaunchpad} from "../../src/interfaces/IMindLaunchpad.sol";

/// @notice Trader / ETH recipient that misbehaves when it receives ETH: it re-enters the launchpad (sell, buy,
///         graduate or drawCompute), or simply rejects the ETH. Records the re-entry outcome; with `bubble` set it
///         reverts with the inner error so the outer call fails.
contract ReentrantReceiver {
    enum Mode {
        Accept,
        Reject,
        ReenterSell,
        ReenterBuy,
        ReenterGraduate,
        ReenterDraw
    }

    IMindLaunchpad public immutable launchpad;
    address public token;
    Mode public mode;
    bool public bubble;

    uint256 public receiveCount;
    bool public reentrySucceeded;
    bytes public reentryError;

    error Rejected();

    constructor(IMindLaunchpad launchpad_) {
        launchpad = launchpad_;
    }

    function configure(address token_, Mode mode_, bool bubble_) external {
        token = token_;
        mode = mode_;
        bubble = bubble_;
        IERC20(token_).approve(address(launchpad), type(uint256).max);
    }

    function doBuy(uint256 minTokensOut) external payable returns (uint256) {
        return launchpad.buy{value: msg.value}(token, minTokensOut, block.timestamp);
    }

    function doSell(uint256 tokensIn) external returns (uint256) {
        return launchpad.sell(token, tokensIn, 0, block.timestamp);
    }

    receive() external payable {
        receiveCount++;
        Mode m = mode;
        if (m == Mode.Accept) return;
        if (m == Mode.Reject) revert Rejected();
        bool ok;
        bytes memory err;
        if (m == Mode.ReenterSell) {
            (ok, err) = address(launchpad)
                .call(
                    abi.encodeCall(
                        IMindLaunchpad.sell, (token, IERC20(token).balanceOf(address(this)), 0, block.timestamp)
                    )
                );
        } else if (m == Mode.ReenterBuy) {
            (ok, err) = address(launchpad).call{value: msg.value}(
                abi.encodeCall(IMindLaunchpad.buy, (token, 0, block.timestamp))
            );
        } else if (m == Mode.ReenterGraduate) {
            (ok, err) = address(launchpad).call(abi.encodeCall(IMindLaunchpad.graduate, (token)));
        } else {
            (ok, err) = address(launchpad).call(abi.encodeCall(IMindLaunchpad.drawCompute, (token, 1, bytes32(0))));
        }
        reentrySucceeded = ok;
        reentryError = err;
        if (!ok && bubble) {
            assembly ("memory-safe") {
                revert(add(err, 0x20), mload(err))
            }
        }
    }
}
