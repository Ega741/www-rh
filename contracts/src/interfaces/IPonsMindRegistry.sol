// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IMindCore} from "./IMindCore.sol";
import {IPonsV2FeeEscrow} from "./pons/IPonsV2FeeEscrow.sol";
import {IPonsV2LaunchFactory} from "./pons/IPonsV2LaunchFactory.sol";
import {IPonsV2MemeHook} from "./pons/IPonsV2MemeHook.sol";

/// @title IPonsMindRegistry
/// @notice External interface of {PonsMindRegistry} (SPEC §9.2, adoption and lifecycle per §9.7): {IMindCore} (mind
///         registry, vault, compute draws, roles) layered on Pons V2 launches. Every mind has a {MindAccount} (EIP-1167
///         clone) that is the launch's creator fee recipient; creator fees are credited to that account in the Pons fee
///         escrow and pulled into the mind vault by {harvest}. Native quote (ETH) launches only.
/// @dev Adoption binds every preparation to its preparer: {prepareAdoption} deploys (once) the preparer's own account
///      for the token and stores a pending config; the mind is registered (or taken over) only by {activateAdoption},
///      once that very account is the creator fee recipient, so the creator is always whoever's account received the
///      fee stream.
interface IPonsMindRegistry is IMindCore {
    // ---------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------

    /// @notice Parameters of a Pons launch created through {launchMind}.
    struct LaunchParams {
        string name; // 1..64 bytes
        string symbol; // 1..16 bytes
        string logo; // <= 512 bytes (enforced by Pons)
        string description; // <= 2048 bytes (enforced by Pons)
        IPonsV2LaunchFactory.Socials socials; // each <= 256 bytes (enforced by Pons)
        uint16 creatorTaxBps; // 0..factory.maxCreatorTaxBps(); paid to the mind account (-> mind vault)
        bytes32 expectedEconomics; // factory.previewLaunchEconomics(launchConfigId, address(0)), or 0 to skip
        bytes32 salt; // CREATE2 salt for the Pons token; also namespaces the mind account
        uint256 launchConfigId;
    }

    /// @notice Pons-side record of a mind.
    struct PonsMind {
        address curve; // the launch's PonsV2BondingCurve
        address account; // the mind's current MindAccount clone (creator fee recipient unless the mind left)
        uint256 launchConfigId; // 0 for adopted minds (the factory record does not store it)
        bool launchedHere; // launched through launchMind (the registry is the Pons deployer); kept on takeover
        bool adopted; // registered or taken over by activateAdoption
    }

    // ---------------------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------------------

    /// @notice A Pons token was launched with a mind (emitted after {IMindCore-MindCreated}).
    event MindLaunched(
        address indexed token, address indexed curve, address indexed account, address creator, uint256 launchConfigId
    );
    /// @notice `creator` (the preparer) prepared, or updated, a pending adoption of `token` with its own `account`.
    ///         Informational: nothing is registered until the launch's creator fee recipient is handed to `account`
    ///         (`factory.transferCreatorFeeRecipient(token, account)`) and anyone calls {activateAdoption}.
    event AdoptionPrepared(address indexed token, address indexed account, address indexed creator);
    /// @notice An adoption was activated: `account` (the creator fee recipient) is now the mind's account and
    ///         `creator` its creator. Follows {IMindCore-MindCreated} for a new mind, or {IMindCore-MindConfigUpdated}
    ///         for a takeover of an existing one.
    event MindAdopted(address indexed token, address indexed account, address indexed creator);
    /// @notice The creator moved the creator fees of `token` away from the mind account (status Dormant, {hasLeft}).
    event MindLeft(address indexed token, address newRecipient);
    /// @notice {harvest} (or {leave}) tried to sweep pending Pons fees into the escrow (best effort; failures are not
    ///         reverted).
    event SweepAttempted(address indexed token, bool curveSwept, bool poolSwept);
    /// @notice The operator recorded (or cleared, with zero) the Uniswap v4 pool id override of a graduated token.
    event PoolIdSet(address indexed token, bytes32 poolId);
    /// @notice The protocol cut of harvested creator fees changed.
    event MindFeeUpdated(uint16 bps);

    // ---------------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------------

