// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IGraduator
/// @notice Deploys a graduated coin's liquidity to a DEX and later harvests the DEX fees for the coin's
///         mind vault. Implemented by {UniswapV3Graduator} (mainnet) and {MockGraduator} (testnets without
///         Uniswap v3 / local tests).
/// @dev ETH flows back to the launchpad only through a plain call that hits the launchpad's `receive()`,
///      which accepts ETH solely from addresses that were ever set as graduator. The launchpad verifies
///      every call with an exact balance check (`balanceAfter == balanceBefore - msg.value + ethReturned`
///      for {graduate}, `balanceAfter == balanceBefore + ethOut` for {harvest}) and credits the returned
///      ETH to the coin's mind vault itself, so a graduator must send exactly the amount it reports.
interface IGraduator {
    /// @notice Deploys liquidity for `token`. The caller (launchpad) has already transferred `tokenAmount`
    ///         of `token` to this contract and sends the ETH side as `msg.value`.
    /// @dev Any ETH not used for liquidity must be sent back to the launchpad (plain call) before returning
    ///      and reported as `ethReturned`; unused tokens are burned or kept, never sent elsewhere.
    /// @param token       The graduating {MindToken}.
    /// @param tokenAmount Amount of `token` transferred to the graduator for this call.
    /// @return pool        The DEX pool that received the liquidity (`address(this)` for the mock).
    /// @return positionId  The LP position id (0 when not applicable).
    /// @return ethReturned ETH sent back to the launchpad during this call (credited to the mind vault).
    function graduate(address token, uint256 tokenAmount)
        external
        payable
        returns (address pool, uint256 positionId, uint256 ethReturned);

    /// @notice Collects DEX fees for `token`. The ETH side is sent to the launchpad (plain call) before
    ///         returning; the token side is burned (sent to 0x000000000000000000000000000000000000dEaD).
    /// @param token The graduated {MindToken}.
    /// @return ethOut       ETH sent to the launchpad (credited to the mind vault).
    /// @return tokensBurned Tokens sent to the burn address.
    function harvest(address token) external returns (uint256 ethOut, uint256 tokensBurned);
}
