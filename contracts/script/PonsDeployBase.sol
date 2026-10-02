// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";

import {PonsMindRegistry} from "../src/PonsMindRegistry.sol";
import {IPonsV2LaunchFactory} from "../src/interfaces/pons/IPonsV2LaunchFactory.sol";

/// @title PonsDeployBase
/// @notice Shared plumbing of {DeployPons} and {DeployPonsLocal}: env parsing with the same conventions as
///         `Deploy.s.sol` (unset or empty = default; roles default to the deployer), the registry deployment with the
///         optional two-step ownership hand-over, and the `deployments/<chainId>.json` writer
///         (`{ chainId, registry, venue: "pons", pons: { factory, feeEscrow, memeHook }, accountImplementation,
///         deployedAt }`).
abstract contract PonsDeployBase is Script {
    /// @notice Robinhood Chain mainnet (docs/ROBINHOOD_CHAIN.md).
    uint256 internal constant ROBINHOOD_MAINNET = 4663;

    /// @notice Role addresses; zero = the deployer.
    struct Roles {
        address owner;
        address treasury;
        address computeTreasury;
        address operator;
    }

    /// @notice Pons V2 addresses the registry is wired to.
    struct PonsAddresses {
        address factory;
        address feeEscrow;
        address memeHook;
    }

    /// @notice Deployment result.
    struct Deployment {
        address registry;
        address accountImplementation;
        PonsAddresses pons;
        address deployer;
        address owner;
        bool canLaunch; // factory.canLaunch(registry) right after deployment
        string outFile;
    }

    /// @notice Post-deployment wiring check failed.
    error WiringFailed();

    /// @notice Reads `OWNER`, `TREASURY`, `COMPUTE_TREASURY`, `OPERATOR` (each defaults to the deployer).
    function rolesFromEnv() public view returns (Roles memory r) {
        r.owner = _envAddress("OWNER", address(0));
        r.treasury = _envAddress("TREASURY", address(0));
        r.computeTreasury = _envAddress("COMPUTE_TREASURY", address(0));
        r.operator = _envAddress("OPERATOR", address(0));
    }

    function _envString(string memory name, string memory defaultValue) internal view returns (string memory value) {
        value = vm.envOr(name, string(""));
        if (bytes(value).length == 0) value = defaultValue;
    }

    function _envAddress(string memory name, address defaultValue) internal view returns (address) {
        string memory value = vm.envOr(name, string(""));
        return bytes(value).length == 0 ? defaultValue : vm.parseAddress(value);
    }

    function _resolve(Roles memory r, address deployer) internal pure returns (Roles memory out) {
        out.owner = r.owner == address(0) ? deployer : r.owner;
        out.treasury = r.treasury == address(0) ? deployer : r.treasury;
        out.computeTreasury = r.computeTreasury == address(0) ? deployer : r.computeTreasury;
        out.operator = r.operator == address(0) ? deployer : r.operator;
    }

    /// @dev Deploys the registry owned by `deployer` (inside the caller's broadcast) and starts the ownership
    ///      hand-over to `r.owner` (Ownable2Step: `r.owner` must call `acceptOwnership()`).
    function _deployRegistry(Roles memory r, PonsAddresses memory p, address deployer)
        internal
        returns (PonsMindRegistry registry)
    {
        registry = new PonsMindRegistry(
            deployer, r.treasury, r.computeTreasury, r.operator, p.factory, p.feeEscrow, p.memeHook
        );
        if (r.owner != deployer) registry.transferOwnership(r.owner);
    }

    /// @dev Checks the wiring, writes the deployments file and logs.
    function _finish(
        PonsMindRegistry registry,
        PonsAddresses memory p,
        Roles memory r,
        address deployer,
        string memory outFile
    ) internal returns (Deployment memory d) {
        if (
            address(registry.factory()) != p.factory || address(registry.feeEscrow()) != p.feeEscrow
                || address(registry.memeHook()) != p.memeHook || registry.operator() != r.operator
        ) revert WiringFailed();
        d = Deployment({
            registry: address(registry),
            accountImplementation: registry.accountImplementation(),
            pons: p,
            deployer: deployer,
            owner: r.owner,
            canLaunch: IPonsV2LaunchFactory(p.factory).canLaunch(address(registry)),
            outFile: bytes(outFile).length > 0 ? outFile : _defaultOutFile()
        });
        _write(d);
        _log(d, r);
    }

    /// @dev `deployments/<chainId>.json`, or `deployments/dry-run/<chainId>.json` for simulations (gitignored).
    function _defaultOutFile() internal returns (string memory) {
        string memory dir = vm.isContext(VmSafe.ForgeContext.ScriptDryRun) ? "deployments/dry-run" : "deployments";
        vm.createDir(dir, true);
        return string.concat(dir, "/", vm.toString(block.chainid), ".json");
    }

    function _write(Deployment memory d) internal {
        string memory ponsKey = "pons";
        vm.serializeAddress(ponsKey, "factory", d.pons.factory);
        vm.serializeAddress(ponsKey, "feeEscrow", d.pons.feeEscrow);
        string memory ponsJson = vm.serializeAddress(ponsKey, "memeHook", d.pons.memeHook);
        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "registry", d.registry);
        vm.serializeString(obj, "venue", "pons");
        vm.serializeString(obj, "pons", ponsJson);
        vm.serializeAddress(obj, "accountImplementation", d.accountImplementation);
        string memory json = vm.serializeUint(obj, "deployedAt", block.timestamp);
        vm.writeJson(json, d.outFile);
    }

    function _log(Deployment memory d, Roles memory r) internal pure {
        console2.log("PonsMindRegistry ", d.registry);
        console2.log("MindAccount impl ", d.accountImplementation);
        console2.log("Pons factory     ", d.pons.factory);
        console2.log("Pons fee escrow  ", d.pons.feeEscrow);
        console2.log("Pons meme hook   ", d.pons.memeHook);
        console2.log("Deployer         ", d.deployer);
        console2.log("Owner (final)    ", d.owner);
        console2.log("Treasury         ", r.treasury);
        console2.log("ComputeTreasury  ", r.computeTreasury);
        console2.log("Operator         ", r.operator);
        console2.log("Deployments file ", d.outFile);
        if (d.owner != d.deployer) console2.log("NOTE: OWNER must call acceptOwnership() on the registry");
        if (!d.canLaunch) {
            console2.log("WARNING: factory.canLaunch(registry) is false: launchMind reverts until Pons opens public");
            console2.log("         launches or whitelists the registry (adoption works regardless)");
        }
    }
}
