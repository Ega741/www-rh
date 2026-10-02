// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPonsV2BondingCurve} from "../../../src/interfaces/pons/IPonsV2BondingCurve.sol";
import {IPonsV2FeeEscrow} from "../../../src/interfaces/pons/IPonsV2FeeEscrow.sol";
import {IPonsV2MemeHook} from "../../../src/interfaces/pons/IPonsV2MemeHook.sol";

/// @notice What the curve needs from the factory (auto-graduation in the crossing buy).
interface IMockPonsGraduation {
    function graduate(address token) external;
}

/// @notice What the curve reads live from the fee policy (the meme hook).
interface IMockPonsFeePolicy {
    function feeSweepOperator() external view returns (address);
}

/// @notice Model of a native-quote `PonsV2BondingCurve` with the real accounting: tracked quote/token reserves, phantom
///         quote reserve, fee and creator tax charged on the quote leg (`fee = spent * feeBps / 1e4`,
///         `tax = spent * creatorTaxBps / 1e4`), constant-product `getAmountOut`/`getAmountIn`, the reserved token
///         allocation (`supply * phantom / (phantom + threshold)`), the capped final buy charged by the token side and
///         refunded to `msg.sender`, the price-bound slippage check, sells closed once ready to graduate,
///         auto-graduation through the factory in the crossing buy, and `sweepFees` crediting the escrow (protocol
///         share to the policy recipient, the rest plus the tax to the current creator fee recipient `deployer`),
///         callable by the fee sweep operator or `deployer`.
/// @dev Simplifications: native quote only; an executed buyback is folded back into the creator share (the real curve
///      swaps it and locks the tokens); the snipe tax decays linearly (real: exponentially) from `snipeTaxStartBps`
///      over `snipeTaxSeconds` after initialization, keyed on the buy's recipient, and is booked with the base fee.
contract MockPonsCurve is IPonsV2BondingCurve, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    uint256 private constant MAX_TOTAL_TRADE_FEE_BPS = 2000;

    /// @notice Constructor arguments (bundled to keep the factory's stack shallow).
    struct Config {
        address deployer; // initial creator fee recipient
        address factory;
        address feePolicy;
        IPonsV2MemeHook.FeePolicySnapshot policy;
        IPonsV2FeeEscrow feeEscrow;
        uint256 phantomQuote;
        uint256 feeBps;
        uint256 creatorTaxBps;
        bool buybackEnabled;
        uint256 graduationThreshold;
        uint256 snipeTaxStartBps;
        uint256 snipeTaxSeconds;
    }

    struct BuyQuote {
        uint256 spent;
        uint256 fee;
        uint256 tax;
        uint256 snipeTax;
        uint256 tokensOut;
    }

    address public token;
    address public constant pairToken = address(0);
    address public deployer;
    address public immutable factory;
    IMockPonsFeePolicy public immutable feePolicy;
    IPonsV2FeeEscrow public immutable feeEscrow;
    address public immutable protocolFeeRecipient;
    uint16 public immutable protocolFeeShareBps;
    uint16 public immutable buybackBurnBps;
    uint256 public immutable phantomQuote;
    uint256 public immutable feeBps;
    uint256 public immutable creatorTaxBps;
    uint256 public immutable graduationThreshold;
    uint256 public immutable snipeTaxStartBps;
    uint256 public immutable snipeTaxSeconds;
    bool public buybackEnabled;

    uint256 public quoteFeeBalance;
    uint256 public buybackQuoteBalance;
    uint256 public creatorTaxBalance;
    uint256 public trackedQuote;
    uint256 public trackedTokens;
    bool public graduated;
    uint256 public reservedTokens;
    uint256 public launchedAt;
    uint256 public launchSupply;
    mapping(address account => bool) public snipeTaxExempt;

    error CurveGraduated();
    error ZeroAmount();
    error ZeroAddress();
    error SlippageExceeded(uint256 actual, uint256 minimum);
    error NotFactory();
    error TransferFailed();
    error AlreadyGraduated();
    error AlreadyInitialized();
    error NotInitialized();
    error InvalidLaunchEconomics();
    error NotReadyToGraduate();
    error NotFeeSweepOperator();
    error InternalSwapRequiresOperator();
    error InvalidFeePolicy();
    error MinimumOutputRequired();
    error NativeValueMismatch(uint256 supplied, uint256 expected);
    error InsufficientInputAmount();
    error InsufficientOutputAmount();
    error InsufficientLiquidity();

    event Initialized(address token);
    event CreatorFeeRecipientUpdated(address indexed previousRecipient, address indexed newRecipient);
    event BuybackEnabledUpdated(bool enabled);
    event AutoGraduationFailed(address indexed token, uint256 gasRemaining);
    event SnipeTaxCharged(address indexed recipient, uint256 amount);
    event SnipeTaxExempted(address indexed account);

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    modifier onlyInitialized() {
        if (token == address(0)) revert NotInitialized();
        _;
    }

    constructor(Config memory c) {
        if (c.deployer == address(0) || c.factory == address(0)) revert ZeroAddress();
        if (c.feePolicy == address(0) || address(c.feeEscrow) == address(0)) revert ZeroAddress();
        if (c.policy.protocolFeeRecipient == address(0) || c.policy.protocolFeeShareBps > BPS) {
            revert InvalidFeePolicy();
        }
        if (c.feeBps + c.creatorTaxBps > MAX_TOTAL_TRADE_FEE_BPS) revert InvalidFeePolicy();
        deployer = c.deployer;
        factory = c.factory;
        feePolicy = IMockPonsFeePolicy(c.feePolicy);
        feeEscrow = c.feeEscrow;
        protocolFeeRecipient = c.policy.protocolFeeRecipient;
        protocolFeeShareBps = c.policy.protocolFeeShareBps;
        buybackBurnBps = c.policy.buybackBurnBps;
        phantomQuote = c.phantomQuote;
        feeBps = c.feeBps;
        creatorTaxBps = c.creatorTaxBps;
        buybackEnabled = c.buybackEnabled;
        graduationThreshold = c.graduationThreshold;
        snipeTaxStartBps = c.snipeTaxStartBps;
        snipeTaxSeconds = c.snipeTaxSeconds;
    }

    // ------------------------------------------------------------------ factory

    function initialize(address token_) external onlyFactory {
        if (token != address(0)) revert AlreadyInitialized();
        if (token_ == address(0)) revert ZeroAddress();
        token = token_;
        uint256 supply = IERC20(token_).totalSupply();
        uint256 reserved = Math.mulDiv(supply, phantomQuote, phantomQuote + graduationThreshold);
        if (reserved == 0 || reserved >= supply) revert InvalidLaunchEconomics();
        reservedTokens = reserved;
        trackedTokens = IERC20(token_).balanceOf(address(this));
        launchSupply = supply;
        launchedAt = block.timestamp;
        emit Initialized(token_);
    }

    function exemptFromSnipeTax(address account) external onlyFactory {
        snipeTaxExempt[account] = true;
        emit SnipeTaxExempted(account);
    }

    function setCreatorFeeRecipient(address newRecipient) external onlyFactory {
        if (newRecipient == address(0)) revert ZeroAddress();
        emit CreatorFeeRecipientUpdated(deployer, newRecipient);
        deployer = newRecipient;
    }

    function setBuybackEnabled(bool enabled) external onlyFactory {
        buybackEnabled = enabled;
        emit BuybackEnabledUpdated(enabled);
    }

    function graduate(address recipient) external onlyFactory returns (uint256 quoteOut, uint256 tokenOut) {
        if (graduated) revert AlreadyGraduated();
        if (recipient == address(0)) revert ZeroAddress();
        if (!readyToGraduate()) revert NotReadyToGraduate();
        graduated = true;
        _sweepFees(0, false);
        quoteOut = trackedQuote;
        trackedQuote = 0;
        tokenOut = trackedTokens;
        trackedTokens = 0;
        if (quoteOut != 0) _sendQuote(recipient, quoteOut);
        if (tokenOut != 0) IERC20(token).safeTransfer(recipient, tokenOut);
        emit CurveCompleted(recipient, quoteOut, tokenOut);
    }

    // ------------------------------------------------------------------ views

    function isNativeQuote() external pure returns (bool) {
        return true;
    }

    function getReserves() public view returns (uint256 quoteReserve_, uint256 tokenReserve_) {
        quoteReserve_ = phantomQuote + trackedQuote - quoteFeeBalance - creatorTaxBalance;
        tokenReserve_ = trackedTokens;
    }

    function quoteReserve() external view returns (uint256 quoteReserve_) {
        (quoteReserve_,) = getReserves();
    }

    function tokenReserve() external view returns (uint256) {
        return trackedTokens;
    }

    function realQuoteReserve() public view returns (uint256) {
        return trackedQuote - quoteFeeBalance - creatorTaxBalance;
    }

    function sellableTokens() public view returns (uint256) {
        uint256 tracked = trackedTokens;
        return tracked > reservedTokens ? tracked - reservedTokens : 0;
    }

    function readyToGraduate() public view returns (bool) {
        if (graduated) return false;
        return sellableTokens() == 0;
    }

    /// @notice Snipe tax a buy for `recipient` pays right now, in bps of its quote leg.
    function currentSnipeTaxBps(address recipient) public view returns (uint256) {
        if (snipeTaxExempt[recipient] || snipeTaxStartBps == 0 || launchedAt == 0) return 0;
        uint256 elapsed = block.timestamp - launchedAt;
        if (elapsed >= snipeTaxSeconds) return 0;
        uint256 bps = snipeTaxStartBps * (snipeTaxSeconds - elapsed) / snipeTaxSeconds;
        uint256 room = BPS - feeBps - creatorTaxBps - 1; // a taxed buy always nets the buyer something
        return bps > room ? room : bps;
    }

    /// @notice Test helper: the exact outcome of `buy(quoteIn, 0, recipient)` right now (reverts like `buy`).
    function quoteBuy(uint256 quoteIn, address recipient) public view returns (BuyQuote memory q) {
        if (graduated) revert CurveGraduated();
        if (quoteIn == 0) revert ZeroAmount();
        (uint256 quoteReserveBefore, uint256 tokenReserveBefore) = getReserves();
        uint256 snipeBps = currentSnipeTaxBps(recipient);
        q.spent = quoteIn;
        q.fee = q.spent * feeBps / BPS;
        q.tax = q.spent * creatorTaxBps / BPS;
        q.snipeTax = q.spent * snipeBps / BPS;
        q.tokensOut = _getAmountOut(q.spent - q.fee - q.tax - q.snipeTax, quoteReserveBefore, tokenReserveBefore);
        uint256 sellable = sellableTokens();
        if (sellable == 0) revert CurveGraduated();
        if (q.tokensOut > sellable) {
            q.tokensOut = sellable;
            uint256 net = _getAmountIn(sellable, quoteReserveBefore, tokenReserveBefore);
            q.spent =
                Math.min(Math.mulDiv(net, BPS, BPS - feeBps - creatorTaxBps - snipeBps, Math.Rounding.Ceil), quoteIn);
            q.fee = q.spent * feeBps / BPS;
            q.tax = q.spent * creatorTaxBps / BPS;
            q.snipeTax = q.spent * snipeBps / BPS;
        }
    }

    // ------------------------------------------------------------------ trading

    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient)
        external
        payable
        nonReentrant
        onlyInitialized
        returns (uint256 tokensOut)
    {
        if (graduated) revert CurveGraduated();
        if (recipient == address(0)) revert ZeroAddress();
        if (msg.value != quoteIn) revert NativeValueMismatch(msg.value, quoteIn);
        BuyQuote memory q = quoteBuy(quoteIn, recipient);
        tokensOut = q.tokensOut;
        if (q.spent * minTokensOut > quoteIn * tokensOut) revert SlippageExceeded(tokensOut, minTokensOut);

        _accrueFees(q.fee + q.snipeTax, q.tax);
        trackedQuote += q.spent;
        trackedTokens -= tokensOut;
        IERC20(token).safeTransfer(recipient, tokensOut);
        if (q.snipeTax != 0) emit SnipeTaxCharged(recipient, q.snipeTax);

        uint256 refund = quoteIn - q.spent;
        if (refund != 0) {
            emit CurveBuyRefunded(msg.sender, refund);
            _sendQuote(msg.sender, refund);
        }
        emit CurveBuy(msg.sender, recipient, q.spent, tokensOut, q.fee, q.tax);
        _tryAutoGraduate();
    }

    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient)
        external
        nonReentrant
        onlyInitialized
        returns (uint256 quoteOut)
    {
        if (graduated || readyToGraduate()) revert CurveGraduated();
        if (tokensIn == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        (uint256 quoteReserveBefore, uint256 tokenReserveBefore) = getReserves();
        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);

        uint256 grossQuoteOut = _getAmountOut(tokensIn, tokenReserveBefore, quoteReserveBefore);
        uint256 fee = grossQuoteOut * feeBps / BPS;
        uint256 tax = grossQuoteOut * creatorTaxBps / BPS;
        quoteOut = grossQuoteOut - fee - tax;
        if (quoteOut < minQuoteOut) revert SlippageExceeded(quoteOut, minQuoteOut);

        _accrueFees(fee, tax);
        trackedQuote -= quoteOut;
        trackedTokens += tokensIn;
        _sendQuote(recipient, quoteOut);
        emit CurveSell(msg.sender, recipient, tokensIn, quoteOut, fee, tax);
    }

    function sweepFees(uint256 minBuybackTokensOut) external nonReentrant {
        if (graduated) revert AlreadyGraduated();
        bool isOperator = msg.sender == feePolicy.feeSweepOperator();
        if (!isOperator && msg.sender != deployer) revert NotFeeSweepOperator();
        if (!isOperator && buybackQuoteBalance != 0) revert InternalSwapRequiresOperator();
        _sweepFees(minBuybackTokensOut, true);
    }

    // ------------------------------------------------------------------ internals

    function _tryAutoGraduate() private {
        if (readyToGraduate()) {
            try IMockPonsGraduation(factory).graduate(token) {}
            catch {
                emit AutoGraduationFailed(token, gasleft());
            }
        }
    }

    function _accrueFees(uint256 fee, uint256 tax) private {
        quoteFeeBalance += fee;
        creatorTaxBalance += tax;
        if (buybackEnabled && fee != 0) {
            uint256 creatorSlice = fee - fee * protocolFeeShareBps / BPS;
            buybackQuoteBalance += creatorSlice * buybackBurnBps / BPS;
        }
    }

    function _sweepFees(uint256 minBuybackTokensOut, bool executeBuyback) private {
        uint256 pending = quoteFeeBalance;
        uint256 tax = creatorTaxBalance;
        if (pending == 0 && tax == 0) return;

        uint256 protocolAmount = pending * protocolFeeShareBps / BPS;
        uint256 creatorBucket = pending - protocolAmount;
        uint256 buybackAmount = executeBuyback ? Math.min(buybackQuoteBalance, creatorBucket) : 0;
        uint256 creatorAmount = creatorBucket - buybackAmount + tax;
        if (buybackAmount != 0) {
            if (minBuybackTokensOut == 0) revert MinimumOutputRequired();
            // Model: the buyback is never executed, it folds back into the creator payout.
            creatorAmount += buybackAmount;
            buybackAmount = 0;
        }

        quoteFeeBalance = 0;
        buybackQuoteBalance = 0;
        creatorTaxBalance = 0;
        trackedQuote -= protocolAmount + creatorAmount;
        if (protocolAmount != 0) feeEscrow.credit{value: protocolAmount}(protocolFeeRecipient);
        if (creatorAmount != 0) feeEscrow.credit{value: creatorAmount}(deployer);
        emit FeesSwept(protocolAmount, buybackAmount, creatorAmount);
    }

    function _sendQuote(address recipient, uint256 amount) private {
        (bool sent,) = payable(recipient).call{value: amount}("");
        if (!sent) revert TransferFailed();
    }

    /// @dev `PonsV2BondingCurveMath.getAmountOut` with a zero fee.
    function _getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        private
        pure
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert InsufficientInputAmount();
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();
        uint256 amountInWithFee = amountIn * BPS;
        amountOut = amountInWithFee * reserveOut / (reserveIn * BPS + amountInWithFee);
        if (amountOut == 0) revert InsufficientOutputAmount();
    }

    /// @dev `PonsV2BondingCurveMath.getAmountIn` with a zero fee.
    function _getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut)
        private
        pure
        returns (uint256 amountIn)
    {
        if (amountOut == 0) revert InsufficientOutputAmount();
        if (reserveIn == 0 || reserveOut <= amountOut) revert InsufficientLiquidity();
        amountIn = amountOut * reserveIn * BPS / ((reserveOut - amountOut) * BPS) + 1;
    }
}
