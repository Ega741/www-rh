// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IMindCore
/// @notice Venue-independent surface shared by {MindLaunchpad} (in-house bonding curve, SPEC §2.3) and
///         {PonsMindRegistry} (minds layered on Pons V2 launches, SPEC §9.2): roles, mind registry, mind vault with
///         epoch-capped compute draws, protocol balance, memory anchoring, mind status rules, and the shared
///         events/errors. Types, events and errors are declared here once so every venue, script, test and off-chain
///         ABI shares a single definition.
interface IMindCore {
    // ---------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------

    /// @notice Lifecycle of a coin's mind. `Alive <-> Dormant` is toggled by the operator; `Paused` is set and
    ///         cleared only by the coin's creator.
    enum MindStatus {
        Alive,
        Dormant,
        Paused
    }

    /// @notice Static + creator-controlled information about a mind.
    struct MindInfo {
        address creator;
        bytes32 modelId; // keccak256(utf8 model id string), see the model catalog
        bytes32 personaHash; // keccak256(utf8 persona prompt text); full text lives in the metadata JSON
        string metadataURI; // JSON: {name, symbol, description, image, persona, model, links}
        uint64 createdAt;
        MindStatus status;
    }

    // ---------------------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------------------

    /// @notice A coin and its mind were created.
    event MindCreated(
        address indexed token,
        address indexed creator,
        string name,
        string symbol,
        string metadataURI,
        bytes32 modelId,
        bytes32 personaHash
    );
    /// @notice ETH was added to a mind vault by {fundMind} (`from` = sender) or returned during a harvest/graduation
    ///         (`from` = the graduator, or the mind's fee account on the Pons registry). Fee shares emit {FeeAccrued}
    ///         instead.
    event MindFunded(address indexed token, address indexed from, uint256 amount);
    /// @notice A fee (trade, creation, graduation or harvest cut) was split between the mind vault and the protocol.
    event FeeAccrued(address indexed token, uint256 mindAmount, uint256 protocolAmount);
    /// @notice The operator paid `amount` of compute from the mind vault to `computeTreasury()`.
    event ComputeDrawn(address indexed token, uint256 amount, bytes32 receiptHash);
    /// @notice A batch of memories was anchored (event only).
    event MemoryAnchored(address indexed token, uint64 indexed seq, bytes32 contentHash, string uri);
    /// @notice The creator updated the mind configuration.
    event MindConfigUpdated(address indexed token, bytes32 modelId, bytes32 personaHash, string metadataURI);
    /// @notice The mind status changed (operator Alive/Dormant toggle, creator pause/unpause, or a venue transition).
    event MindStatusChanged(address indexed token, MindStatus status);
    /// @notice Fees were harvested: `ethOut` credited to the mind vault, `tokensBurned` sent to 0xdEaD.
    event Harvested(address indexed token, uint256 ethOut, uint256 tokensBurned);
    /// @notice The protocol balance was withdrawn.
    event ProtocolFeesWithdrawn(address indexed to, uint256 amount);
    /// @notice The operator (runner hot wallet) changed.
    event OperatorUpdated(address newOperator);
    /// @notice The protocol treasury changed.
    event TreasuryUpdated(address newTreasury);
    /// @notice The compute treasury (recipient of {drawCompute}) changed.
    event ComputeTreasuryUpdated(address newComputeTreasury);
    /// @notice The creation fee changed.
    event CreationFeeUpdated(uint256 newCreationFee);
    /// @notice The per-mind compute draw cap changed.
    event DrawLimitUpdated(uint256 maxPerEpoch, uint32 epochSeconds);

    // ---------------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------------

    /// @notice `token` is not a mind of this contract.
    error NotAMind();
    /// @notice A zero input or a trade that would produce zero output.
    error ZeroAmount();
    /// @notice Caller is not the coin's creator.
    error NotCreator();
    /// @notice Caller is not the operator.
    error NotOperator();
    /// @notice Status transition not allowed for the caller / current status.
    error InvalidStatus();
    /// @notice The draw would exceed the per-mind epoch cap.
    error DrawLimitExceeded();
    /// @notice `setDrawLimit` with an epoch shorter than one hour or a cap above `MAX_DRAW_PER_EPOCH` (2 ether).
    error InvalidDrawLimit();
    /// @notice `renounceOwnership` is disabled: the contract always keeps an owner.
    error RenounceDisabled();
    /// @notice The draw exceeds the mind vault balance.
    error InsufficientMindBalance();
    /// @notice A fee parameter exceeds its bound.
    error FeeTooHigh();
    /// @notice A required address is zero.
    error ZeroAddress();
    /// @notice An ETH transfer with `call` failed.
    error EthTransferFailed();
    /// @notice Plain ETH is only accepted from the counterparty whose return window is open (the graduator being
    ///         called by `graduate`/`harvest`, or the Pons curve/account being called by the registry).
    error DirectEthNotAccepted();
    /// @notice The counterparty's reported ETH return does not match the ETH it sent to `receive()` during the call.
    error EthReturnMismatch();
    /// @notice Token name must be 1..64 bytes.
    error InvalidName();
    /// @notice Token symbol must be 1..16 bytes.
    error InvalidSymbol();
    /// @notice Metadata URI must be at most 2048 bytes.
    error MetadataTooLong();
    /// @notice Model id must be non-zero.
    error InvalidModel();

