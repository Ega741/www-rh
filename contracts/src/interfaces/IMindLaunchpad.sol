// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IMindLaunchpad
/// @notice External interface of {MindLaunchpad}: token factory + bonding curve + fee router + mind vault +
///         mind registry of "worldwideweb on Robinhood Chain". Types, events and errors are declared here so
///         the implementation, scripts, tests and off-chain ABIs share a single definition (SPEC §2.3).
interface IMindLaunchpad {
    // ---------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------

    /// @notice Lifecycle of a coin's bonding curve.
    enum CurvePhase {
        Bonding,
        Complete,
        Graduated
    }

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

    /// @notice Bonding-curve state of a coin.
    struct CurveState {
        uint128 realEthReserve;
        uint128 tokensSold;
        CurvePhase phase;
        address pool; // after graduation
        uint256 positionId; // after graduation (0 for MockGraduator)
    }

    /// @notice Protocol fee parameters, all in basis points.
    struct FeeParams {
        uint16 tradeFeeBps;
        uint16 mindShareBps;
        uint16 graduationFeeBps;
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
    /// @notice A curve trade. `ethAmount` = ETH used (buy, after refund) or ETH paid out (sell);
    ///         `fee` = total fee; `realEthReserve`/`tokensSold` = curve state after the trade.
    event Trade(
        address indexed token,
        address indexed trader,
        bool isBuy,
        uint256 ethAmount,
        uint256 tokenAmount,
        uint256 fee,
        uint256 realEthReserve,
        uint256 tokensSold
    );
    /// @notice The curve sold out (`tokensSold == CURVE_SUPPLY`); the coin can now be graduated.
    event CurveCompleted(address indexed token, uint256 realEthReserve);
    /// @notice A `Complete` curve that was not graduated within `graduationGrace()` was reopened by a sell: the
    ///         phase is `Bonding` again (emitted before that sell's `FeeAccrued`/`Trade`).
    event CurveReopened(address indexed token);
    /// @notice The coin's liquidity was moved to the DEX through `graduatorOf(token)`.
    event Graduated(
        address indexed token,
        address pool,
        uint256 positionId,
        uint256 ethLiquidity,
        uint256 tokenLiquidity,
        uint256 graduationFee
    );
    /// @notice ETH was added to a mind vault by {fundMind} (`from` = sender) or returned by a graduator during
    ///         {graduate}/{harvest} (`from` = graduator). Fee shares emit {FeeAccrued} instead.
    event MindFunded(address indexed token, address indexed from, uint256 amount);
    /// @notice A fee (trade, creation or graduation) was split between the mind vault and the protocol.
    event FeeAccrued(address indexed token, uint256 mindAmount, uint256 protocolAmount);
    /// @notice The operator paid `amount` of compute from the mind vault to `computeTreasury()`.
    event ComputeDrawn(address indexed token, uint256 amount, bytes32 receiptHash);
    /// @notice A batch of memories was anchored (event only).
    event MemoryAnchored(address indexed token, uint64 indexed seq, bytes32 contentHash, string uri);
    /// @notice The creator updated the mind configuration.
    event MindConfigUpdated(address indexed token, bytes32 modelId, bytes32 personaHash, string metadataURI);
    /// @notice The mind status changed (operator Alive/Dormant toggle or creator pause/unpause).
    event MindStatusChanged(address indexed token, MindStatus status);
    /// @notice DEX fees were harvested: `ethOut` credited to the mind vault, `tokensBurned` sent to 0xdEaD.
    event Harvested(address indexed token, uint256 ethOut, uint256 tokensBurned);
    /// @notice The protocol balance was withdrawn.
    event ProtocolFeesWithdrawn(address indexed to, uint256 amount);
    /// @notice The operator (runner hot wallet) changed.
    event OperatorUpdated(address newOperator);
    /// @notice The protocol treasury changed.
    event TreasuryUpdated(address newTreasury);
    /// @notice The compute treasury (recipient of {drawCompute}) changed.
    event ComputeTreasuryUpdated(address newComputeTreasury);
    /// @notice The graduator used for future graduations changed.
    event GraduatorUpdated(address newGraduator);
    /// @notice Fee parameters changed.
    event FeeParamsUpdated(uint16 tradeFeeBps, uint16 mindShareBps, uint16 graduationFeeBps);
    /// @notice The creation fee changed.
    event CreationFeeUpdated(uint256 newCreationFee);
    /// @notice The per-mind compute draw cap changed.
    event DrawLimitUpdated(uint256 maxPerEpoch, uint32 epochSeconds);
    /// @notice The graduation grace period (after which a `Complete` curve accepts sells again) changed.
    event GraduationGraceUpdated(uint32 graceSeconds);

    // ---------------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------------

