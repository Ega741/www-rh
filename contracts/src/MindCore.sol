// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IMindCore} from "./interfaces/IMindCore.sol";

/// @title MindCore
/// @notice Venue-independent core shared by {MindLaunchpad} and {PonsMindRegistry} (SPEC §9.2): roles
///         (`Ownable2Step` with renounce disabled, operator, treasury, compute treasury), `Pausable`,
///         `ReentrancyGuard`, the mind registry (`MindInfo`, creator config and pause, operator status), the mind
///         vault (`fundMind`, epoch-capped `drawCompute` to the compute treasury), the protocol balance and its
///         withdrawal, memory anchoring, and the ETH return window used by {receive}.
/// @dev Vault ETH leaves only through {drawCompute}; protocol ETH only through {withdrawProtocolFees}. {receive}
///      accepts ETH only from the counterparty whose return window is open (`_returnFrom`, set by the venue around
///      the external call that returns ETH) and counts it; the venue then checks or uses the count. Every function
///      here that sends ETH, and {fundMind}, is `nonReentrant`; all ETH transfers use `call`.
abstract contract MindCore is IMindCore, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeCast for uint256;

    // ---------------------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------------------

    uint256 internal constant BPS = 10_000;
    uint256 internal constant MAX_NAME_LENGTH = 64;
    uint256 internal constant MAX_SYMBOL_LENGTH = 16;
    uint256 internal constant MAX_METADATA_URI_LENGTH = 2048;
    uint32 internal constant MIN_DRAW_EPOCH = 1 hours;
    /// @dev Hard ceiling of {setDrawLimit}'s `maxPerEpoch`: with fixed epochs, at most `2 * MAX_DRAW_PER_EPOCH`
    ///      (4 ether) can leave one mind vault within any `epochSeconds` window (end of one epoch + start of the
    ///      next), whatever the owner configures.
    uint256 internal constant MAX_DRAW_PER_EPOCH = 2 ether;
    uint256 internal constant DEFAULT_MAX_DRAW_PER_EPOCH = 0.25 ether;
    uint32 internal constant DEFAULT_DRAW_EPOCH = 1 days;

    // ---------------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------------

    /// @dev Per-mind epoch accounting for {drawCompute}.
    struct DrawEpoch {
        uint192 drawn;
        uint64 epochStart;
    }

    address internal _operator;
    address internal _treasury;
    address internal _computeTreasury;

    uint256 internal _creationFee;
    uint256 internal _maxDrawPerEpoch;
    uint32 internal _drawEpoch;

    uint256 internal _protocolBalance;

    address[] internal _minds;
    mapping(address token => MindInfo) internal _mindInfo;
    mapping(address token => uint256) internal _mindBalances;
    mapping(address token => DrawEpoch) internal _draws;

    /// @dev Counterparty whose ETH-returning call is in progress: the only account {receive} accepts ETH from.
    ///      Zero outside those calls.
    address private _returnFrom;
    /// @dev Wei received by {receive} from `_returnFrom` during the current call. Zero outside those calls.
    uint256 private _returned;

    // ---------------------------------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------------------------------

    modifier onlyMind(address token) {
        _checkMind(token);
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != _operator) revert NotOperator();
        _;
    }

    /// @dev Unknown tokens have no creator, so this also implies `onlyMind` (SPEC §2.3 rules 8-9 order).
    modifier onlyCreator(address token) {
        if (msg.sender != _mindInfo[token].creator) revert NotCreator();
        _;
    }

    // ---------------------------------------------------------------------------------------------
    // Constructor / receive
    // ---------------------------------------------------------------------------------------------

    /// @param initialOwner     Initial owner (Ownable2Step).
    /// @param treasury_        Protocol treasury (may withdraw protocol fees, like the owner).
    /// @param computeTreasury_ Recipient of every {drawCompute}.
    /// @param operator_        Runner hot wallet allowed to draw compute / anchor memories / toggle status.
    /// @dev Emits the three role events; the venue then calls {_initDrawLimit} at the point of its constructor where
    ///      `DrawLimitUpdated` belongs in its event order.
    constructor(address initialOwner, address treasury_, address computeTreasury_, address operator_)
        Ownable(initialOwner)
    {
        if (treasury_ == address(0) || computeTreasury_ == address(0) || operator_ == address(0)) {
            revert ZeroAddress();
        }
        _treasury = treasury_;
        _computeTreasury = computeTreasury_;
        _operator = operator_;
        emit TreasuryUpdated(treasury_);
        emit ComputeTreasuryUpdated(computeTreasury_);
        emit OperatorUpdated(operator_);
    }

    /// @notice Accepts plain ETH only from the counterparty whose ETH-returning call is in progress (a graduator's
    ///         leftovers / harvest proceeds, a Pons curve's buy refund, a mind account's escrow claim) and counts
    ///         it; that call then checks or uses the count. Anything else reverts `DirectEthNotAccepted()`. Writes
    ///         storage: counterparties must send with a full-gas `call`, not `transfer`/`send`.
    receive() external payable {
        if (msg.sender != _returnFrom) revert DirectEthNotAccepted();
        _returned += msg.value;
    }

    // ---------------------------------------------------------------------------------------------
    // User
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IMindCore
    /// @dev `nonReentrant`: a counterparty cannot route its return through here while its return window is open.
    function fundMind(address token) external payable nonReentrant onlyMind(token) {
        if (msg.value == 0) revert ZeroAmount();
        _mindBalances[token] += msg.value;
        emit MindFunded(token, msg.sender, msg.value);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IMindCore
    function getMind(address token) external view returns (MindInfo memory) {
        return _mindInfo[token];
    }

    /// @inheritdoc IMindCore
    function mindBalance(address token) external view returns (uint256) {
        return _mindBalances[token];
    }

    /// @inheritdoc IMindCore
    function protocolBalance() external view returns (uint256) {
        return _protocolBalance;
    }

    /// @inheritdoc IMindCore
    function mindsLength() external view returns (uint256) {
        return _minds.length;
    }

    /// @inheritdoc IMindCore
    function mindAt(uint256 index) external view returns (address) {
        return _minds[index];
    }

    /// @inheritdoc IMindCore
    function isMind(address token) external view returns (bool) {
        return _mindInfo[token].creator != address(0);
    }

    /// @inheritdoc IMindCore
    function creationFee() external view returns (uint256) {
        return _creationFee;
    }

    /// @inheritdoc IMindCore
    function drawLimit() external view returns (uint256 maxPerEpoch, uint32 epochSeconds) {
        return (_maxDrawPerEpoch, _drawEpoch);
    }

    /// @inheritdoc IMindCore
    function drawnInEpoch(address token) external view returns (uint256 drawn, uint64 epochStart) {
        DrawEpoch storage epoch = _draws[token];
        return (epoch.drawn, epoch.epochStart);
    }

    /// @inheritdoc IMindCore
    function operator() external view returns (address) {
        return _operator;
    }

    /// @inheritdoc IMindCore
    function treasury() external view returns (address) {
        return _treasury;
    }

    /// @inheritdoc IMindCore
    function computeTreasury() external view returns (address) {
        return _computeTreasury;
    }

    // ---------------------------------------------------------------------------------------------
    // Creator
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IMindCore
    function setMindConfig(address token, bytes32 modelId, bytes32 personaHash, string calldata metadataURI)
        external
        onlyCreator(token)
    {
        if (modelId == bytes32(0)) revert InvalidModel();
        if (bytes(metadataURI).length > MAX_METADATA_URI_LENGTH) revert MetadataTooLong();
        MindInfo storage info = _mindInfo[token];
        info.modelId = modelId;
        info.personaHash = personaHash;
        info.metadataURI = metadataURI;
        emit MindConfigUpdated(token, modelId, personaHash, metadataURI);
    }

    /// @inheritdoc IMindCore
    /// @dev Unpausing restores `Alive`, or `Dormant` when the venue's {_canBeAlive} says the mind may not be Alive.
    function setCreatorPaused(address token, bool paused) external onlyCreator(token) {
        MindInfo storage info = _mindInfo[token];
        if (paused == (info.status == MindStatus.Paused)) return;
        MindStatus status = paused ? MindStatus.Paused : (_canBeAlive(token) ? MindStatus.Alive : MindStatus.Dormant);
        info.status = status;
        emit MindStatusChanged(token, status);
    }

    // ---------------------------------------------------------------------------------------------
    // Operator
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IMindCore
    /// @dev Fixed epochs: a draw at `epochStart + epochSeconds - 1` and another at `epochStart + epochSeconds`
    ///      fall in different epochs, so up to `2 * maxPerEpoch` (<= 2 * MAX_DRAW_PER_EPOCH = 4 ether) can leave a
    ///      vault within any `epochSeconds` window. Accepted and documented (SPEC §2.3).
    function drawCompute(address token, uint256 amount, bytes32 receiptHash)
        external
        nonReentrant
        onlyOperator
        onlyMind(token)
    {
        if (amount == 0) revert ZeroAmount();
        uint256 balance = _mindBalances[token];
        if (amount > balance) revert InsufficientMindBalance();

        DrawEpoch storage epoch = _draws[token];
        uint256 drawn = epoch.drawn;
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= uint256(epoch.epochStart) + _drawEpoch) {
            drawn = 0;
            epoch.epochStart = uint64(block.timestamp);
        }
        drawn += amount;
        if (drawn > _maxDrawPerEpoch) revert DrawLimitExceeded();
        epoch.drawn = drawn.toUint192();

        _mindBalances[token] = balance - amount;
        emit ComputeDrawn(token, amount, receiptHash);
        _sendEth(_computeTreasury, amount);
    }

    /// @inheritdoc IMindCore
    function anchorMemory(address token, uint64 seq, bytes32 contentHash, string calldata uri)
        external
        onlyOperator
        onlyMind(token)
    {
        emit MemoryAnchored(token, seq, contentHash, uri);
    }

    /// @inheritdoc IMindCore
    /// @dev Also reverts `InvalidStatus()` for `Alive` while the venue's {_canBeAlive} is false.
    function setMindStatus(address token, MindStatus status) external onlyOperator onlyMind(token) {
        MindInfo storage info = _mindInfo[token];
        if (status == MindStatus.Paused || info.status == MindStatus.Paused) revert InvalidStatus();
        if (status == MindStatus.Alive && !_canBeAlive(token)) revert InvalidStatus();
        if (info.status == status) return;
        info.status = status;
        emit MindStatusChanged(token, status);
    }

    // ---------------------------------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IMindCore
    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert ZeroAddress();
        _operator = newOperator;
        emit OperatorUpdated(newOperator);
    }

    /// @inheritdoc IMindCore
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        _treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    /// @inheritdoc IMindCore
    function setComputeTreasury(address newComputeTreasury) external onlyOwner {
        if (newComputeTreasury == address(0)) revert ZeroAddress();
        _computeTreasury = newComputeTreasury;
        emit ComputeTreasuryUpdated(newComputeTreasury);
    }

    /// @inheritdoc IMindCore
    function setCreationFee(uint256 newCreationFee) external onlyOwner {
        _creationFee = newCreationFee;
        emit CreationFeeUpdated(newCreationFee);
    }

    /// @inheritdoc IMindCore
    function setDrawLimit(uint256 maxPerEpoch, uint32 epochSeconds) external onlyOwner {
        if (epochSeconds < MIN_DRAW_EPOCH || maxPerEpoch > MAX_DRAW_PER_EPOCH) revert InvalidDrawLimit();
        _maxDrawPerEpoch = maxPerEpoch;
        _drawEpoch = epochSeconds;
        emit DrawLimitUpdated(maxPerEpoch, epochSeconds);
    }

    /// @notice Disabled: always reverts `RenounceDisabled()`. The contract must keep an owner (wiring, fee
    ///         parameters, draw limits, pause); ownership can still be transferred with the two-step flow.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// @inheritdoc IMindCore
    function pause() external onlyOwner {
        _pause();
    }

    /// @inheritdoc IMindCore
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @inheritdoc IMindCore
    function withdrawProtocolFees(address to) external nonReentrant {
        if (msg.sender != owner() && msg.sender != _treasury) revert OwnableUnauthorizedAccount(msg.sender);
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = _protocolBalance;
        if (amount == 0) revert ZeroAmount();
        _protocolBalance = 0;
        emit ProtocolFeesWithdrawn(to, amount);
        _sendEth(to, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    /// @dev Sets the default compute draw cap (SPEC §1: 0.25 ether per 1 day) and emits {DrawLimitUpdated}. Called
    ///      once from the venue's constructor.
    function _initDrawLimit() internal {
        _maxDrawPerEpoch = DEFAULT_MAX_DRAW_PER_EPOCH;
        _drawEpoch = DEFAULT_DRAW_EPOCH;
        emit DrawLimitUpdated(DEFAULT_MAX_DRAW_PER_EPOCH, DEFAULT_DRAW_EPOCH);
    }

    /// @dev Venue hook: whether `token`'s mind may currently be `Alive` (consulted by {setCreatorPaused} and
    ///      {setMindStatus}). Always true here; {PonsMindRegistry} returns false while the creator has left.
    function _canBeAlive(address) internal view virtual returns (bool) {
        return true;
    }

    /// @dev Registers a new mind (the caller emits {MindCreated} or its venue event).
    function _addMind(address token, MindInfo memory info) internal {
        _mindInfo[token] = info;
        _minds.push(token);
    }

    /// @dev Opens an ETH return window: {receive} accepts and counts ETH from `from` only.
    function _openReturn(address from) internal {
        _returnFrom = from;
        _returned = 0;
    }

    /// @dev Closes the return window and returns the wei that arrived through {receive} while it was open.
    function _takeReturned() internal returns (uint256 returned) {
        returned = _returned;
        _returnFrom = address(0);
        _returned = 0;
    }

    /// @dev Closes the return window and requires that exactly `reported` wei arrived through {receive}.
    function _closeReturn(uint256 reported) internal {
        if (_takeReturned() != reported) revert EthReturnMismatch();
    }

    /// @dev Sends ETH with `call`; reverts with {EthTransferFailed} on failure.
    function _sendEth(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }

    /// @dev Reverts {NotAMind} unless `token` is a registered mind.
    function _checkMind(address token) internal view {
        if (_mindInfo[token].creator == address(0)) revert NotAMind();
    }

    /// @dev Validates a token name (1..64 bytes) and symbol (1..16 bytes).
    function _checkNameSymbol(string calldata name, string calldata symbol) internal pure {
        uint256 nameLength = bytes(name).length;
        if (nameLength == 0 || nameLength > MAX_NAME_LENGTH) revert InvalidName();
        uint256 symbolLength = bytes(symbol).length;
        if (symbolLength == 0 || symbolLength > MAX_SYMBOL_LENGTH) revert InvalidSymbol();
    }

    /// @dev Validates the metadata URI length and the model id of a new mind (directive D10).
    function _checkConfig(bytes32 modelId, string calldata metadataURI) internal pure {
        if (bytes(metadataURI).length > MAX_METADATA_URI_LENGTH) revert MetadataTooLong();
        if (modelId == bytes32(0)) revert InvalidModel();
    }
}