    /// @notice The mind account for this launch salt is already deployed.
    error AccountExists();
    /// @notice The token is not a native-quote Pons V2 launch of the configured factory.
    error NotPonsLaunch();
    /// @notice Unused since adoption v2 (SPEC §9.7: anyone may prepare); kept for ABI stability.
    error NotRecipientOrDeployer();
    /// @notice No pending adoption for (token, preparer), or its account is not the launch's creator fee recipient.
    error AdoptionNotReady();
    /// @notice The token's current mind account is still the creator fee recipient (nothing to take over).
    error AlreadyAdopted();
    /// @notice `msg.value < factory.launchFee() + quoteIn + creationFee()`.
    error WrongValue();
    /// @notice The factory returned no token/curve, or a token that already has a mind.
    error LaunchFailed();
    /// @notice The launch has `buybackEnabled == true` (its creator bucket needs Pons' operator to sweep).
    error BuybackEnabledLaunch();
    /// @notice {leave} to the zero address, this registry, or any mind account deployed by this registry.
    error InvalidRecipient();

    // ---------------------------------------------------------------------------------------------
    // Creator
    // ---------------------------------------------------------------------------------------------

    /// @notice Launches a Pons V2 token whose creator fee recipient is a fresh mind account, registers the mind
    ///         (status Alive) and optionally makes an initial buy for the caller.
    /// @dev `msg.value >= factory.launchFee() + quoteIn + creationFee()` (else `WrongValue()`); the surplus and any
    ///      refund of the initial buy are returned to the caller in the same transaction (protects against a launch
    ///      fee change between quote and inclusion). The account is cloned with salt
    ///      `keccak256(abi.encode(msg.sender, p.salt))`; the launch uses native quote, `buybackEnabled = false` and
    ///      snipe-tax exemptions `[msg.sender]`; the creation fee goes to the protocol balance. `whenNotPaused`.
    /// @param p            Pons launch parameters.
    /// @param quoteIn      Wei of the initial buy (0 = none; then `minTokensOut` is ignored).
    /// @param minTokensOut Slippage bound of the initial buy (Pons price bound on a partial fill).
    /// @param modelId      keccak256 of the model id string (non-zero).
    /// @param personaHash  keccak256 of the persona prompt text.
    /// @param metadataURI  URI of the metadata JSON (at most 2048 bytes).
    function launchMind(
        LaunchParams calldata p,
        uint256 quoteIn,
        uint256 minTokensOut,
        bytes32 modelId,
        bytes32 personaHash,
        string calldata metadataURI
    ) external payable returns (address token, address curve, address account);

    /// @notice Anyone: prepares an adoption of an existing native-quote Pons token by the caller (the preparer). Deploys
    ///         the preparer's account for the token once (salt `keccak256(abi.encode(token, msg.sender))`; later calls,
    ///         also after an earlier adoption by the same preparer ended, reuse it) and stores the pending config.
    ///         Nothing is registered yet. Next: the creator fee recipient calls
    ///         `factory.transferCreatorFeeRecipient(token, account)`, then anyone calls
    ///         {activateAdoption} with (token, preparer).
    /// @dev Reverts `NotPonsLaunch()` for unknown or non-native-quote launches, `BuybackEnabledLaunch()` for launches
    ///      with buyback enabled, `InvalidModel()` / `MetadataTooLong()` for an invalid config. `whenNotPaused`.
    ///      Emits {AdoptionPrepared}.
    /// @return account The preparer's mind account for `token`.
    function prepareAdoption(address token, bytes32 modelId, bytes32 personaHash, string calldata metadataURI)
        external
        returns (address account);

    /// @notice Anyone: activates the pending adoption of (`token`, `preparer`) once its account is the launch's creator
    ///         fee recipient (else `AdoptionNotReady()`), then deletes the pending record. A token that is not a mind
    ///         yet is registered (creator `preparer`, status Alive, `adopted = true`; emits {IMindCore-MindCreated} with
    ///         the ERC-20 name/symbol, then {MindAdopted}). A mind whose current account is no longer the recipient
    ///         (its creator left, or Pons moved the recipient) is taken over: creator, config and account are replaced
    ///         (the old account's {tokenOf} cleared), `adopted = true`, {hasLeft} cleared, status Alive; emits
    ///         {IMindCore-MindConfigUpdated} and {MindAdopted}. Reverts `AlreadyAdopted()` when the current account is
    ///         still the recipient (unless the mind left and the recipient came back to that same account, which
    ///         re-activates it like a takeover). Not pausable (it completes a hand-off already made on Pons).
    function activateAdoption(address token, address preparer) external;

    /// @notice Creator only: harvests first (same best-effort sweeps and claim as {harvest}, so fees earned so far reach
    ///         the vault and `mindFeeBps` applies), then moves the launch's creator fees from the mind account to
    ///         `newRecipient`, marks the mind as left ({hasLeft}) and sets its status to Dormant. While left, the
    ///         creator's unpause restores Dormant (not Alive) and the operator cannot set Alive (`InvalidStatus()`); a
    ///         later takeover through {activateAdoption} clears it. The vault keeps its balance (still drawable for
    ///         compute) and {fundMind} still works.
    /// @dev `newRecipient` must not be zero, this registry, or any account deployed by this registry
    ///      (`InvalidRecipient()`); Pons itself reverts when the mind account is not the current recipient.
    function leave(address token, address newRecipient) external;

