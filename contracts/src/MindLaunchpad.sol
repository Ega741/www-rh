// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IGraduator} from "./interfaces/IGraduator.sol";
import {IMindLaunchpad} from "./interfaces/IMindLaunchpad.sol";
import {CurveMath} from "./libraries/CurveMath.sol";
import {MindToken} from "./MindToken.sol";

/// @title MindLaunchpad
/// @notice Single core contract of "worldwideweb on Robinhood Chain": token factory, constant-product
///         bonding curve with virtual reserves, fee router (trade fees are split between the coin's
///         mind vault and the protocol), mind vault (compute budget drawn by the operator) and mind
///         registry. See SPEC §1 for the economics and §2.3 for the external interface.
/// @dev ETH is only accepted through payable functions; there is no `receive`/`fallback`, so plain
///      transfers revert. Every ETH-sending external function is `nonReentrant`. `creditMind` is
///      intentionally not guarded because the graduator calls it re-entrantly from `graduate`/`harvest`.
contract MindLaunchpad is IMindLaunchpad, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

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
    address private _graduator;

    FeeParams private _feeParams;
    uint256 private _creationFee;
    uint256 private _maxDrawPerEpoch;
    uint32 private _drawEpoch;

    uint256 private _protocolBalance;

    address[] private _minds;
    mapping(address token => MindInfo) private _mindInfo;
    mapping(address token => CurveState) private _curves;
    mapping(address token => uint256) private _mindBalances;
    mapping(address token => DrawEpoch) private _draws;
    /// @dev Graduator that actually holds `token`'s liquidity; survives later {setGraduator} calls.
    mapping(address token => address) private _graduatorOf;

    // ---------------------------------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------------------------------

    modifier onlyMind(address token) {
        if (_mindInfo[token].creator == address(0)) revert NotAMind();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != _operator) revert NotOperator();
        _;
    }

    modifier onlyCreator(address token) {
        if (_mindInfo[token].creator == address(0)) revert NotAMind();
        if (msg.sender != _mindInfo[token].creator) revert NotCreator();
        _;
    }

    // ---------------------------------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------------------------------

    /// @param owner_     Initial owner (Ownable2Step).
    /// @param treasury_  Protocol fee recipient (may withdraw protocol fees).
    /// @param operator_  Runner hot wallet allowed to draw compute / anchor memories / toggle status.
    /// @param graduator_ {IGraduator}; may be `address(0)` and set later with {setGraduator}.
    constructor(address owner_, address treasury_, address operator_, address graduator_) Ownable(owner_) {
        if (treasury_ == address(0) || operator_ == address(0)) revert ZeroAddress();
        _treasury = treasury_;
        _operator = operator_;
        _graduator = graduator_;
        _feeParams = FeeParams({tradeFeeBps: 100, mindShareBps: 7000, graduationFeeBps: 250});
        _maxDrawPerEpoch = 0.25 ether;
        _drawEpoch = 1 days;
        emit TreasuryUpdated(treasury_);
        emit OperatorUpdated(operator_);
        emit GraduatorUpdated(graduator_);
        emit FeeParamsUpdated(100, 7000, 250);
        emit DrawLimitUpdated(0.25 ether, 1 days);
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
        uint256 fee = _creationFee;
        if (msg.value < fee) revert InsufficientCreationFee();
        uint256 nameLength = bytes(name).length;
        if (nameLength == 0 || nameLength > MAX_NAME_LENGTH) revert InvalidName();
        uint256 symbolLength = bytes(symbol).length;
        if (symbolLength == 0 || symbolLength > MAX_SYMBOL_LENGTH) revert InvalidSymbol();

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
        CurveState storage curve = _curves[token];
        if (curve.phase != CurvePhase.Bonding) revert WrongPhase();
        if (tokensIn == 0) revert ZeroAmount();
        uint256 reserve = curve.realEthReserve;
        uint256 sold = curve.tokensSold;
        if (tokensIn > sold) revert ExceedsTokensSold();

        uint256 fee;
        (ethOut, fee) = CurveMath.quoteSell(reserve, sold, tokensIn, _feeParams.tradeFeeBps);
        if (ethOut == 0) revert ZeroAmount();
        if (ethOut < minEthOut) revert Slippage();

        uint256 newReserve = reserve - (ethOut + fee);
        uint256 newSold = sold - tokensIn;
        // Both values shrink here, so they still fit the uint128 they were read from.
        // forge-lint: disable-next-line(unsafe-typecast)
        curve.realEthReserve = uint128(newReserve);
        // forge-lint: disable-next-line(unsafe-typecast)
        curve.tokensSold = uint128(newSold);

        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);
        _accrueFee(token, fee);
        emit Trade(token, msg.sender, false, ethOut, tokensIn, fee, newReserve, newSold);
        _sendEth(msg.sender, ethOut);
    }

    /// @inheritdoc IMindLaunchpad
    function graduate(address token) external nonReentrant onlyMind(token) {
        _graduate(token);
    }

    /// @inheritdoc IMindLaunchpad
    function graduateFor(address token) external nonReentrant onlyMind(token) {
        _graduate(token);
    }

    /// @inheritdoc IMindLaunchpad
    function harvest(address token) external nonReentrant onlyMind(token) {
        CurveState storage curve = _curves[token];
        if (curve.phase != CurvePhase.Graduated) revert WrongPhase();
        (uint256 ethOut, uint256 tokensBurned) = IGraduator(_graduatorOf[token]).harvest(token);
        emit Harvested(token, ethOut, tokensBurned);
    }

    /// @inheritdoc IMindLaunchpad
    function fundMind(address token) external payable onlyMind(token) {
        if (msg.value == 0) revert ZeroAmount();
        if (_mindInfo[token].status == MindStatus.Retired) revert Retired();
        _mindBalances[token] += msg.value;
        emit MindFunded(token, msg.sender, msg.value);
    }

    /// @inheritdoc IMindLaunchpad
    function creditMind(address token) external payable onlyMind(token) {
        if (msg.sender != _graduator && msg.sender != _graduatorOf[token]) revert NotGraduator();
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
        if (tokensIn > curve.tokensSold) revert ExceedsTokensSold();
        return CurveMath.quoteSell(curve.realEthReserve, curve.tokensSold, tokensIn, _feeParams.tradeFeeBps);
    }

    /// @inheritdoc IMindLaunchpad
    function currentPrice(address token) external view onlyMind(token) returns (uint256 weiPer1e18Tokens) {
        CurveState storage curve = _curves[token];
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
    function graduator() external view returns (address) {
        return _graduator;
    }

    /// @notice The graduator holding `token`'s DEX liquidity (address(0) until graduated).
    function graduatorOf(address token) external view returns (address) {
        return _graduatorOf[token];
    }

    // ---------------------------------------------------------------------------------------------
    // Creator
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IMindLaunchpad
    function setMindConfig(address token, bytes32 modelId, bytes32 personaHash, string calldata metadataURI)
        external
        onlyCreator(token)
    {
        MindInfo storage info = _mindInfo[token];
        info.modelId = modelId;
        info.personaHash = personaHash;
        info.metadataURI = metadataURI;
        emit MindConfigUpdated(token, modelId, personaHash, metadataURI);
    }

    /// @inheritdoc IMindLaunchpad
    function retireMind(address token) external onlyCreator(token) {
        MindInfo storage info = _mindInfo[token];
        if (info.status == MindStatus.Retired) revert Retired();
        info.status = MindStatus.Retired;
        emit MindStatusChanged(token, MindStatus.Retired);
    }

    /// @inheritdoc IMindLaunchpad
    function withdrawRetiredMind(address token, address to) external nonReentrant onlyCreator(token) {
        if (to == address(0)) revert ZeroAddress();
        if (_mindInfo[token].status != MindStatus.Retired) revert InvalidStatus();
        uint256 amount = _mindBalances[token];
        if (amount == 0) revert ZeroAmount();
        _mindBalances[token] = 0;
        emit RetiredMindWithdrawn(token, to, amount);
        _sendEth(to, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Operator
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IMindLaunchpad
    function drawCompute(address token, uint256 amount, address to, bytes32 receiptHash)
        external
        nonReentrant
        onlyOperator
        onlyMind(token)
    {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (_mindInfo[token].status == MindStatus.Retired) revert Retired();
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
        // drawn <= balance <= total ETH supply < 2^192.
        // forge-lint: disable-next-line(unsafe-typecast)
        epoch.drawn = uint192(drawn);

        _mindBalances[token] = balance - amount;
        emit ComputeDrawn(token, amount, to, receiptHash);
        _sendEth(to, amount);
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
        if (status == MindStatus.Retired) revert InvalidStatus();
        MindInfo storage info = _mindInfo[token];
        if (info.status == MindStatus.Retired) revert Retired();
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
    /// @dev `address(0)` is allowed and disables graduation until a graduator is set again.
    function setGraduator(address newGraduator) external onlyOwner {
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
        _maxDrawPerEpoch = maxPerEpoch;
        _drawEpoch = epochSeconds;
        emit DrawLimitUpdated(maxPerEpoch, epochSeconds);
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

    /// @dev Executes a buy for `buyer` with `ethIn` wei already held by this contract.
    function _buy(address token, address buyer, uint256 ethIn, uint256 minTokensOut)
        internal
        returns (uint256 tokensOut)
    {
        CurveState storage curve = _curves[token];
        if (curve.phase != CurvePhase.Bonding) revert WrongPhase();
        if (ethIn == 0) revert ZeroAmount();

        uint256 reserve = curve.realEthReserve;
        uint256 sold = curve.tokensSold;
        uint256 ethUsed;
        uint256 fee;
        (tokensOut, ethUsed, fee) = CurveMath.quoteBuy(reserve, sold, ethIn, _feeParams.tradeFeeBps);
        if (tokensOut == 0) revert ZeroAmount();
        if (tokensOut < minTokensOut) revert Slippage();

        uint256 newReserve = reserve + (ethUsed - fee);
        uint256 newSold = sold + tokensOut;
        // newSold <= CURVE_SUPPLY (8e26) and newReserve <= ~4.05e18 (the reserve at completion), both < 2^128.
        // forge-lint: disable-next-line(unsafe-typecast)
        curve.realEthReserve = uint128(newReserve);
        // forge-lint: disable-next-line(unsafe-typecast)
        curve.tokensSold = uint128(newSold);

        _accrueFee(token, fee);
        emit Trade(token, buyer, true, ethUsed, tokensOut, fee, newReserve, newSold);
        if (newSold == CURVE_SUPPLY) {
            curve.phase = CurvePhase.Complete;
            emit CurveCompleted(token, newReserve);
        }

        IERC20(token).safeTransfer(buyer, tokensOut);
        uint256 refund = ethIn - ethUsed;
        if (refund > 0) _sendEth(buyer, refund);
    }

    /// @dev Moves a `Complete` curve to the DEX through the current graduator.
    function _graduate(address token) internal {
        CurveState storage curve = _curves[token];
        if (curve.phase != CurvePhase.Complete) revert WrongPhase();
        address grad = _graduator;
        if (grad == address(0)) revert ZeroAddress();

        uint256 reserve = curve.realEthReserve;
        uint256 graduationFee = reserve * _feeParams.graduationFeeBps / BPS;
        uint256 ethLiquidity = reserve - graduationFee;
        uint256 finalPrice = CurveMath.price(reserve, CURVE_SUPPLY);

        curve.realEthReserve = 0;
        curve.phase = CurvePhase.Graduated;
        _graduatorOf[token] = grad;
        _accrueFee(token, graduationFee);

        IERC20(token).safeTransfer(grad, LP_SUPPLY);
        (address pool, uint256 positionId) =
            IGraduator(grad).graduate{value: ethLiquidity}(token, LP_SUPPLY, finalPrice);
        curve.pool = pool;
        curve.positionId = positionId;

        emit Graduated(token, pool, positionId, ethLiquidity, LP_SUPPLY, graduationFee);
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
}
