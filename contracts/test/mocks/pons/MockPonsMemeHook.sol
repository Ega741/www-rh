// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPonsV2FeeEscrow} from "../../../src/interfaces/pons/IPonsV2FeeEscrow.sol";
import {IPonsV2MemeHook} from "../../../src/interfaces/pons/IPonsV2MemeHook.sol";

/// @notice Model of `PonsV2MemeHook` without Uniswap v4: the protocol fee policy (also read by curves and the
///         factory), pool registration by the factory, per-pool pending fees and `sweepPoolFees` with the real
///         authorization rules (fee sweep operator, or the pool's creator when no internal swap is needed). Swap fee
///         capture is simulated with {simulateSwapFees} / {simulateMemecoinFees}; internal conversions and buybacks
///         are not executed (an operator sweep folds a buyback back into the creator share and leaves memecoin fees
///         pending, like the real hook's "skipped" paths).
contract MockPonsMemeHook is IPonsV2MemeHook, Ownable, ReentrancyGuard {
    uint256 private constant BPS = 10_000;

    struct LaunchInfo {
        bool registered;
        address memecoin;
        address quoteToken;
        address creator;
        address protocolFeeRecipient;
        uint16 creatorTaxBps;
        uint16 protocolFeeShareBps;
        uint16 buybackBurnBps;
        bool buybackEnabled;
    }

    IPonsV2FeeEscrow public immutable feeEscrow;
    address public factory;
    address public feeSweepOperator;
    address public protocolFeeRecipient;
    uint16 public protocolFeeShareBps = 3000;
    uint16 public buybackBurnBps = 5000;
    uint16 public hookFeeBps = 100;
    uint16 public maxInternalPriceImpactBps = 300;

    mapping(bytes32 poolId => LaunchInfo) public launches;
    mapping(bytes32 poolId => uint256) public pendingFees;
    mapping(bytes32 poolId => uint256) public pendingCreatorTax;
    mapping(bytes32 poolId => uint256) public pendingBuyback;
    mapping(bytes32 poolId => uint256) public pendingMemecoinFees;

    error NotFactory();
    error AlreadySet();
    error AlreadyRegistered();
    error UnknownPool();
    error InvalidPoolKey();
    error InvalidBps();
    error NotFeeSweepOperator();
    error InternalSwapRequiresOperator();
    error MinimumOutputRequired();
    error ZeroAddress();

    event FactorySet(address factory);
    event FeeSweepOperatorUpdated(address operator);
    event CreatorFeeRecipientUpdated(
        bytes32 indexed poolId, address indexed previousRecipient, address indexed newRecipient
    );
    event HookFeeCollected(bytes32 indexed poolId, address currency, uint256 feeAmount, uint256 taxAmount);
    event PoolBuybackSkipped(bytes32 indexed poolId, uint256 foldedBackQuote);
    event PoolConversionSkipped(bytes32 indexed poolId, uint256 retainedMemecoin);

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    constructor(address initialOwner, IPonsV2FeeEscrow feeEscrow_, address protocolFeeRecipient_)
        Ownable(initialOwner)
    {
        if (address(feeEscrow_) == address(0) || protocolFeeRecipient_ == address(0)) {
            revert ZeroAddress();
        }
        feeEscrow = feeEscrow_;
        protocolFeeRecipient = protocolFeeRecipient_;
        feeSweepOperator = initialOwner;
    }

    // ------------------------------------------------------------------ owner

    function setFactory(address factory_) external onlyOwner {
        if (factory != address(0)) revert AlreadySet();
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
        emit FactorySet(factory_);
    }

    function setFeeSweepOperator(address operator_) external onlyOwner {
        feeSweepOperator = operator_;
        emit FeeSweepOperatorUpdated(operator_);
    }

    function setProtocolFeeRecipient(address recipient) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        protocolFeeRecipient = recipient;
    }

    function setProtocolFeeShareBps(uint16 bps) external onlyOwner {
        if (bps > 5000) revert InvalidBps();
        protocolFeeShareBps = bps;
    }

    function setBuybackBurnBps(uint16 bps) external onlyOwner {
        if (bps > BPS) revert InvalidBps();
        buybackBurnBps = bps;
    }

    function setHookFeeBps(uint16 bps) external onlyOwner {
        if (bps > 1000) revert InvalidBps();
        hookFeeBps = bps;
    }

    // ------------------------------------------------------------------ policy

    function currentFeePolicy() external view returns (FeePolicySnapshot memory) {
        return FeePolicySnapshot({
            protocolFeeRecipient: protocolFeeRecipient,
            protocolFeeShareBps: protocolFeeShareBps,
            buybackBurnBps: buybackBurnBps,
            hookFeeBps: hookFeeBps,
            maxInternalPriceImpactBps: maxInternalPriceImpactBps
        });
    }

    // ------------------------------------------------------------------ factory

    function registerPool(
        PoolKey calldata key,
        address memecoin,
        address creator,
        address buybackCreatorRecipient,
        uint16 creatorTaxBps,
        bool buybackEnabled,
        FeePolicySnapshot calldata policy
    ) external onlyFactory {
        bytes32 poolId = keccak256(abi.encode(key));
        if (launches[poolId].registered) revert AlreadyRegistered();
        if (creator == address(0) || buybackCreatorRecipient == address(0)) revert ZeroAddress();
        if (key.hooks != address(this)) revert InvalidPoolKey();
        bool memecoinIsCurrency0 = key.currency0 == memecoin;
        if (!memecoinIsCurrency0 && key.currency1 != memecoin) revert InvalidPoolKey();
        address quoteToken = memecoinIsCurrency0 ? key.currency1 : key.currency0;
        launches[poolId] = LaunchInfo({
            registered: true,
            memecoin: memecoin,
            quoteToken: quoteToken,
            creator: creator,
            protocolFeeRecipient: policy.protocolFeeRecipient,
            creatorTaxBps: creatorTaxBps,
            protocolFeeShareBps: policy.protocolFeeShareBps,
            buybackBurnBps: policy.buybackBurnBps,
            buybackEnabled: buybackEnabled
        });
        emit PoolRegistered(poolId, memecoin, quoteToken, creator);
    }

    function setCreatorFeeRecipient(bytes32 poolId, address newRecipient) external onlyFactory {
        LaunchInfo storage info = launches[poolId];
        if (!info.registered) revert UnknownPool();
        if (newRecipient == address(0)) revert ZeroAddress();
        emit CreatorFeeRecipientUpdated(poolId, info.creator, newRecipient);
        info.creator = newRecipient;
    }

    // ------------------------------------------------------------------ simulated swaps

    /// @notice Stands in for `afterSwap` fee capture on the quote (ETH) leg: `msg.value - taxAmount` is pending base
    ///         fee, `taxAmount` pending creator tax.
    function simulateSwapFees(bytes32 poolId, uint256 taxAmount) external payable {
        LaunchInfo storage info = launches[poolId];
        if (!info.registered) revert UnknownPool();
        uint256 fee = msg.value - taxAmount;
        pendingFees[poolId] += fee;
        pendingCreatorTax[poolId] += taxAmount;
        if (info.buybackEnabled && fee != 0) {
            uint256 creatorSlice = fee - fee * info.protocolFeeShareBps / BPS;
            pendingBuyback[poolId] += creatorSlice * info.buybackBurnBps / BPS;
        }
        emit HookFeeCollected(poolId, info.quoteToken, fee, taxAmount);
    }

    /// @notice Stands in for fees captured on the memecoin leg (their conversion needs the sweep operator).
    function simulateMemecoinFees(bytes32 poolId, uint256 amount) external {
        LaunchInfo storage info = launches[poolId];
        if (!info.registered) revert UnknownPool();
        pendingMemecoinFees[poolId] += amount;
        emit HookFeeCollected(poolId, info.memecoin, amount, 0);
    }

    // ------------------------------------------------------------------ sweep

    function sweepPoolFees(bytes32 poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut)
        external
        nonReentrant
    {
        LaunchInfo memory info = launches[poolId];
        if (!info.registered) revert UnknownPool();
        bool isOperator = msg.sender == feeSweepOperator;
        if (!isOperator && msg.sender != info.creator) revert NotFeeSweepOperator();
        if (!isOperator && (pendingMemecoinFees[poolId] != 0 || pendingBuyback[poolId] != 0)) {
            revert InternalSwapRequiresOperator();
        }
        uint256 memecoinPending = pendingMemecoinFees[poolId];
        if (memecoinPending != 0) {
            if (minConversionQuoteOut == 0) revert MinimumOutputRequired();
            emit PoolConversionSkipped(poolId, memecoinPending);
        }

        uint256 totalQuote = pendingFees[poolId];
        uint256 taxQuote = pendingCreatorTax[poolId];
        uint256 buybackQuote = pendingBuyback[poolId];
        if (totalQuote == 0 && taxQuote == 0) return;
        pendingFees[poolId] = 0;
        pendingCreatorTax[poolId] = 0;
        pendingBuyback[poolId] = 0;

        uint256 protocolAmount = totalQuote * info.protocolFeeShareBps / BPS;
        uint256 creatorAmount = totalQuote - protocolAmount + taxQuote;
        if (buybackQuote != 0) {
            if (minBuybackTokensOut == 0) revert MinimumOutputRequired();
            emit PoolBuybackSkipped(poolId, buybackQuote);
        }
        if (creatorAmount != 0) feeEscrow.credit{value: creatorAmount}(info.creator);
        if (protocolAmount != 0) feeEscrow.credit{value: protocolAmount}(info.protocolFeeRecipient);
        emit PoolFeesSwept(poolId, protocolAmount, 0, creatorAmount, 0);
    }
}
