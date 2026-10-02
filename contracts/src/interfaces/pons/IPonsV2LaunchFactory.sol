// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPonsV2LaunchFactory
/// @notice Minimal local interface of Pons V2's `PonsV2LaunchFactory` (Robinhood Chain 4663:
///         0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e) with only the members SPEC §9.1 relies on. Struct layouts match
///         the deployed contract field for field (`TokenParams`, `LaunchConfig` from `PonsV2LaunchFactory`, `Socials`
///         from `PonsV2LauncherToken`, `LaunchedToken` from `IPonsV2LaunchFactory`, the file-level `GraduationPhase`),
///         so calldata and return data encode identically. Pons' contracts are outside this repository's audit.
interface IPonsV2LaunchFactory {
    /// @notice Graduation progress of a launch: trading on the curve, curve drained into the factory, V4 pool
    ///         seeded and locked, or reserves released manually (terminal).
    enum GraduationPhase {
        NotGraduated,
        Swept,
        PoolCreated,
        Rescued
    }

    /// @notice Social links stored on the launch token (`PonsV2LauncherToken.Socials`).
    struct Socials {
        string twitter;
        string telegram;
        string discord;
        string website;
        string farcaster;
    }

    /// @notice Launch parameters (`PonsV2LaunchFactory.TokenParams`).
    struct TokenParams {
        string name;
        string symbol;
        string logo;
        string description;
        Socials socials;
        address creatorFeeRecipient; // zero = the launching account
        uint16 creatorTaxBps; // <= maxCreatorTaxBps(); paid entirely to the creator fee recipient
        bool buybackEnabled;
        bytes32 expectedEconomics; // previewLaunchEconomics(id, pairToken), or zero to skip the guard
        bytes32 salt; // CREATE2 salt, namespaced by the factory per launching account
    }

    /// @notice Native-quote launch configuration (`PonsV2LaunchFactory.LaunchConfig`).
    struct LaunchConfig {
        uint256 supply;
        uint256 curveFeeBps;
        uint256 phantomQuote;
        uint256 graduationThreshold;
        uint24 poolFee;
        int24 tickSpacing;
        bool enabled;
    }

    /// @notice Record kept for every launch (`IPonsV2LaunchFactory.LaunchedToken`).
    struct LaunchedToken {
        address token;
        address curve;
        address deployer;
        address creatorFeeRecipient;
        address pairToken;
        uint256 graduationThreshold;
        uint24 poolFee;
        int24 tickSpacing;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        GraduationPhase phase;
        uint256 sweptQuote;
        uint256 sweptTokens;
        uint256 sweptAt;
        bool exists;
    }

    /// @notice A launch was created (`deployer` = the launching account).
    event TokenLaunched(
        address indexed token,
        address indexed curve,
        address indexed deployer,
        address pairToken,
        uint256 launchConfigId,
        uint256 graduationThreshold
    );
    /// @notice A ready curve was drained into the factory (phase `Swept`).
    event LaunchSwept(address indexed token, uint256 quoteOut, uint256 tokenOut);
    /// @notice The graduated V4 pool was seeded and its position locked (phase `PoolCreated`).
    event PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount);
    /// @notice The creator fee recipient of a launch changed.
    event CreatorFeeRecipientUpdated(
        address indexed token, address indexed previousRecipient, address indexed newRecipient
    );

    /// @notice Launches a token and its bonding curve. `msg.value` must equal {launchFee}; the caller must pass
    ///         {canLaunch}. The caller and the creator fee recipient are exempted from the snipe tax automatically,
    ///         plus every address in `snipeTaxExemptions` (at most 32).
    function launchToken(
        TokenParams calldata params,
        uint256 launchConfigId,
        address pairToken,
        address[] calldata snipeTaxExemptions
    ) external payable returns (address token, address curve);

    /// @notice Flat ETH fee every launch must attach exactly.
    function launchFee() external view returns (uint256);
    /// @notice `launchEnabled() || whitelistedLaunchers(launcher)`.
    function canLaunch(address launcher) external view returns (bool);
    /// @notice Whether public launches are open.
    function launchEnabled() external view returns (bool);
    /// @notice Whether `launcher` may launch while public launches are closed.
    function whitelistedLaunchers(address launcher) external view returns (bool);
    /// @notice Ceiling of `TokenParams.creatorTaxBps`.
    function maxCreatorTaxBps() external view returns (uint256);
    /// @notice Snipe-tax decay window (seconds) snapshotted by new launches.
    function snipeTaxSeconds() external view returns (uint256);
    /// @notice Economics digest a launch of `launchConfigId` in `pairToken` would lock in right now.
    function previewLaunchEconomics(uint256 launchConfigId, address pairToken) external view returns (bytes32);
    /// @notice Launch configuration `id` (reverts for an unknown id).
    function getLaunchConfig(uint256 id) external view returns (LaunchConfig memory);
    /// @notice The launch record of `token` (zeroed with `exists == false` for unknown tokens).
    function getLaunchedToken(address token) external view returns (LaunchedToken memory);
    /// @notice Permissionless, retryable: seeds the locked V4 pool of a `Swept` launch and registers it with the hook.
    function createGraduatedPool(address token) external returns (uint256 positionId);
    /// @notice Hands the creator fees of `token` to `newRecipient`; callable only by the current recipient (before
    ///         or after graduation).
    function transferCreatorFeeRecipient(address token, address newRecipient) external;
}
