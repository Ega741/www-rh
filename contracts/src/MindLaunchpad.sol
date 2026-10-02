// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IGraduator} from "./interfaces/IGraduator.sol";
import {IMindLaunchpad} from "./interfaces/IMindLaunchpad.sol";
import {CurveMath} from "./libraries/CurveMath.sol";
import {MindCore} from "./MindCore.sol";
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
///      transfers use `call`. Ownership cannot be renounced. The venue-independent part (roles, registry, vault,
///      draws, protocol balance, return window) lives in {MindCore}.
contract MindLaunchpad is IMindLaunchpad, MindCore {
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

    uint16 internal constant MAX_TRADE_FEE_BPS = 500;
    uint16 internal constant MAX_MIND_SHARE_BPS = 10_000;
    uint16 internal constant MAX_GRADUATION_FEE_BPS = 1000;
    uint32 internal constant MIN_GRADUATION_GRACE = 1 hours;
    uint32 internal constant MAX_GRADUATION_GRACE = 30 days;
    uint32 internal constant DEFAULT_GRADUATION_GRACE = 1 days;

    // ---------------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------------

    address private _graduator;

    FeeParams private _feeParams;
    uint32 private _graduationGrace;

    mapping(address token => CurveState) private _curves;
    mapping(address token => uint64) private _completedAt;

    /// @inheritdoc IMindLaunchpad
    mapping(address token => address) public graduatorOf;

    // ---------------------------------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------------------------------

    /// @param initialOwner     Initial owner (Ownable2Step).
    /// @param treasury_        Protocol treasury (may withdraw protocol fees, like the owner).
    /// @param computeTreasury_ Recipient of every {drawCompute}.
    /// @param operator_        Runner hot wallet allowed to draw compute / anchor memories / toggle status.
    /// @dev The graduator is wired afterwards with {setGraduator} (launchpad -> graduator(launchpad) -> setGraduator).
    ///      Event order: TreasuryUpdated, ComputeTreasuryUpdated, OperatorUpdated (MindCore), FeeParamsUpdated,
    ///      DrawLimitUpdated, GraduationGraceUpdated.
    constructor(address initialOwner, address treasury_, address computeTreasury_, address operator_)
        MindCore(initialOwner, treasury_, computeTreasury_, operator_)
    {
        _feeParams = FeeParams({tradeFeeBps: 100, mindShareBps: 7000, graduationFeeBps: 250});
        emit FeeParamsUpdated(100, 7000, 250);
        _initDrawLimit();
        _graduationGrace = DEFAULT_GRADUATION_GRACE;
        emit GraduationGraceUpdated(DEFAULT_GRADUATION_GRACE);
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
        _checkNameSymbol(name, symbol);
        _checkConfig(modelId, metadataURI);
        uint256 fee = _creationFee;
        if (msg.value < fee) revert InsufficientCreationFee();

        token = address(new MindToken(name, symbol, address(this), msg.sender));

        _addMind(
            token,
            MindInfo({
                creator: msg.sender,
                modelId: modelId,
                personaHash: personaHash,
                metadataURI: metadataURI,
                createdAt: uint64(block.timestamp),
                status: MindStatus.Alive
            })
        );
        // _curves[token] starts zeroed: phase Bonding, no reserve, nothing sold.

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
    function getCurve(address token) external view returns (CurveState memory) {
        return _curves[token];
    }

    /// @inheritdoc IMindLaunchpad
    function feeParams() external view returns (FeeParams memory) {
        return _feeParams;
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
    // Owner
    // ---------------------------------------------------------------------------------------------

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
    function setGraduationGrace(uint32 graceSeconds) external onlyOwner {
        if (graceSeconds < MIN_GRADUATION_GRACE || graceSeconds > MAX_GRADUATION_GRACE) {
            revert InvalidGraduationGrace();
        }
        _graduationGrace = graceSeconds;
        emit GraduationGraceUpdated(graceSeconds);
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
}
