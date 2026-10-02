// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IMindCore} from "./IMindCore.sol";
import {IPonsV2FeeEscrow} from "./pons/IPonsV2FeeEscrow.sol";
import {IPonsV2LaunchFactory} from "./pons/IPonsV2LaunchFactory.sol";
import {IPonsV2MemeHook} from "./pons/IPonsV2MemeHook.sol";

/// @title IPonsMindRegistry
/// @notice External interface of {PonsMindRegistry} (SPEC §9.2): {IMindCore} (mind registry, vault, compute draws,
///         roles) layered on Pons V2 launches. Every mind has a {MindAccount} (EIP-1167 clone) that is the launch's
///         creator fee recipient; creator fees are credited to that account in the Pons fee escrow and pulled into the
///         mind vault by {harvest}. Native quote (ETH) launches only.
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
        address account; // the mind's MindAccount clone (creator fee recipient)
        uint256 launchConfigId; // 0 for adopted minds (the factory record does not store it)
        bool launchedHere; // launched through launchMind (the registry is the Pons deployer)
        bool adopted; // adoption completed by activateAdoption (always false for launchedHere minds)
    }

    // ---------------------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------------------

    /// @notice A Pons token was launched with a mind (emitted after {IMindCore-MindCreated}).
    event MindLaunched(
        address indexed token, address indexed curve, address indexed account, address creator, uint256 launchConfigId
    );
    /// @notice An existing Pons token was registered for adoption (status Dormant). The current creator fee recipient
    ///         must now call `factory.transferCreatorFeeRecipient(token, account)`, then anyone {activateAdoption}.
    ///         No {IMindCore-MindCreated} is emitted for adoptions; read {getMind} and the token's ERC20 metadata.
    event AdoptionPrepared(address indexed token, address indexed account, address indexed creator);
    /// @notice The adoption completed: the mind account is the creator fee recipient.
    event MindAdopted(address indexed token, address indexed account);
    /// @notice The creator moved the creator fees of `token` away from the mind account (status Dormant).
    event MindLeft(address indexed token, address newRecipient);
    /// @notice {harvest} tried to sweep pending Pons fees into the escrow (best effort; failures are not reverted).
    event SweepAttempted(address indexed token, bool curveSwept, bool poolSwept);
    /// @notice The operator recorded the Uniswap v4 pool id of a graduated token.
    event PoolIdSet(address indexed token, bytes32 poolId);
    /// @notice The protocol cut of harvested creator fees changed.
    event MindFeeUpdated(uint16 bps);

    // ---------------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------------

    /// @notice The mind account for this salt/token is already deployed, or the token already has a mind.
    error AccountExists();
    /// @notice The token is not a native-quote Pons V2 launch of the configured factory.
    error NotPonsLaunch();
    /// @notice The caller is neither the launch's current creator fee recipient nor its deployer.
    error NotRecipientOrDeployer();
    /// @notice The mind account is not (yet) the launch's creator fee recipient.
    error AdoptionNotReady();
    /// @notice The mind was launched here or its adoption is already active.
    error AlreadyAdopted();
    /// @notice `msg.value != factory.launchFee() + quoteIn + creationFee()`.
    error WrongValue();
    /// @notice The factory returned no token/curve, or a token that already has a mind.
    error LaunchFailed();

    // ---------------------------------------------------------------------------------------------
    // Creator
    // ---------------------------------------------------------------------------------------------

    /// @notice Launches a Pons V2 token whose creator fee recipient is a fresh mind account, registers the mind
    ///         (status Alive) and optionally makes an initial buy for the caller.
    /// @dev `msg.value == factory.launchFee() + quoteIn + creationFee()`. The account is cloned with salt
    ///      `keccak256(abi.encode(msg.sender, p.salt))`; the launch uses native quote, `buybackEnabled = false` and
    ///      snipe-tax exemptions `[msg.sender]`. A refund of the initial buy is forwarded to the caller in the same
    ///      transaction; the creation fee goes to the protocol balance. `whenNotPaused`.
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

    /// @notice Registers an existing native-quote Pons token for adoption by its current creator fee recipient or
    ///         its deployer (who becomes the mind's creator). Deploys the account (salt `keccak256(abi.encode(token))`)
    ///         and registers the mind with status Dormant. `whenNotPaused`.
    function prepareAdoption(address token, bytes32 modelId, bytes32 personaHash, string calldata metadataURI)
        external
        returns (address account);

    /// @notice Anyone: completes an adoption once the mind account is the launch's creator fee recipient; status
    ///         becomes Alive unless creator-paused.
    function activateAdoption(address token) external;

    /// @notice Creator only: moves the launch's creator fees from the mind account to `newRecipient` and sets the
    ///         status to Dormant. The vault keeps its balance (still drawable for compute) and {fundMind} still works.
    function leave(address token, address newRecipient) external;

    // ---------------------------------------------------------------------------------------------
    // Permissionless
    // ---------------------------------------------------------------------------------------------

    /// @notice Sweeps pending Pons fees into the escrow (best effort, each attempt in try/catch: the curve while it is
    ///         trading, the graduated pool once its pool id is known), then claims the mind account's escrow balance
    ///         into the registry: `mindFeeBps` of it goes to the protocol balance, the rest to the mind vault.
    function harvest(address token) external;

    /// @notice Convenience: forwards to `factory.createGraduatedPool(token)` (permissionless on Pons too).
    function createGraduatedPool(address token) external;

    // ---------------------------------------------------------------------------------------------
    // Operator
    // ---------------------------------------------------------------------------------------------

    /// @notice Operator only: records the Uniswap v4 pool id of a graduated token, taken from the hook's
    ///         `PoolRegistered` log (the hook has no memecoin -> poolId view). Zero clears it.
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
    /// @notice Mind account of `token` (zero when not a mind).
    function accountOf(address token) external view returns (address);
    /// @notice Token of a mind account (zero for anything else).
    function tokenOf(address account) external view returns (address);
    /// @notice Recorded Uniswap v4 pool id of `token` (zero until {setPoolId}).
    function poolIdOf(address token) external view returns (bytes32);
    /// @notice Address of the account {launchMind} would deploy for `creator` and `salt`.
    function predictAccount(address creator, bytes32 salt) external view returns (address);
    /// @notice Address of the account {prepareAdoption} would deploy for `token`.
    function predictAdoptionAccount(address token) external view returns (address);
    /// @notice ETH the mind account of `token` can claim from the fee escrow now (0 when not a mind).
    function claimable(address token) external view returns (uint256);
    /// @notice What {launchMind} needs for `launchConfigId` and an initial buy of `quoteIn`: the Pons launch fee, the
    ///         exact `msg.value`, and the current economics digest to pass as `expectedEconomics`.
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