    // ---------------------------------------------------------------------------------------------
    // User
    // ---------------------------------------------------------------------------------------------

    /// @notice Anyone can feed a mind: adds `msg.value` to `mindBalance(token)`. `nonReentrant`.
    /// @param token The coin.
    function fundMind(address token) external payable;

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice Mind information of `token` (zero struct when not a mind).
    function getMind(address token) external view returns (MindInfo memory);

    /// @notice ETH held in `token`'s mind vault (only spendable through {drawCompute}).
    function mindBalance(address token) external view returns (uint256);

    /// @notice Accrued protocol fees, withdrawable with {withdrawProtocolFees}.
    function protocolBalance() external view returns (uint256);

    /// @notice Number of minds created.
    function mindsLength() external view returns (uint256);

    /// @notice The `index`-th created mind (token address).
    function mindAt(uint256 index) external view returns (address);

    /// @notice Whether `token` is a mind of this contract.
    function isMind(address token) external view returns (bool);

    /// @notice Flat ETH fee charged when a mind is created (credited to the protocol balance).
    function creationFee() external view returns (uint256);

    /// @notice Per-mind compute draw cap: at most `maxPerEpoch` wei per fixed epoch of `epochSeconds`. Epochs are
    ///         fixed windows, so up to `2 * maxPerEpoch` can be drawn within any `epochSeconds`-long interval
    ///         straddling an epoch boundary (at most `2 * MAX_DRAW_PER_EPOCH` = 4 ether).
    function drawLimit() external view returns (uint256 maxPerEpoch, uint32 epochSeconds);

    /// @notice Stored draw accounting of `token` (no elapsed-epoch reset is applied: the allowance is
    ///         `maxPerEpoch` again once `block.timestamp >= epochStart + epochSeconds`).
    function drawnInEpoch(address token) external view returns (uint256 drawn, uint64 epochStart);

    /// @notice Runner hot wallet allowed to draw compute, anchor memories and toggle Alive/Dormant.
    function operator() external view returns (address);

    /// @notice Protocol treasury (may withdraw protocol fees, like the owner).
    function treasury() external view returns (address);

    /// @notice Recipient of every {drawCompute}.
    function computeTreasury() external view returns (address);

    // ---------------------------------------------------------------------------------------------
    // Creator
    // ---------------------------------------------------------------------------------------------

    /// @notice Creator-only: updates model / persona / metadata of a mind (same validation as at creation).
    function setMindConfig(address token, bytes32 modelId, bytes32 personaHash, string calldata metadataURI) external;

    /// @notice Creator-only: `paused = true` sets the status to `Paused` (from Alive or Dormant);
    ///         `paused = false` restores `Alive` from `Paused`. A no-op (no event) when nothing changes.
    function setCreatorPaused(address token, bool paused) external;

    // ---------------------------------------------------------------------------------------------
    // Operator (runner hot wallet)
    // ---------------------------------------------------------------------------------------------

    /// @notice Operator-only: pays `amount` wei of already-incurred compute from the mind vault to
    ///         `computeTreasury()`, subject to the per-epoch cap. Allowed in any status. `receiptHash` commits
    ///         to the off-chain usage ledger being settled.
    function drawCompute(address token, uint256 amount, bytes32 receiptHash) external;

    /// @notice Operator-only, event only: anchors a batch of memories on-chain.
    function anchorMemory(address token, uint64 seq, bytes32 contentHash, string calldata uri) external;

    /// @notice Operator-only: sets `Alive` or `Dormant` (no event when unchanged). Reverts `InvalidStatus()` when
    ///         `status == Paused` or the mind is currently `Paused` (only the creator can change that).
    function setMindStatus(address token, MindStatus status) external;

    // ---------------------------------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------------------------------

    /// @notice Sets the operator (non-zero).
    function setOperator(address newOperator) external;
    /// @notice Sets the protocol treasury (non-zero).
    function setTreasury(address newTreasury) external;
    /// @notice Sets the compute treasury (non-zero).
    function setComputeTreasury(address newComputeTreasury) external;
    /// @notice Sets the flat creation fee.
    function setCreationFee(uint256 newCreationFee) external;
    /// @notice Sets the per-mind compute draw cap (`epochSeconds >= 3600`, `maxPerEpoch <= MAX_DRAW_PER_EPOCH`
    ///         = 2 ether; `maxPerEpoch = 0` blocks draws). Fixed epochs allow a burst of `2 * maxPerEpoch` around
    ///         an epoch boundary.
    function setDrawLimit(uint256 maxPerEpoch, uint32 epochSeconds) external;
    /// @notice Pauses mind creation (and, on the launchpad, buys); see the venue for the exact scope.
    function pause() external;
    /// @notice Lifts {pause}.
    function unpause() external;
    /// @notice Owner or treasury: sends the whole `protocolBalance()` to `to`.
    function withdrawProtocolFees(address to) external;
}
