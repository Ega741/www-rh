// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PonsMindRegistry} from "../src/PonsMindRegistry.sol";
import {PonsDeployBase} from "./PonsDeployBase.sol";

/// @title DeployPons
/// @notice Deploys {PonsMindRegistry} wired to an existing Pons V2 deployment (SPEC §9.2/§9.6) in one broadcast:
///         (1) the registry owned by the deployer (it deploys its {MindAccount} implementation), (2) if `OWNER` is not
///         the deployer, `transferOwnership(OWNER)` (Ownable2Step: `OWNER` must call `acceptOwnership()`), (3) checks
///         the wiring, (4) writes `deployments/<chainId>.json`
///         `{ chainId, registry, venue: "pons", pons: { factory, feeEscrow, memeHook }, accountImplementation,
///         deployedAt }` and logs whether `factory.canLaunch(registry)` already holds. Dry runs (no `--broadcast`)
///         write `deployments/dry-run/<chainId>.json`.
/// @dev Environment:
///      - `DEPLOYER_PRIVATE_KEY` (required) broadcaster key.
///      - `OWNER`, `TREASURY`, `COMPUTE_TREASURY`, `OPERATOR` each defaults to the deployer when unset/empty.
///      - `PONS_FACTORY`, `PONS_FEE_ESCROW`, `PONS_MEME_HOOK` default to the Pons V2 mainnet addresses on 4663 and are
///        required (with code) on every other chain; the script refuses to deploy otherwise.
///      - `DEPLOYMENTS_FILE` output path override (relative to `contracts/`; its directory must exist).
///      For local anvil runs against mock Pons contracts use `DeployPonsLocal.s.sol`.
contract DeployPons is PonsDeployBase {
    /// @notice Pons V2 on Robinhood Chain mainnet (SPEC §9.1).
    address internal constant MAINNET_PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address internal constant MAINNET_PONS_FEE_ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address internal constant MAINNET_PONS_MEME_HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;

    /// @notice Deployment parameters.
    struct Config {
        Roles roles; // zero = deployer
        PonsAddresses pons; // zero = missing
        string outFile; // empty = default path
    }

    /// @notice A Pons address is unset on a chain without defaults (only 4663 has them).
    error MissingPonsAddress(string name);
    /// @notice A configured Pons address has no code on this chain.
    error PonsAddressHasNoCode(string name, address account);

    /// @notice Entry point for `forge script`: reads the environment, deploys and writes the deployments file.
    function run() external returns (Deployment memory) {
        return deployWith(configFromEnv(), vm.envUint("DEPLOYER_PRIVATE_KEY"));
    }

    /// @notice Builds a {Config} from the environment (unset and empty variables both mean "use the default").
    function configFromEnv() public view returns (Config memory cfg) {
        bool mainnet = block.chainid == ROBINHOOD_MAINNET;
        cfg.roles = rolesFromEnv();
        cfg.pons.factory = _envAddress("PONS_FACTORY", mainnet ? MAINNET_PONS_FACTORY : address(0));
        cfg.pons.feeEscrow = _envAddress("PONS_FEE_ESCROW", mainnet ? MAINNET_PONS_FEE_ESCROW : address(0));
        cfg.pons.memeHook = _envAddress("PONS_MEME_HOOK", mainnet ? MAINNET_PONS_MEME_HOOK : address(0));
        cfg.outFile = _envString("DEPLOYMENTS_FILE", "");
    }

    /// @notice Validates the Pons addresses, deploys, broadcasting with `privateKey`, and writes the deployments file.
    function deployWith(Config memory cfg, uint256 privateKey) public returns (Deployment memory) {
        _requirePons("PONS_FACTORY", cfg.pons.factory);
        _requirePons("PONS_FEE_ESCROW", cfg.pons.feeEscrow);
        _requirePons("PONS_MEME_HOOK", cfg.pons.memeHook);

        address deployer = vm.addr(privateKey);
        Roles memory r = _resolve(cfg.roles, deployer);
        vm.startBroadcast(privateKey);
        PonsMindRegistry registry = _deployRegistry(r, cfg.pons, deployer);
        vm.stopBroadcast();
        return _finish(registry, cfg.pons, r, deployer, cfg.outFile);
    }

    function _requirePons(string memory name, address account) internal view {
        if (account == address(0)) revert MissingPonsAddress(name);
        if (account.code.length == 0) revert PonsAddressHasNoCode(name, account);
    }
}
