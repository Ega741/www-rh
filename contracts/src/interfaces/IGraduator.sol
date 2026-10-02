// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IGraduator
/// @notice Deploys a graduated coin's liquidity to a DEX and later harvests the DEX fees for the coin's
///         mind vault. Implemented by {UniswapV3Graduator} (mainnet) and {MockGraduator} (testnets without
///         Uniswap v3 / local tests).
/// @dev ETH flows back to the launchpad only through plain calls that hit the launchpad's `receive()`. While the
///      launchpad is inside {graduate}/{harvest} of a graduator, its `receive()` accepts ETH from that graduator
///      only and adds every wei to an explicit per-call counter; after the call the launchpad requires
///      `counter == ethReturned` (resp. `ethOut`) and credits that amount to the coin's mind vault. ETH sent at any
///      other time, by anyone else, or through other functions (e.g. `fundMind`, which is `nonReentrant`) is not
///      counted, so a graduator must send exactly the amount it reports, and only through `receive()`.
///      ETH MUST be returned with a full-gas call (`call{value: amount}("")`), never with `transfer`/`send`: the
///      launchpad's `receive()` writes storage and needs more than the 2300-gas stipend.
interface IGraduator {
    /// @notice The launchpad allowed to call {graduate} / {harvest}; the only recipient of returned ETH.
    function launchpad() external view returns (address);

    /// @notice Deploys liquidity for `token`. The caller (launchpad) has already transferred `tokenAmount`
    ///         of `token` to this contract and sends the ETH side as `msg.value`.
    /// @dev Any ETH not used for liquidity must be sent back to the launchpad before returning, with one or more
    ///      full-gas plain calls (`call{value: …}("")`, never `transfer`/`send`), and reported as `ethReturned`;
    ///      unused tokens are burned or kept, never sent elsewhere.
    /// @param token       The graduating {MindToken}.
    /// @param tokenAmount Amount of `token` transferred to the graduator for this call.
    /// @return pool        The DEX pool that received the liquidity (`address(this)` for the mock).
    /// @return positionId  The LP position id (0 when not applicable).
    /// @return ethReturned ETH sent back to the launchpad during this call (credited to the mind vault).
    function graduate(address token, uint256 tokenAmount)
        external
        payable
        returns (address pool, uint256 positionId, uint256 ethReturned);

    /// @notice Collects DEX fees for `token`. The ETH side is sent to the launchpad before returning with a
    ///         full-gas plain call (`call{value: …}("")`, never `transfer`/`send`); the token side is burned (sent
    ///         to 0x000000000000000000000000000000000000dEaD).
    /// @param token The graduated {MindToken}.
    /// @return ethOut       ETH sent to the launchpad (credited to the mind vault).
    /// @return tokensBurned Tokens sent to the burn address.
    function harvest(address token) external returns (uint256 ethOut, uint256 tokensBurned);
}
