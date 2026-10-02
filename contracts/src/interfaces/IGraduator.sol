// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IGraduator
/// @notice Deploys a graduated coin's liquidity to a DEX and later harvests the DEX fees back into
///         the coin's mind vault. Implemented by {UniswapV3Graduator} (mainnet) and {MockGraduator}
///         (testnets without Uniswap v3 / local tests).
interface IGraduator {
    /// @notice Deploys liquidity for `token`. Caller (launchpad) has already transferred
    ///         `tokenAmount` of `token` to this contract and sends ETH as msg.value.
    /// @param token          The graduating {MindToken}.
    /// @param tokenAmount    Amount of `token` already held by the graduator for this call.
    /// @param targetPriceWei Curve's final price, wei per 1e18 tokens (used for pool init / deviation check).
    /// @return pool          The DEX pool that received the liquidity (`address(this)` for the mock).
    /// @return positionId    The LP position id (0 when not applicable).
    function graduate(address token, uint256 tokenAmount, uint256 targetPriceWei)
        external
        payable
        returns (address pool, uint256 positionId);

    /// @notice Collects DEX fees for `token`; ETH is forwarded to `launchpad.creditMind{value}(token)`,
    ///         collected tokens are burned (sent to 0x000000000000000000000000000000000000dEaD).
    /// @param token        The graduated {MindToken}.
    /// @return ethOut      ETH credited to the mind vault.
    /// @return tokensBurned Tokens sent to the burn address.
    function harvest(address token) external returns (uint256 ethOut, uint256 tokensBurned);
}
