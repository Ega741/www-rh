// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IGraduator} from "./interfaces/IGraduator.sol";
import {IMindLaunchpad} from "./interfaces/IMindLaunchpad.sol";
import {CurveMath} from "./libraries/CurveMath.sol";
import {MindToken} from "./MindToken.sol";

/// @title MindLaunchpad
/// @notice Single core contract of "worldwideweb on Robinhood Chain": token factory, constant-product bonding
///         curve with virtual reserves, fee router (trade fees are split between the coin's mind vault and the
///         protocol), mind vault (compute budget drawn by the operator to the compute treasury) and mind
///         registry. See SPEC §1 for the economics and §2.3 for the external interface.
/// @dev Accounting invariant: `address(this).balance >= Σ realEthReserve + Σ mindBalance + protocolBalance`.
///      ETH enters through payable functions or through {receive}, which only accepts ETH from the graduator that
///      {graduate}/{harvest} is calling at that moment and counts it; after the call the count must equal the
///      graduator's reported return, which is then credited to the mind vault (no balance-delta accounting).
///      Every ETH-sending or graduator-calling external function, and {fundMind}, is `nonReentrant`; all ETH
///      transfers use `call`. Ownership cannot be renounced.
contract MindLaunchpad is IMindLaunchpad, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    // ---------------------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IMindLaunchpad
    uint256 public constant TOTAL_SUPPLY = CurveMath.TOTAL_SUPPLY;
    /// @inheritdoc IMindLaunchpad
    uint256 public constant CURVE_SUPPLY = CurveMath.CURVE_SUPPLY;
    /// @inheritdoc IMindLaunchpad
    uint256 public constant LP_SUPPLY = CurveMath.LP_SUPPLY;
    /// @inheritdoc IMindLaunchpad
    uint256 public constant VIRTUAL_ETH = CurveMath.VIRTUAL_ETH;
    /// @inheritdoc IMindLaunchpad
    uint256 public constant VIRTUAL_TOKENS = CurveMath.VIRTUAL_TOKENS;

    uint256 internal constant BPS = CurveMath.BPS;
    uint16 internal constant MAX_TRADE_FEE_BPS = 500;
    uint16 internal constant MAX_MIND_SHARE_BPS = 10_000;
    uint16 internal constant MAX_GRADUATION_FEE_BPS = 1000;
    uint256 internal constant MAX_NAME_LENGTH = 64;
    uint256 internal constant MAX_SYMBOL_LENGTH = 16;
    uint256 internal constant MAX_METADATA_URI_LENGTH = 2048;
    uint32 internal constant MIN_DRAW_EPOCH = 1 hours;
    /// @dev Hard ceiling of {setDrawLimit}'s `maxPerEpoch`: with fixed epochs, at most `2 * MAX_DRAW_PER_EPOCH`
    ///      (4 ether) can leave one mind vault within any `epochSeconds` window (end of one epoch + start of the
    ///      next), whatever the owner configures.
    uint256 internal constant MAX_DRAW_PER_EPOCH = 2 ether;
    uint32 internal constant MIN_GRADUATION_GRACE = 1 hours;
    uint32 internal constant MAX_GRADUATION_GRACE = 30 days;
    uint32 internal constant DEFAULT_GRADUATION_GRACE = 1 days;

    // ---------------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------------

    /// @dev Per-mind epoch accounting for {drawCompute}.
    struct DrawEpoch {
        uint192 drawn;
        uint64 epochStart;
    }

    address private _operator;
    address private _treasury;
    address private _computeTreasury;
    address private _graduator;

    FeeParams private _feeParams;
    uint256 private _creationFee;
    uint256 private _maxDrawPerEpoch;
    uint32 private _drawEpoch;
    uint32 private _graduationGrace;

    uint256 private _protocolBalance;

    address[] private _minds;
    mapping(address token => MindInfo) private _mindInfo;
    mapping(address token => CurveState) private _curves;
    mapping(address token => uint256) private _mindBalances;
    mapping(address token => DrawEpoch) private _draws;
    mapping(address token => uint64) private _completedAt;

    /// @inheritdoc IMindLaunchpad
    mapping(address token => address) public graduatorOf;

    /// @dev Graduator whose {graduate}/{harvest} call is in progress: the only account {receive} accepts ETH from.
    ///      Zero outside those calls.
    address private _returnFrom;
    /// @dev Wei received by {receive} from `_returnFrom` during the current graduator call. Zero outside those calls.
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
    /// @dev The graduator is wired afterwards with {setGraduator} (launchpad -> graduator(launchpad) -> setGraduator).
    constructor(address initialOwner, address treasury_, address computeTreasury_, address operator_)
        Ownable(initialOwner)
    {
        if (treasury_ == address(0) || computeTreasury_ == address(0) || operator_ == address(0)) {
            revert ZeroAddress();
        }
        _treasury = treasury_;
        _computeTreasury = computeTreasury_;
        _operator = operator_;
        _feeParams = FeeParams({tradeFeeBps: 100, mindShareBps: 7000, graduationFeeBps: 250});
        _maxDrawPerEpoch = 0.25 ether;
        _drawEpoch = 1 days;
        _graduationGrace = DEFAULT_GRADUATION_GRACE;
        emit TreasuryUpdated(treasury_);
        emit ComputeTreasuryUpdated(computeTreasury_);
        emit OperatorUpdated(operator_);
        emit FeeParamsUpdated(100, 7000, 250);
        emit DrawLimitUpdated(0.25 ether, 1 days);
        emit GraduationGraceUpdated(DEFAULT_GRADUATION_GRACE);
    }

    /// @notice Accepts plain ETH only from the graduator whose {graduate}/{harvest} call is in progress (leftovers /
    ///         harvest proceeds) and counts it; that call then requires the count to equal the reported amount.
    ///         Anything else reverts `DirectEthNotAccepted()`. Writes storage: graduators must send with a full-gas
    ///         `call`, not `transfer`/`send`.
    receive() external payable {
        if (msg.sender != _returnFrom) revert DirectEthNotAccepted();
        _returned += msg.value;
    }

    // ---------------------------------------------------------------------------------------------
    // User
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IMindLaunchpad
    function createMind(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        bytes32 modelId,
        bytes32 personaHash,
        uint256 minTokensOut
    ) external payable whenNotPaused nonReentrant returns (address token) {
        uint256 nameLength = bytes(name).length;
        if (nameLength == 0 || nameLength > MAX_NAME_LENGTH) revert InvalidName();
        uint256 symbolLength = bytes(symbol).length;
        if (symbolLength == 0 || symbolLength > MAX_SYMBOL_LENGTH) revert InvalidSymbol();
        _checkConfig(modelId, metadataURI);
        uint256 fee = _creationFee;
        if (msg.value < fee) revert InsufficientCreationFee();

        token = address(new MindToken(name, symbol, address(this), msg.sender));

        _mindInfo[token] = MindInfo({
            creator: msg.sender,
            modelId: modelId,
            personaHash: personaHash,
            metadataURI: metadataURI,
            createdAt: uint64(block.timestamp),
            status: MindStatus.Alive
        });
        // _curves[token] starts zeroed: phase Bonding, no reserve, nothing sold.
        _minds.push(token);

        emit MindCreated(token, msg.sender, name, symbol, metadataURI, modelId, personaHash);

        if (fee > 0) {
            _protocolBalance += fee;
            emit FeeAccrued(token, 0, fee);
        }
        uint256 initialBuy = msg.value - fee;
        if (initialBuy > 0) _buy(token, msg.sender, initialBuy, minTokensOut);
    }

    /// @inheritdoc IMindLaunchpad
    function buy(address token, uint256 minTokensOut, uint256 deadline)
        external
        payable
        whenNotPaused
        nonReentrant
        onlyMind(token)
        returns (uint256 tokensOut)
    {
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > deadline) revert Expired();
        tokensOut = _buy(token, msg.sender, msg.value, minTokensOut);
    }

    /// @inheritdoc IMindLaunchpad
    function sell(address token, uint256 tokensIn, uint256 minEthOut, uint256 deadline)
        external
        nonReentrant
        onlyMind(token)
        returns (uint256 ethOut)
    {
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > deadline) revert Expired();
        if (tokensIn == 0) revert ZeroAmount();
        CurveState storage curve = _curves[token];
        if (_checkSellPhase(token, curve.phase)) _reopen(token, curve);
        uint256 reserve = curve.realEthReserve;
        uint256 sold = curve.tokensSold;
        if (tokensIn > sold) revert ExceedsTokensSold();

        uint256 fee;
        (ethOut, fee) = CurveMath.quoteSell(reserve, sold, tokensIn, _feeParams.tradeFeeBps);
        if (ethOut == 0) revert ZeroAmount();
        if (ethOut < minEthOut) revert Slippage();

        uint256 newReserve = reserve - (ethOut + fee);
        uint256 newSold = sold - tokensIn;
        curve.realEthReserve = newReserve.toUint128();
        curve.tokensSold = newSold.toUint128();

        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);
        _accrueFee(token, fee);
        emit Trade(token, msg.sender, false, ethOut, tokensIn, fee, newReserve, newSold);
        _sendEth(msg.sender, ethOut);
    }

    /// @inheritdoc IMindLaunchpad
    function graduate(address token) external nonReentrant onlyMind(token) {
        CurveState storage curve = _curves[token];
        if (curve.phase != CurvePhase.Complete) revert WrongPhase();
        address grad = _graduator;
        if (grad == address(0)) revert GraduatorNotSet();

        uint256 reserve = curve.realEthReserve;
        uint256 graduationFee = reserve * _feeParams.graduationFeeBps / BPS;
        uint256 ethLiquidity = reserve - graduationFee;

        curve.realEthReserve = 0;
        curve.phase = CurvePhase.Graduated;
        graduatorOf[token] = grad;
        _accrueFee(token, graduationFee);

        IERC20(token).safeTransfer(grad, LP_SUPPLY);
        _openReturn(grad);
        (address pool, uint256 positionId, uint256 ethReturned) =
            IGraduator(grad).graduate{value: ethLiquidity}(token, LP_SUPPLY);
        _closeReturn(ethReturned);

        curve.pool = pool;
        curve.positionId = positionId;
        _creditFromGraduator(token, grad, ethReturned);
        emit Graduated(token, pool, positionId, ethLiquidity, LP_SUPPLY, graduationFee);
    }

    /// @inheritdoc IMindLaunchpad
    function harvest(address token) external nonReentrant onlyMind(token) {
        if (_curves[token].phase != CurvePhase.Graduated) revert WrongPhase();
        address grad = graduatorOf[token];

        _openReturn(grad);
        (uint256 ethOut, uint256 tokensBurned) = IGraduator(grad).harvest(token);
        _closeReturn(ethOut);

        _creditFromGraduator(token, grad, ethOut);
        emit Harvested(token, ethOut, tokensBurned);
    }

    /// @inheritdoc IMindLaunchpad
    /// @dev `nonReentrant`: a graduator cannot route its return through here during {graduate}/{harvest}.
    function fundMind(address token) external payable nonReentrant onlyMind(token) {
        if (msg.value == 0) revert ZeroAmount();
        _mindBalances[token] += msg.value;
        emit MindFunded(token, msg.sender, msg.value);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IMindLaunchpad
    function quoteBuy(address token, uint256 ethIn)
        external
        view
        onlyMind(token)
        returns (uint256 tokensOut, uint256 ethUsed, uint256 fee)
    {
        CurveState storage curve = _curves[token];
        if (curve.phase != CurvePhase.Bonding) revert WrongPhase();
        if (ethIn == 0) revert ZeroAmount();
        return CurveMath.quoteBuy(curve.realEthReserve, curve.tokensSold, ethIn, _feeParams.tradeFeeBps);
    }

    /// @inheritdoc IMindLaunchpad
    function quoteSell(address token, uint256 tokensIn)
        external
        view
        onlyMind(token)
        returns (uint256 ethOut, uint256 fee)
    {
        CurveState storage curve = _curves[token];
        _checkSellPhase(token, curve.phase);
        if (tokensIn == 0) revert ZeroAmount();
        if (tokensIn > curve.tokensSold) revert ExceedsTokensSold();
        return CurveMath.quoteSell(curve.realEthReserve, curve.tokensSold, tokensIn, _feeParams.tradeFeeBps);
    }

    /// @inheritdoc IMindLaunchpad
    function currentPrice(address token) external view onlyMind(token) returns (uint256 weiPer1e18Tokens) {
        CurveState storage curve = _curves[token];
        if (curve.phase == CurvePhase.Graduated) revert WrongPhase();
        return CurveMath.price(curve.realEthReserve, curve.tokensSold);
    }

    /// @inheritdoc IMindLaunchpad
    function getMind(address token) external view returns (MindInfo memory) {
        return _mindInfo[token];
    }

    /// @inheritdoc IMindLaunchpad
    function getCurve(address token) external view returns (CurveState memory) {
        return _curves[token];
    }

    /// @inheritdoc IMindLaunchpad
    function mindBalance(address token) external view returns (uint256) {
        return _mindBalances[token];
    }

    /// @inheritdoc IMindLaunchpad
    function protocolBalance() external view returns (uint256) {
        return _protocolBalance;
    }

    /// @inheritdoc IMindLaunchpad
    function mindsLength() external view returns (uint256) {
        return _minds.length;
    }

    /// @inheritdoc IMindLaunchpad
    function mindAt(uint256 index) external view returns (address) {
        return _minds[index];
    }

    /// @inheritdoc IMindLaunchpad
    function isMind(address token) external view returns (bool) {
        return _mindInfo[token].creator != address(0);
    }

    /// @inheritdoc IMindLaunchpad
    function feeParams() external view returns (FeeParams memory) {
        return _feeParams;
    }

    /// @inheritdoc IMindLaunchpad
    function creationFee() external view returns (uint256) {
        return _creationFee;
    }

    /// @inheritdoc IMindLaunchpad
    function drawLimit() external view returns (uint256 maxPerEpoch, uint32 epochSeconds) {
        return (_maxDrawPerEpoch, _drawEpoch);
    }

    /// @inheritdoc IMindLaunchpad
    function drawnInEpoch(address token) external view returns (uint256 drawn, uint64 epochStart) {
        DrawEpoch storage epoch = _draws[token];
        return (epoch.drawn, epoch.epochStart);
    }

    /// @inheritdoc IMindLaunchpad
    function operator() external view returns (address) {
        return _operator;
    }

    /// @inheritdoc IMindLaunchpad
    function treasury() external view returns (address) {
        return _treasury;
    }

    /// @inheritdoc IMindLaunchpad
    function computeTreasury() external view returns (address) {
        return _computeTreasury;
    }

    /// @inheritdoc IMindLaunchpad
    function graduator() external view returns (address) {
        return _graduator;
    }

    /// @inheritdoc IMindLaunchpad
    function completedAt(address token) external view returns (uint64) {
        return _completedAt[token];
    }

    /// @inheritdoc IMindLaunchpad
    function graduationGrace() external view returns (uint32) {
        return _graduationGrace;
    }

    // ---------------------------------------------------------------------------------------------
    // Creator
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IMindLaunchpad
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

    /// @inheritdoc IMindLaunchpad
    function setCreatorPaused(address token, bool paused) external onlyCreator(token) {
        MindInfo storage info = _mindInfo[token];
        if (paused == (info.status == MindStatus.Paused)) return;
        MindStatus status = paused ? MindStatus.Paused : MindStatus.Alive;
        info.status = status;
        emit MindStatusChanged(token, status);
    }

    // ---------------------------------------------------------------------------------------------
    // Operator
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IMindLaunchpad
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

    /// @inheritdoc IMindLaunchpad
    function anchorMemory(address token, uint64 seq, bytes32 contentHash, string calldata uri)
        external
        onlyOperator
        onlyMind(token)
    {
        emit MemoryAnchored(token, seq, contentHash, uri);
    }

    /// @inheritdoc IMindLaunchpad
    function setMindStatus(address token, MindStatus status) external onlyOperator onlyMind(token) {
        MindInfo storage info = _mindInfo[token];
        if (status == MindStatus.Paused || info.status == MindStatus.Paused) revert InvalidStatus();
        if (info.status == status) return;
        info.status = status;
        emit MindStatusChanged(token, status);
    }

    // ---------------------------------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IMindLaunchpad
    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert ZeroAddress();
        _operator = newOperator;
        emit OperatorUpdated(newOperator);
    }

    /// @inheritdoc IMindLaunchpad
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        _treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    /// @inheritdoc IMindLaunchpad
    function setComputeTreasury(address newComputeTreasury) external onlyOwner {
        if (newComputeTreasury == address(0)) revert ZeroAddress();
        _computeTreasury = newComputeTreasury;
        emit ComputeTreasuryUpdated(newComputeTreasury);
    }

    /// @inheritdoc IMindLaunchpad
    /// @dev Already graduated coins keep using `graduatorOf(token)`.
    function setGraduator(address newGraduator) external onlyOwner {
        if (newGraduator != address(0) && !_servesThisLaunchpad(newGraduator)) revert InvalidGraduator();
        _graduator = newGraduator;
        emit GraduatorUpdated(newGraduator);
    }

    /// @inheritdoc IMindLaunchpad
    function setFeeParams(FeeParams calldata params) external onlyOwner {
        if (
            params.tradeFeeBps > MAX_TRADE_FEE_BPS || params.mindShareBps > MAX_MIND_SHARE_BPS
                || params.graduationFeeBps > MAX_GRADUATION_FEE_BPS
        ) revert FeeTooHigh();
        _feeParams = params;
        emit FeeParamsUpdated(params.tradeFeeBps, params.mindShareBps, params.graduationFeeBps);
    }

    /// @inheritdoc IMindLaunchpad
    function setCreationFee(uint256 newCreationFee) external onlyOwner {
        _creationFee = newCreationFee;
        emit CreationFeeUpdated(newCreationFee);
    }

    /// @inheritdoc IMindLaunchpad
    function setDrawLimit(uint256 maxPerEpoch, uint32 epochSeconds) external onlyOwner {
        if (epochSeconds < MIN_DRAW_EPOCH || maxPerEpoch > MAX_DRAW_PER_EPOCH) revert InvalidDrawLimit();
        _maxDrawPerEpoch = maxPerEpoch;
        _drawEpoch = epochSeconds;
        emit DrawLimitUpdated(maxPerEpoch, epochSeconds);
    }

    /// @inheritdoc IMindLaunchpad
    function setGraduationGrace(uint32 graceSeconds) external onlyOwner {
        if (graceSeconds < MIN_GRADUATION_GRACE || graceSeconds > MAX_GRADUATION_GRACE) {
            revert InvalidGraduationGrace();
        }
        _graduationGrace = graceSeconds;
        emit GraduationGraceUpdated(graceSeconds);
    }

    /// @notice Disabled: always reverts `RenounceDisabled()`. The launchpad must keep an owner (graduator wiring,
    ///         fee parameters, draw limits, pause); ownership can still be transferred with the two-step flow.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// @inheritdoc IMindLaunchpad
    function pause() external onlyOwner {
        _pause();
    }

    /// @inheritdoc IMindLaunchpad
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @inheritdoc IMindLaunchpad
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

    /// @dev Executes a buy for `buyer` with `ethIn` wei already held by this contract (SPEC §1, directive D6:
    ///      the completing buy uses the recomputed `net'`/`fee'` and refunds `ethIn - ethUsed`).
    function _buy(address token, address buyer, uint256 ethIn, uint256 minTokensOut)
        internal
        returns (uint256 tokensOut)
    {
        if (ethIn == 0) revert ZeroAmount();
        CurveState storage curve = _curves[token];
        if (curve.phase != CurvePhase.Bonding) revert WrongPhase();

        uint256 reserve = curve.realEthReserve;
        uint256 sold = curve.tokensSold;
        uint256 ethUsed;
        uint256 fee;
        (tokensOut, ethUsed, fee) = CurveMath.quoteBuy(reserve, sold, ethIn, _feeParams.tradeFeeBps);
        if (tokensOut == 0) revert ZeroAmount();
        if (tokensOut < minTokensOut) revert Slippage();

        uint256 newReserve = reserve + (ethUsed - fee);
        uint256 newSold = sold + tokensOut;
        curve.realEthReserve = newReserve.toUint128();
        curve.tokensSold = newSold.toUint128();

        _accrueFee(token, fee);
        emit Trade(token, buyer, true, ethUsed, tokensOut, fee, newReserve, newSold);
        if (newSold == CURVE_SUPPLY) {
            curve.phase = CurvePhase.Complete;
            _completedAt[token] = uint64(block.timestamp);
            emit CurveCompleted(token, newReserve);
        }

        IERC20(token).safeTransfer(buyer, tokensOut);
        uint256 refund = ethIn - ethUsed;
        if (refund > 0) _sendEth(buyer, refund);
    }

    /// @dev A post-grace sell on a `Complete` curve puts it back to `Bonding` (before the sell itself executes; a
    ///      failing sell reverts this too).
    function _reopen(address token, CurveState storage curve) internal {
        curve.phase = CurvePhase.Bonding;
        delete _completedAt[token];
        emit CurveReopened(token);
    }

    /// @dev Opens the ETH return window of a graduator call: {receive} accepts and counts ETH from `grad` only.
    function _openReturn(address grad) internal {
        _returnFrom = grad;
        _returned = 0;
    }

    /// @dev Closes the return window and requires that exactly `reported` wei arrived through {receive}.
    function _closeReturn(uint256 reported) internal {
        uint256 returned = _returned;
        _returnFrom = address(0);
        _returned = 0;
        if (returned != reported) revert EthReturnMismatch();
    }

    /// @dev Credits ETH a graduator returned during {graduate}/{harvest} (already checked against the counter).
    function _creditFromGraduator(address token, address grad, uint256 amount) internal {
        if (amount == 0) return;
        _mindBalances[token] += amount;
        emit MindFunded(token, grad, amount);
    }

    /// @dev Splits `fee` between the mind vault and the protocol and emits {FeeAccrued}.
    function _accrueFee(address token, uint256 fee) internal {
        (uint256 mindAmount, uint256 protocolAmount) = CurveMath.splitFee(fee, _feeParams.mindShareBps);
        _mindBalances[token] += mindAmount;
        _protocolBalance += protocolAmount;
        emit FeeAccrued(token, mindAmount, protocolAmount);
    }

    /// @dev Sends ETH with `call`; reverts with {EthTransferFailed} on failure.
    function _sendEth(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }

    /// @dev Reverts {NotAMind} unless `token` was created here.
    function _checkMind(address token) internal view {
        if (_mindInfo[token].creator == address(0)) revert NotAMind();
    }

    /// @dev Sell rule of {sell}/{quoteSell}: `Bonding`, or `Complete` once the graduation grace has elapsed (the sell
    ///      then reopens the curve: `reopen == true`). Reverts {WrongPhase} otherwise.
    function _checkSellPhase(address token, CurvePhase phase) internal view returns (bool reopen) {
        if (phase == CurvePhase.Bonding) return false;
        // forge-lint: disable-next-line(block-timestamp)
        if (phase != CurvePhase.Complete || block.timestamp < uint256(_completedAt[token]) + _graduationGrace) {
            revert WrongPhase();
        }
        return true;
    }

    /// @dev Whether `account` is a contract whose `IGraduator.launchpad()` returns this launchpad.
    function _servesThisLaunchpad(address account) internal view returns (bool) {
        if (account.code.length == 0) return false;
        (bool ok, bytes memory ret) = account.staticcall(abi.encodeCall(IGraduator.launchpad, ()));
        return ok && ret.length >= 32 && abi.decode(ret, (uint256)) == uint256(uint160(address(this)));
    }

    /// @dev Validates the metadata URI length and the model id of {createMind} (directive D10).
    function _checkConfig(bytes32 modelId, string calldata metadataURI) internal pure {
        if (bytes(metadataURI).length > MAX_METADATA_URI_LENGTH) revert MetadataTooLong();
        if (modelId == bytes32(0)) revert InvalidModel();
    }
}
