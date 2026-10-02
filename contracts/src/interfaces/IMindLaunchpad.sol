// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IMindLaunchpad
/// @notice External interface of {MindLaunchpad}: factory + bonding curve + fee router + mind vault +
///         mind registry for "worldwideweb on Robinhood Chain". Structs, enums, events and errors are
///         declared here so that the implementation, scripts and tests share one definition (SPEC §2.3).
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

    /// @notice Lifecycle of a coin's mind.
    enum MindStatus {
        Alive,
        Dormant,
        Retired
    }

    /// @notice Static + creator-controlled information about a mind.
    struct MindInfo {
        address creator;
        bytes32 modelId; // keccak256(modelString), see SPEC §4 model catalog
        bytes32 personaHash; // keccak256(persona prompt text); full text lives in metadata JSON
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

    event MindCreated(
        address indexed token,
        address indexed creator,
        string name,
        string symbol,
        string metadataURI,
        bytes32 modelId,
        bytes32 personaHash
    );
    /// @dev ethAmount = ethUsed (buy) or ethOut (sell), both net of refund; fee = total fee.
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
    event CurveCompleted(address indexed token, uint256 realEthReserve);
    event Graduated(
        address indexed token,
        address pool,
        uint256 positionId,
        uint256 ethLiquidity,
        uint256 tokenLiquidity,
        uint256 graduationFee
    );
    /// @dev Emitted by fundMind and creditMind. Fee shares emit {FeeAccrued} instead.
    event MindFunded(address indexed token, address indexed from, uint256 amount);
    event FeeAccrued(address indexed token, uint256 mindAmount, uint256 protocolAmount);
    event ComputeDrawn(address indexed token, uint256 amount, address indexed to, bytes32 receiptHash);
    event MemoryAnchored(address indexed token, uint64 indexed seq, bytes32 contentHash, string uri);
    event MindConfigUpdated(address indexed token, bytes32 modelId, bytes32 personaHash, string metadataURI);
    event MindStatusChanged(address indexed token, MindStatus status);
    event Harvested(address indexed token, uint256 ethOut, uint256 tokensBurned);
    event ProtocolFeesWithdrawn(address indexed to, uint256 amount);
    event RetiredMindWithdrawn(address indexed token, address indexed to, uint256 amount);
    event OperatorUpdated(address operator);
    event TreasuryUpdated(address treasury);
    event GraduatorUpdated(address graduator);
    event FeeParamsUpdated(uint16 tradeFeeBps, uint16 mindShareBps, uint16 graduationFeeBps);
    event CreationFeeUpdated(uint256 creationFee);
    event DrawLimitUpdated(uint256 maxPerEpoch, uint32 epochSeconds);

    // ---------------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------------

    error NotAMind();
    error WrongPhase();
    error Slippage();
    error Expired();
    error ZeroAmount();
    error NotCreator();
    error NotOperator();
    error NotGraduator();
    error Retired();
    error InvalidStatus();
    error DrawLimitExceeded();
    error InsufficientMindBalance();
    error FeeTooHigh();
    error InsufficientCreationFee();
    error ZeroAddress();
    error EthTransferFailed();
    /// @dev Token name must be 1..64 bytes.
    error InvalidName();
    /// @dev Token symbol must be 1..16 bytes.
    error InvalidSymbol();
    /// @dev `sell` with more tokens than the curve has sold.
    error ExceedsTokensSold();

    // ---------------------------------------------------------------------------------------------
    // User
    // ---------------------------------------------------------------------------------------------

    /// @notice Creates a new coin + mind. `msg.value >= creationFee()`; the remainder
    ///         (`msg.value - creationFee`) is an initial buy for `msg.sender` (skipped when 0).
    /// @param name         ERC20 name (1..64 bytes).
    /// @param symbol       ERC20 symbol (1..16 bytes).
    /// @param metadataURI  URI of the metadata JSON {name, symbol, description, image, persona, model, links}.
    /// @param modelId      keccak256 of the model id string (SPEC §3 model catalog).
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

    /// @notice Buys `token` on its bonding curve with `msg.value`. Excess ETH on the completing buy is refunded.
    /// @param token        The coin.
    /// @param minTokensOut Minimum tokens to receive, else `Slippage()`.
    /// @param deadline     Unix timestamp after which the call reverts with `Expired()`.
    /// @return tokensOut   Tokens received.
    function buy(address token, uint256 minTokensOut, uint256 deadline) external payable returns (uint256 tokensOut);

    /// @notice Sells `tokensIn` of `token` on its bonding curve. Tokens are pulled with `transferFrom`
    ///         (approve the launchpad first); ETH is sent with `call{value}`.
    /// @param token     The coin.
    /// @param tokensIn  Tokens to sell.
    /// @param minEthOut Minimum ETH to receive, else `Slippage()`.
    /// @param deadline  Unix timestamp after which the call reverts with `Expired()`.
    /// @return ethOut   ETH received (net of fee).
    function sell(address token, uint256 tokensIn, uint256 minEthOut, uint256 deadline)
        external
        returns (uint256 ethOut);

    /// @notice Permissionless. Moves a `Complete` curve to the DEX through the graduator.
    function graduate(address token) external;

    /// @notice Permissionless. Collects DEX fees of a `Graduated` coin into its mind vault.
    function harvest(address token) external;

    /// @notice Anyone can feed a mind: adds `msg.value` to `mindBalance(token)`.
    function fundMind(address token) external payable;

    /// @notice Only the graduator: credits leftover / harvested ETH to `mindBalance(token)`.
    function creditMind(address token) external payable;

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice Quotes a buy of `ethIn` wei on `token`'s curve (SPEC §1).
    function quoteBuy(address token, uint256 ethIn)
        external
        view
        returns (uint256 tokensOut, uint256 ethUsed, uint256 fee);

    /// @notice Quotes a sell of `tokensIn` on `token`'s curve (SPEC §1).
    function quoteSell(address token, uint256 tokensIn) external view returns (uint256 ethOut, uint256 fee);

    /// @notice Current curve price in wei per 1e18 tokens.
    function currentPrice(address token) external view returns (uint256 weiPer1e18Tokens);

    function getMind(address token) external view returns (MindInfo memory);
    function getCurve(address token) external view returns (CurveState memory);
    function mindBalance(address token) external view returns (uint256);
    function protocolBalance() external view returns (uint256);
    function mindsLength() external view returns (uint256);
    function mindAt(uint256 index) external view returns (address);
    function isMind(address token) external view returns (bool);
    function feeParams() external view returns (FeeParams memory);
    function creationFee() external view returns (uint256);
    function drawLimit() external view returns (uint256 maxPerEpoch, uint32 epochSeconds);
    /// @notice Raw epoch accounting for `token`; an epoch is over once `block.timestamp >= epochStart + epochSeconds`.
    function drawnInEpoch(address token) external view returns (uint256 drawn, uint64 epochStart);
    function operator() external view returns (address);
    function treasury() external view returns (address);
    function graduator() external view returns (address);

    // solhint-disable func-name-mixedcase
    function VIRTUAL_ETH() external view returns (uint256);
    function VIRTUAL_TOKENS() external view returns (uint256);
    function CURVE_SUPPLY() external view returns (uint256);
    function LP_SUPPLY() external view returns (uint256);
    function TOTAL_SUPPLY() external view returns (uint256);
    // solhint-enable func-name-mixedcase

    // ---------------------------------------------------------------------------------------------
    // Creator
    // ---------------------------------------------------------------------------------------------

    /// @notice Creator-only: updates model / persona / metadata of a mind.
    function setMindConfig(address token, bytes32 modelId, bytes32 personaHash, string calldata metadataURI) external;

    /// @notice Creator-only: retires the mind for good. Retired minds cannot be drawn from; the creator may
    ///         withdraw the remaining vault with {withdrawRetiredMind}.
    function retireMind(address token) external;

    /// @notice Creator-only, only when Retired: sends the whole `mindBalance(token)` to `to`.
    function withdrawRetiredMind(address token, address to) external;

    // ---------------------------------------------------------------------------------------------
    // Operator (runner hot wallet)
    // ---------------------------------------------------------------------------------------------

    /// @notice Operator-only: pays `amount` wei of compute from the mind vault to `to`, subject to the
    ///         per-epoch cap. `receiptHash` commits to the off-chain ledger being settled.
    function drawCompute(address token, uint256 amount, address to, bytes32 receiptHash) external;

    /// @notice Operator-only, event only: anchors a batch of memories on-chain.
    function anchorMemory(address token, uint64 seq, bytes32 contentHash, string calldata uri) external;

    /// @notice Operator-only: toggles Alive <-> Dormant. Cannot set Retired (creator-only via {retireMind}).
    function setMindStatus(address token, MindStatus status) external;

    /// @notice Alias of {graduate} (permissionless).
    function graduateFor(address token) external;

    // ---------------------------------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------------------------------

    function setOperator(address newOperator) external;
    function setTreasury(address newTreasury) external;
    function setGraduator(address newGraduator) external;
    /// @notice Bounds: trade <= 500, mindShare <= 10000, graduation <= 1000 (bps).
    function setFeeParams(FeeParams calldata params) external;
    function setCreationFee(uint256 newCreationFee) external;
    function setDrawLimit(uint256 maxPerEpoch, uint32 epochSeconds) external;
    /// @notice Pauses {createMind} and {buy} only; sell/graduate/harvest/draw stay enabled.
    function pause() external;
    function unpause() external;
    /// @notice Owner or treasury: sends the whole `protocolBalance()` to `to`.
    function withdrawProtocolFees(address to) external;
}