    /// @notice `token` was not created by this launchpad.
    error NotAMind();
    /// @notice The curve is not in the phase required by the call.
    error WrongPhase();
    /// @notice Output below the caller's minimum.
    error Slippage();
    /// @notice `block.timestamp > deadline`.
    error Expired();
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
    /// @notice `setGraduationGrace` outside [1 hour, 30 days].
    error InvalidGraduationGrace();
    /// @notice `setGraduator` with a non-zero address that has no code or whose `launchpad()` is not this
    ///         launchpad.
    error InvalidGraduator();
    /// @notice `renounceOwnership` is disabled: the launchpad always keeps an owner.
    error RenounceDisabled();
    /// @notice Bubbled up from `UniswapV3Graduator.graduate` (declared here so clients can decode `graduate`
    ///         reverts): the DEX pool's price could not be brought within the graduator's tolerance of the price
    ///         implied by the graduation amounts. The coin stays `Complete`; anyone may retry later.
    error PoolPriceSkewed(uint160 expectedSqrtPriceX96, uint160 actualSqrtPriceX96);
    /// @notice The draw exceeds the mind vault balance.
    error InsufficientMindBalance();
    /// @notice A fee parameter exceeds its bound.
    error FeeTooHigh();
    /// @notice `msg.value < creationFee()`.
    error InsufficientCreationFee();
    /// @notice A required address is zero.
    error ZeroAddress();
    /// @notice An ETH transfer with `call` failed.
    error EthTransferFailed();
    /// @notice Plain ETH is only accepted from the graduator currently being called by `graduate`/`harvest`.
    error DirectEthNotAccepted();
    /// @notice No graduator is configured.
    error GraduatorNotSet();
    /// @notice The graduator's reported ETH return does not match the ETH it sent to `receive()` during the call.
    error EthReturnMismatch();
    /// @notice Token name must be 1..64 bytes.
    error InvalidName();
    /// @notice Token symbol must be 1..16 bytes.
    error InvalidSymbol();
    /// @notice Metadata URI must be at most 2048 bytes.
    error MetadataTooLong();
    /// @notice Model id must be non-zero.
    error InvalidModel();
    /// @notice `sell`/`quoteSell` with more tokens than the curve has sold.
    error ExceedsTokensSold();

    // ---------------------------------------------------------------------------------------------
    // User
    // ---------------------------------------------------------------------------------------------

    /// @notice Creates a new coin + mind. `msg.value >= creationFee()`; the remainder
    ///         (`msg.value - creationFee`) is an initial buy for `msg.sender` (skipped when 0).
    /// @param name         ERC20 name (1..64 bytes).
    /// @param symbol       ERC20 symbol (1..16 bytes).
    /// @param metadataURI  URI of the metadata JSON (at most 2048 bytes).
    /// @param modelId      keccak256 of the model id string (non-zero).
    /// @param personaHash  keccak256 of the persona prompt text.
    /// @param minTokensOut Slippage bound for the initial buy (ignored when there is none).
    /// @return token       Address of the new {MindToken}.
    function createMind(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        bytes32 modelId,
        bytes32 personaHash,
        uint256 minTokensOut
    ) external payable returns (address token);

    /// @notice Buys `token` on its bonding curve with `msg.value`. ETH not needed by the completing buy is
    ///         refunded.
    /// @param token        The coin.
    /// @param minTokensOut Minimum tokens to receive, else `Slippage()`.
    /// @param deadline     Unix timestamp after which the call reverts with `Expired()`.
    /// @return tokensOut   Tokens received.
    function buy(address token, uint256 minTokensOut, uint256 deadline) external payable returns (uint256 tokensOut);

    /// @notice Sells `tokensIn` of `token` on its bonding curve. Tokens are pulled with `transferFrom`
    ///         (approve the launchpad first); ETH is sent with `call{value}`. Allowed while `Bonding`, and while
    ///         `Complete` once `block.timestamp >= completedAt(token) + graduationGrace()` (escape hatch for a
    ///         coin that could not be graduated): such a sell first reopens the curve (phase `Bonding`,
    ///         `CurveReopened`).
    /// @param token     The coin.
    /// @param tokensIn  Tokens to sell.
    /// @param minEthOut Minimum ETH to receive, else `Slippage()`.
    /// @param deadline  Unix timestamp after which the call reverts with `Expired()`.
    /// @return ethOut   ETH received (net of fee).
    function sell(address token, uint256 tokensIn, uint256 minEthOut, uint256 deadline)
        external
        returns (uint256 ethOut);

    /// @notice Permissionless. Moves a `Complete` curve to the DEX through the current graduator, which is
    ///         recorded as `graduatorOf(token)`. ETH returned by the graduator is credited to the mind vault.
    /// @param token The coin.
    function graduate(address token) external;

    /// @notice Permissionless. Collects DEX fees of a `Graduated` coin through `graduatorOf(token)`; the ETH
    ///         side is credited to the mind vault, the token side is burned by the graduator.
    /// @param token The coin.
    function harvest(address token) external;

    /// @notice Anyone can feed a mind: adds `msg.value` to `mindBalance(token)`. `nonReentrant`.
    /// @param token The coin.
    function fundMind(address token) external payable;

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice Quotes a buy of `ethIn` wei on `token`'s curve (SPEC §1). Reverts `WrongPhase()` unless Bonding and
    ///         `ZeroAmount()` for `ethIn == 0`.
    /// @return tokensOut Tokens out (capped at the remaining curve supply).
    /// @return ethUsed   ETH consumed including the fee; `ethIn - ethUsed` would be refunded.
    /// @return fee       Total fee included in `ethUsed`.
    function quoteBuy(address token, uint256 ethIn)
        external
        view
        returns (uint256 tokensOut, uint256 ethUsed, uint256 fee);