    /// @notice Creator only: moves the mind account's whole balance of `erc20` (e.g. memecoin paid out by a Pons rescue
    ///         or buyback vest) to the creator. ETH never leaves through this path.
    function recoverAccountTokens(address token, address erc20) external;

    // ---------------------------------------------------------------------------------------------
    // Permissionless
    // ---------------------------------------------------------------------------------------------

    /// @notice Sweeps pending Pons fees into the escrow (best effort, each attempt in try/catch: the curve while it is
    ///         trading, the graduated pool once created, by {poolIdOf} when set, else {derivedPoolId}), then claims the
    ///         mind account's escrow balance (plus any ETH sent to the account) into the registry: `mindFeeBps` of it
    ///         goes to the protocol balance, the rest to the mind vault.
    function harvest(address token) external;

    /// @notice Convenience: forwards to `factory.createGraduatedPool(token)` (permissionless on Pons too).
    function createGraduatedPool(address token) external;

    // ---------------------------------------------------------------------------------------------
    // Operator
    // ---------------------------------------------------------------------------------------------

    /// @notice Operator only: overrides the Uniswap v4 pool id {harvest} sweeps for a graduated token (normally
    ///         {derivedPoolId}; the hook's `PoolRegistered` log is authoritative). Zero clears the override.
    function setPoolId(address token, bytes32 poolId) external;

    // ---------------------------------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------------------------------

    /// @notice Sets the protocol cut of harvested creator fees (at most 1000 bps, else `FeeTooHigh()`).
    function setMindFeeBps(uint16 bps) external;

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice Pons-side record of `token` (zero struct when not a mind).
    function ponsMind(address token) external view returns (PonsMind memory);
    /// @notice Current mind account of `token` (zero when not a mind).
    function accountOf(address token) external view returns (address);
    /// @notice Token whose current mind account is `account` (zero for pending, superseded or unknown accounts).
    function tokenOf(address account) external view returns (address);
    /// @notice Operator override of the Uniswap v4 pool id of `token` (zero until {setPoolId}).
    function poolIdOf(address token) external view returns (bytes32);
    /// @notice Uniswap v4 pool id Pons registers for `token` at graduation:
    ///         `keccak256(abi.encode(PoolKey(address(0), token, lt.poolFee, lt.tickSpacing, memeHook)))` with
    ///         `lt = factory.getLaunchedToken(token)` (native quote sorts first). Zero for tokens that are not
    ///         native-quote Pons launches.
    function derivedPoolId(address token) external view returns (bytes32);
    /// @notice Whether the creator of `token` left ({leave}) and no takeover happened since.
    function hasLeft(address token) external view returns (bool);
    /// @notice Pending adoption of `token` by `preparer` (zero account when there is none).
    function pendingAdoption(address token, address preparer)
        external
        view
        returns (address account, bytes32 modelId, bytes32 personaHash, string memory metadataURI);
    /// @notice Address of the account {launchMind} would deploy for `creator` and `salt`.
    function predictAccount(address creator, bytes32 salt) external view returns (address);
    /// @notice Address of the account {prepareAdoption} deploys (or reuses) for `token` and `preparer`.
    function predictAdoptionAccount(address token, address preparer) external view returns (address);
    /// @notice ETH a {harvest} of `token` would claim now before sweeps: the mind account's fee escrow balance plus the
    ///         ETH it holds (0 when not a mind).
    function claimable(address token) external view returns (uint256);
    /// @notice What {launchMind} needs for `launchConfigId` and an initial buy of `quoteIn`: the Pons launch fee, the
    ///         minimum `msg.value`, and the current economics digest to pass as `expectedEconomics`.
    function launchQuote(uint256 launchConfigId, uint256 quoteIn)
        external
        view
        returns (uint256 launchFee, uint256 total, bytes32 economics);
    /// @notice The Pons V2 launch factory.
    function factory() external view returns (IPonsV2LaunchFactory);
    /// @notice The Pons V2 fee escrow.
    function feeEscrow() external view returns (IPonsV2FeeEscrow);
    /// @notice The Pons V2 meme hook (post-graduation fees).
    function memeHook() external view returns (IPonsV2MemeHook);
    /// @notice The {MindAccount} implementation every account clones.
    function accountImplementation() external view returns (address);
    /// @notice Protocol cut of harvested creator fees, in bps (default 0, max 1000).
    function mindFeeBps() external view returns (uint16);
}
