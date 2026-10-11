// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CreditMath} from "./CreditMath.sol";
import {IPriceSource} from "./interfaces/IPriceSource.sol";

/// @title CreditDesk
/// @notice Burn becomes compute: callers burn the credit token and the desk emits the USD value of the burn,
///         quoted from an on-chain {IPriceSource}. The gateway indexes `CreditPurchased` / `BudgetDrawn` and
///         credits each workspace exactly the emitted `usdMicro`. Budgets let a wallet pre-authorise a capped,
///         time-boxed amount that the operator draws from as usage accrues.
/// @dev Owner: parameters and pause. Operator: draws from budgets. The desk never holds tokens between calls.
contract CreditDesk is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Immutables / constants ────────────────────────────────────────────────────────────────────────

    /// @notice The credit token that is burned.
    IERC20 public immutable token;
    /// @notice `token.decimals()`, read once at construction (≤ 36).
    uint8 public immutable tokenDecimals;
    /// @notice `true`: burn through `ERC20Burnable.burn`; `false`: transfer to {DEAD}.
    bool public immutable nativeBurn;

    /// @notice Sink address used when `nativeBurn` is false.
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    /// @notice Longest allowed budget lifetime.
    uint64 public constant MAX_BUDGET_DURATION = 30 days;

    // ─── Storage ──────────────────────────────────────────────────────────────────────────────────────

    /// @notice USD price oracle; zero → quotes revert `PriceUnavailable`.
    IPriceSource public priceSource;
    /// @notice Maximum age of a price observation accepted by {quote}, in seconds (default 3600).
    uint32 public maxPriceAge;
    /// @notice Minimum raw token amount for {burnForCredit} (default 0).
    uint256 public minBurn;
    /// @notice Gateway hot wallet allowed to {draw} from budgets.
    address public operator;
    /// @notice Next receipt id (shared by purchases and draws); starts at 1.
    uint256 public nextReceiptId;
    /// @notice Next budget id; starts at 1.
    uint256 public nextBudgetId;
    /// @notice Σ raw token units burned through the desk.
    uint256 public totalBurned;
    /// @notice Σ µUSD credited through the desk.
    uint256 public totalUsdMicro;

    struct Budget {
        address owner;
        address workspace;
        uint128 cap;
        uint128 drawn;
        uint64 deadline;
        bool closed;
    }

    /// @notice Budgets by id.
    mapping(uint256 budgetId => Budget) public budgets;

    // ─── Events ───────────────────────────────────────────────────────────────────────────────────────

    event CreditPurchased(
        uint256 indexed receiptId,
        address indexed workspace,
        address indexed payer,
        uint256 tokenAmount,
        uint256 usdMicro,
        uint256 priceE18
    );
    event BudgetOpened(
        uint256 indexed budgetId, address indexed owner, address indexed workspace, uint128 cap, uint64 deadline
    );
    event BudgetDrawn(
        uint256 indexed budgetId,
        uint256 indexed receiptId,
        address indexed workspace,
        uint256 tokenAmount,
        uint256 usdMicro,
        uint256 priceE18,
        bytes32 receiptHash
    );
    event BudgetClosed(uint256 indexed budgetId, uint128 drawn);
    event PriceSourceSet(address priceSource);
    event MaxPriceAgeSet(uint32 maxPriceAge);
    event MinBurnSet(uint256 minBurn);
    event OperatorSet(address operator);

    // ─── Errors ───────────────────────────────────────────────────────────────────────────────────────

    error ZeroAddress();
    error BadDecimals();
    error BurnTooSmall(uint256 amount, uint256 minBurn);
    error QuoteTooSmall();
    error PriceUnavailable();
    error PriceStale(uint256 updatedAt, uint32 maxAge);
    error NotOperator();
    error BadBudgetParams();
    error UnknownBudget();
    error BudgetIsClosed();
    error BudgetExpired();
    error BudgetExceeded(uint256 remaining);
    error NotBudgetOwner();
    error BadMaxPriceAge();
    error SlippageExceeded(uint256 usdMicro, uint256 minUsdMicro);
    error RenounceDisabled();

    // ─── Construction ─────────────────────────────────────────────────────────────────────────────────

    /// @param token_ Credit token (non-zero, `decimals() <= 36`).
    /// @param nativeBurn_ Burn via `ERC20Burnable.burn` (true) or transfer to {DEAD} (false).
    /// @param priceSource_ Initial price source; may be zero and set later.
    /// @param owner_ Initial owner (non-zero).
    /// @param operator_ Initial operator; may be zero and set later.
    constructor(IERC20 token_, bool nativeBurn_, IPriceSource priceSource_, address owner_, address operator_)
        Ownable(_nonZero(owner_))
    {
        if (address(token_) == address(0)) revert ZeroAddress();
        uint8 decimals_ = IERC20Metadata(address(token_)).decimals();
        if (decimals_ > 36) revert BadDecimals();
        token = token_;
        tokenDecimals = decimals_;
        nativeBurn = nativeBurn_;
        priceSource = priceSource_;
        operator = operator_;
        maxPriceAge = 3600;
        nextReceiptId = 1;
        nextBudgetId = 1;
        emit PriceSourceSet(address(priceSource_));
        emit OperatorSet(operator_);
        emit MaxPriceAgeSet(3600);
    }

    // ─── Pricing ──────────────────────────────────────────────────────────────────────────────────────

    /// @notice Quote a raw token amount in µUSD at the current, fresh price.
    /// @dev Reverts `PriceUnavailable` when no source is set or it reports 0, and `PriceStale` when the
    ///      observation is more than {maxPriceAge} seconds away from `block.timestamp` (in either direction:
    ///      a far-future-dated observation is rejected too, without underflow).
    /// @param amount Raw token units.
    /// @return usdMicro `floor(amount * priceE18 / 10**(tokenDecimals + 12))`.
    /// @return priceE18 Price used, USD per whole token scaled by 1e18.
    /// @return updatedAt Timestamp of the price observation.
    function quote(uint256 amount) public view returns (uint256 usdMicro, uint256 priceE18, uint256 updatedAt) {
        (priceE18, updatedAt) = _price();
        usdMicro = CreditMath.usdMicro(amount, priceE18, tokenDecimals);
    }

    // ─── Credit purchase ──────────────────────────────────────────────────────────────────────────────

    /// @notice Burn `amount` tokens from the caller and credit `workspace` with their USD value.
    /// @dev Requires a prior `approve` of the desk. Emits `CreditPurchased`.
    /// @param workspace Workspace (wallet) to credit; non-zero.
    /// @param amount Raw token units; `> 0` and `>= minBurn`.
    /// @return receiptId Strictly increasing receipt id shared with budget draws.
    function burnForCredit(address workspace, uint256 amount)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 receiptId)
    {
        return _purchase(workspace, amount, 0);
    }

    /// @notice {burnForCredit} with a credit floor: reverts `SlippageExceeded` when the quote at inclusion
    ///         time is below `minUsdMicro` (a price post landing between the UI quote and the transaction
    ///         would otherwise silently credit less; the burn is final once it succeeds).
    /// @dev A distinct name rather than an overload keeps every ABI consumer unambiguous.
    /// @param workspace Workspace (wallet) to credit; non-zero.
    /// @param amount Raw token units; `> 0` and `>= minBurn`.
    /// @param minUsdMicro Minimum µUSD the burn must credit; `0` disables the floor.
    /// @return receiptId Strictly increasing receipt id shared with budget draws.
    function burnForCreditMin(address workspace, uint256 amount, uint256 minUsdMicro)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 receiptId)
    {
        return _purchase(workspace, amount, minUsdMicro);
    }

    /// @notice Same as {burnForCredit} but first applies an EIP-2612 permit for the caller.
    /// @dev The permit is applied best-effort (`try/catch`): a front-run or already-consumed permit does not
    ///      block the purchase as long as the allowance exists.
    /// @param workspace Workspace (wallet) to credit; non-zero.
    /// @param amount Raw token units; `> 0` and `>= minBurn`; also the permit value.
    /// @param deadline Permit deadline.
    /// @param v Signature v.
    /// @param r Signature r.
    /// @param s Signature s.
    /// @return receiptId Strictly increasing receipt id shared with budget draws.
    function burnForCreditWithPermit(address workspace, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 receiptId)
    {
        try IERC20Permit(address(token)).permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        return _purchase(workspace, amount, 0);
    }

    /// @notice {burnForCreditWithPermit} with a credit floor (see {burnForCreditMin}).
    /// @param workspace Workspace (wallet) to credit; non-zero.
    /// @param amount Raw token units; `> 0` and `>= minBurn`; also the permit value.
    /// @param minUsdMicro Minimum µUSD the burn must credit; `0` disables the floor.
    /// @param deadline Permit deadline.
    /// @param v Signature v.
    /// @param r Signature r.
    /// @param s Signature s.
    /// @return receiptId Strictly increasing receipt id shared with budget draws.
    function burnForCreditWithPermitMin(
        address workspace,
        uint256 amount,
        uint256 minUsdMicro,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external whenNotPaused nonReentrant returns (uint256 receiptId) {
        try IERC20Permit(address(token)).permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        return _purchase(workspace, amount, minUsdMicro);
    }

    // ─── Budgets ──────────────────────────────────────────────────────────────────────────────────────

    /// @notice Authorise a budget: the operator may draw up to `cap` tokens from the caller until `deadline`.
    /// @dev The caller separately `approve`s the desk. Emits `BudgetOpened`.
    /// @param workspace Workspace credited by draws; non-zero.
    /// @param cap Maximum raw token units drawable; `> 0`.
    /// @param deadline Unix time; `block.timestamp < deadline <= block.timestamp + MAX_BUDGET_DURATION`.
    /// @return budgetId Strictly increasing budget id.
    function openBudget(address workspace, uint128 cap, uint64 deadline)
        external
        whenNotPaused
        returns (uint256 budgetId)
    {
        if (workspace == address(0)) revert ZeroAddress();
        if (cap == 0 || deadline <= block.timestamp || deadline > block.timestamp + MAX_BUDGET_DURATION) {
            revert BadBudgetParams();
        }
        budgetId = nextBudgetId++;
        budgets[budgetId] =
            Budget({owner: msg.sender, workspace: workspace, cap: cap, drawn: 0, deadline: deadline, closed: false});
        emit BudgetOpened(budgetId, msg.sender, workspace, cap, deadline);
    }

    /// @notice Operator draws `amount` from a budget, burning it and crediting the budget's workspace.
    /// @dev Emits `BudgetDrawn` with the gateway's `receiptHash` of the usage being settled.
    /// @param budgetId Budget to draw from.
    /// @param amount Raw token units; `> 0`, `drawn + amount <= cap`.
    /// @param receiptHash Hash of the usage receipt settled by this draw (opaque to the contract).
    /// @return receiptId Strictly increasing receipt id shared with purchases.
    function draw(uint256 budgetId, uint256 amount, bytes32 receiptHash)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 receiptId)
    {
        if (msg.sender != operator) revert NotOperator();
        Budget storage b = budgets[budgetId];
        if (b.owner == address(0)) revert UnknownBudget();
        if (b.closed) revert BudgetIsClosed();
        if (block.timestamp > b.deadline) revert BudgetExpired();
        if (amount == 0) revert BurnTooSmall(amount, minBurn);
        uint256 remaining = b.cap - b.drawn;
        if (amount > remaining) revert BudgetExceeded(remaining);
        (uint256 usdMicro, uint256 priceE18,) = quote(amount);
        if (usdMicro == 0) revert QuoteTooSmall();

        // Effects. Casting is safe: amount <= remaining <= cap <= type(uint128).max.
        // forge-lint: disable-next-line(unsafe-typecast)
        b.drawn += uint128(amount);
        receiptId = nextReceiptId++;
        totalBurned += amount;
        totalUsdMicro += usdMicro;

        // Interactions.
        token.safeTransferFrom(b.owner, address(this), amount);
        _burn(amount);
        emit BudgetDrawn(budgetId, receiptId, b.workspace, amount, usdMicro, priceE18, receiptHash);
    }

    /// @notice Close a budget so nothing more can be drawn. Works while paused.
    /// @dev Allowed for the budget owner, the operator, or anyone once the deadline has passed.
    /// @param budgetId Budget to close; must exist and not be closed already.
    function closeBudget(uint256 budgetId) external {
        Budget storage b = budgets[budgetId];
        if (b.owner == address(0)) revert UnknownBudget();
        if (b.closed) revert BudgetIsClosed();
        if (msg.sender != b.owner && msg.sender != operator && block.timestamp <= b.deadline) {
            revert NotBudgetOwner();
        }
        b.closed = true;
        emit BudgetClosed(budgetId, b.drawn);
    }

    /// @notice Tokens the operator can still draw right now: `min(cap − drawn, allowance, balance)` of the owner.
    /// @param budgetId Budget to inspect.
    /// @return remaining `0` for unknown, closed or expired budgets.
    function budgetRemaining(uint256 budgetId) external view returns (uint256 remaining) {
        Budget storage b = budgets[budgetId];
        if (b.owner == address(0) || b.closed || block.timestamp > b.deadline) return 0;
        remaining = b.cap - b.drawn;
        remaining = Math.min(remaining, token.allowance(b.owner, address(this)));
        remaining = Math.min(remaining, token.balanceOf(b.owner));
    }

    // ─── Admin ────────────────────────────────────────────────────────────────────────────────────────

    /// @notice Replace the price source. Zero disables quoting. Only the owner.
    /// @param newSource New {IPriceSource}.
    function setPriceSource(IPriceSource newSource) external onlyOwner {
        priceSource = newSource;
        emit PriceSourceSet(address(newSource));
    }

    /// @notice Set the maximum accepted price age in seconds. Only the owner.
    /// @param newMaxAge Seconds; `> 0`.
    function setMaxPriceAge(uint32 newMaxAge) external onlyOwner {
        if (newMaxAge == 0) revert BadMaxPriceAge();
        maxPriceAge = newMaxAge;
        emit MaxPriceAgeSet(newMaxAge);
    }

    /// @notice Set the minimum purchase amount in raw token units. Only the owner.
    /// @param newMinBurn Raw token units.
    function setMinBurn(uint256 newMinBurn) external onlyOwner {
        minBurn = newMinBurn;
        emit MinBurnSet(newMinBurn);
    }

    /// @notice Replace the operator. Zero disables draws. Only the owner.
    /// @param newOperator Gateway hot wallet.
    function setOperator(address newOperator) external onlyOwner {
        operator = newOperator;
        emit OperatorSet(newOperator);
    }

    /// @notice Pause purchases, budget opening and draws (closing stays allowed). Only the owner.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume after {pause}. Only the owner.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Recover any token sent to the desk by mistake (it never holds tokens between calls). Only the owner.
    /// @param t Token to move.
    /// @param to Recipient; non-zero.
    /// @param amount Raw token units.
    function recoverToken(IERC20 t, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        t.safeTransfer(to, amount);
    }

    /// @notice Disabled: an ownerless desk could never be paused, re-parameterised or have its operator
    ///         rotated. Ownership only moves through the two-step `transferOwnership` / `acceptOwnership`.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    // ─── Internals ────────────────────────────────────────────────────────────────────────────────────

    /// @dev Shared purchase path: checks → effects → interactions → event. `minUsdMicro == 0` disables the floor.
    function _purchase(address workspace, uint256 amount, uint256 minUsdMicro) private returns (uint256 receiptId) {
        if (workspace == address(0)) revert ZeroAddress();
        if (amount == 0 || amount < minBurn) revert BurnTooSmall(amount, minBurn);
        (uint256 usdMicro, uint256 priceE18,) = quote(amount);
        if (usdMicro == 0) revert QuoteTooSmall();
        if (usdMicro < minUsdMicro) revert SlippageExceeded(usdMicro, minUsdMicro);

        receiptId = nextReceiptId++;
        totalBurned += amount;
        totalUsdMicro += usdMicro;

        token.safeTransferFrom(msg.sender, address(this), amount);
        _burn(amount);
        emit CreditPurchased(receiptId, workspace, msg.sender, amount, usdMicro, priceE18);
    }

    /// @dev Destroys `amount` tokens held by the desk, natively or via the dead address.
    function _burn(uint256 amount) private {
        if (nativeBurn) ERC20Burnable(address(token)).burn(amount);
        else token.safeTransfer(DEAD, amount);
    }

    /// @dev Reads and validates the current price: fresh iff `|block.timestamp − updatedAt| <= maxPriceAge`.
    ///      The symmetric form never underflows and rejects a source whose clock is far ahead of the chain.
    function _price() private view returns (uint256 priceE18, uint256 updatedAt) {
        IPriceSource src = priceSource;
        if (address(src) == address(0)) revert PriceUnavailable();
        (priceE18, updatedAt) = src.latestPrice();
        if (priceE18 == 0) revert PriceUnavailable();
        uint256 age = block.timestamp >= updatedAt ? block.timestamp - updatedAt : updatedAt - block.timestamp;
        if (age > maxPriceAge) revert PriceStale(updatedAt, maxPriceAge);
    }

    /// @dev Used in the base-constructor argument so a zero owner reverts `ZeroAddress` (not OZ's error).
    function _nonZero(address a) private pure returns (address) {
        if (a == address(0)) revert ZeroAddress();
        return a;
    }
}