    /// @notice Quotes a sell of `tokensIn` on `token`'s curve (SPEC §1). Reverts `WrongPhase()` unless Bonding or
    ///         Complete past the graduation grace (same rule as {sell}), `ZeroAmount()` for `tokensIn == 0` and
    ///         `ExceedsTokensSold()` above `tokensSold`.
    /// @return ethOut ETH out, net of fee.
    /// @return fee    Fee taken.
    function quoteSell(address token, uint256 tokensIn) external view returns (uint256 ethOut, uint256 fee);

    /// @notice Current curve price in wei per 1e18 tokens (`x * 1e18 / y`). Reverts `WrongPhase()` once Graduated.
    function currentPrice(address token) external view returns (uint256 weiPer1e18Tokens);

    /// @notice Mind information of `token` (zero struct when not a mind).
    function getMind(address token) external view returns (MindInfo memory);

    /// @notice Curve state of `token` (zero struct when not a mind).
    function getCurve(address token) external view returns (CurveState memory);

    /// @notice ETH held in `token`'s mind vault (only spendable through {drawCompute}).
    function mindBalance(address token) external view returns (uint256);

    /// @notice Accrued protocol fees, withdrawable with {withdrawProtocolFees}.
    function protocolBalance() external view returns (uint256);

    /// @notice Number of minds created.
    function mindsLength() external view returns (uint256);

    /// @notice The `index`-th created mind (token address).
    function mindAt(uint256 index) external view returns (address);

    /// @notice Whether `token` was created by this launchpad.
    function isMind(address token) external view returns (bool);

    /// @notice Current fee parameters.
    function feeParams() external view returns (FeeParams memory);

    /// @notice Flat ETH fee charged by {createMind}.
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

    /// @notice Graduator used for future graduations (`address(0)` = graduation disabled).
    function graduator() external view returns (address);

    /// @notice Graduator that holds `token`'s DEX liquidity (`address(0)` until graduated).
    function graduatorOf(address token) external view returns (address);

    /// @notice `block.timestamp` at which `token`'s curve last completed (0 while it never completed or after a
    ///         post-grace sell reopened it; kept after graduation).
    function completedAt(address token) external view returns (uint64);

    /// @notice Seconds after completion during which a `Complete` curve only waits for `graduate`; afterwards
    ///         sells are allowed again (they reopen the curve).
    function graduationGrace() external view returns (uint32);

    // solhint-disable func-name-mixedcase
    /// @notice Virtual ETH reserve (x0).
    function VIRTUAL_ETH() external view returns (uint256);
    /// @notice Virtual token reserve (y0).
    function VIRTUAL_TOKENS() external view returns (uint256);
    /// @notice Tokens sold on the curve.
    function CURVE_SUPPLY() external view returns (uint256);
    /// @notice Tokens sent to the DEX at graduation.
    function LP_SUPPLY() external view returns (uint256);
    /// @notice Total supply of every coin.
    function TOTAL_SUPPLY() external view returns (uint256);
    // solhint-enable func-name-mixedcase

    // ---------------------------------------------------------------------------------------------
    // Creator
    // ---------------------------------------------------------------------------------------------

    /// @notice Creator-only: updates model / persona / metadata of a mind (same validation as {createMind}).
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
    /// @notice Sets the graduator for future graduations; `address(0)` disables graduation. A non-zero graduator
    ///         must be a contract whose `launchpad()` is this launchpad, else `InvalidGraduator()`.
    function setGraduator(address newGraduator) external;
    /// @notice Bounds: trade <= 500, mindShare <= 10000, graduation <= 1000 (bps).
    function setFeeParams(FeeParams calldata params) external;
    /// @notice Sets the flat creation fee.
    function setCreationFee(uint256 newCreationFee) external;
    /// @notice Sets the per-mind compute draw cap (`epochSeconds >= 3600`, `maxPerEpoch <= MAX_DRAW_PER_EPOCH`
    ///         = 2 ether; `maxPerEpoch = 0` blocks draws). Fixed epochs allow a burst of `2 * maxPerEpoch` around
    ///         an epoch boundary.
    function setDrawLimit(uint256 maxPerEpoch, uint32 epochSeconds) external;
    /// @notice Sets the graduation grace period, within [1 hour, 30 days]. Applies to every `Complete` curve,
    ///         including those already waiting.
    function setGraduationGrace(uint32 graceSeconds) external;
    /// @notice Pauses {createMind} and {buy} only; sell/graduate/harvest/fund/draw stay enabled.
    function pause() external;
    /// @notice Lifts {pause}.
    function unpause() external;
    /// @notice Owner or treasury: sends the whole `protocolBalance()` to `to`.
    function withdrawProtocolFees(address to) external;
}
