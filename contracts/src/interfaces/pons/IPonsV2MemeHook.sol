// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPonsV2MemeHook
/// @notice Minimal local interface of Pons V2's Uniswap v4 hook (`PonsV2MemeHook`, Robinhood Chain 4663:
///         0xe5e702641ea86f4ae6cc3cdaed2b886f976be044): post-graduation fee accrual per pool and its sweep (SPEC §9.1).
///         `PoolKey` mirrors Uniswap v4's struct with `Currency`/`IHooks` as plain addresses (same ABI encoding);
///         `poolId` is v4's `PoolId` (`keccak256(abi.encode(key))`) as `bytes32`.
interface IPonsV2MemeHook {
    /// @notice Uniswap v4 pool key (`currency0 < currency1`, native ETH = address(0)).
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    /// @notice Fee terms frozen for a launch (`FeePolicySnapshot`).
    struct FeePolicySnapshot {
        address protocolFeeRecipient;
        uint16 protocolFeeShareBps;
        uint16 buybackBurnBps;
        uint16 hookFeeBps;
        uint16 maxInternalPriceImpactBps;
    }

    /// @notice A graduated pool was registered; `creator` = the launch's creator fee recipient at that moment.
    event PoolRegistered(bytes32 indexed poolId, address memecoin, address quoteToken, address creator);
    /// @notice A pool's pending fees were distributed (creator share credited to the creator in the escrow).
    event PoolFeesSwept(
        bytes32 indexed poolId,
        uint256 protocolAmount,
        uint256 buybackAmount,
        uint256 creatorAmount,
        uint256 tokensLocked
    );

    /// @notice Factory-only: registers a graduated pool with its frozen fee terms.
    function registerPool(
        PoolKey calldata key,
        address memecoin,
        address creator,
        address buybackCreatorRecipient,
        uint16 creatorTaxBps,
        bool buybackEnabled,
        FeePolicySnapshot calldata policy
    ) external;
    /// @notice Distributes a pool's pending fees; callable by the fee sweep operator or the pool's creator (the
    ///         creator only when no internal swap is needed).
    function sweepPoolFees(bytes32 poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut) external;
    /// @notice Pons' rotatable fee sweep operator (also authorizes curve `sweepFees`).
    function feeSweepOperator() external view returns (address);
}
