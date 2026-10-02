// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";

import {MindLaunchpad} from "../src/MindLaunchpad.sol";
import {MockGraduator} from "../src/MockGraduator.sol";
import {UniswapV3Graduator} from "../src/UniswapV3Graduator.sol";

/// @title Deploy
/// @notice Env-driven two-step deployment: `MindLaunchpad` -> graduator(launchpad) -> `setGraduator`, then (if
///         `OWNER` is not the deployer) `transferOwnership(OWNER)` — Ownable2Step, so `OWNER` must call
///         `acceptOwnership()` afterwards. Writes `deployments/<chainId>.json` with the keys `launchpad`,
///         `graduator`, `graduatorKind`, `chainId`, `deployedAt` (unix seconds) and `startBlock` (a block at or before
///         the deployment, usable as the indexer start). Dry runs write `deployments/dry-run/<chainId>.json`.
/// @dev Environment (all optional unless noted):
///      - `DEPLOYER_PRIVATE_KEY`  broadcaster key; otherwise use forge's `--private-key/--account/--ledger`.
///      - `OWNER`                 final owner of the launchpad and the Uniswap graduator (default: deployer).
///      - `TREASURY`              protocol treasury (default: OWNER).
///      - `COMPUTE_TREASURY`      recipient of compute draws (default: TREASURY).
///      - `OPERATOR`              runner hot wallet (default: deployer).
///      - `GRADUATOR_KIND`        `uniswapv3` | `mock` (default: `uniswapv3` on 4663, `mock` elsewhere).
///      - `WETH9`, `UNIV3_FACTORY`, `UNIV3_POSITION_MANAGER`  Uniswap v3 wiring (defaults known for 4663;
///        required for `uniswapv3` elsewhere).
///      - `UNIV3_FEE_TIER`        pool fee tier (default 10000 = 1 %).
///      - `DEPLOYMENTS_FILE`      output path override (relative to `contracts/`).
contract Deploy is Script {
    /// @notice Robinhood Chain mainnet (docs/ROBINHOOD_CHAIN.md).
    uint256 internal constant ROBINHOOD_MAINNET = 4663;
    address internal constant MAINNET_WETH9 = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant MAINNET_UNIV3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address internal constant MAINNET_UNIV3_POSITION_MANAGER = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;

    /// @notice Deployment parameters.
    struct Config {
        address owner; // zero = deployer
        address treasury; // zero = owner
        address computeTreasury; // zero = treasury
        address operator; // zero = deployer
        string graduatorKind; // "uniswapv3" | "mock"
        address weth9;
        address factory;
        address positionManager;
        uint24 feeTier;
        string outFile; // empty = default path
    }

    /// @notice Deployed addresses.
    struct Deployment {
        address launchpad;
        address graduator;
        string graduatorKind;
        address deployer;
        address owner;
        string outFile;
    }

    error UnknownGraduatorKind(string kind);
    error MissingUniswapAddress(string name);

    /// @notice Entry point for `forge script`: reads the environment, deploys and writes the deployments file.
    function run() external returns (Deployment memory) {
        return deployWith(configFromEnv(), vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0)));
    }

    /// @notice Builds a {Config} from the environment (see the contract docs).
    function configFromEnv() public view returns (Config memory cfg) {
        bool mainnet = block.chainid == ROBINHOOD_MAINNET;
        cfg.owner = vm.envOr("OWNER", address(0));
        cfg.treasury = vm.envOr("TREASURY", address(0));
        cfg.computeTreasury = vm.envOr("COMPUTE_TREASURY", address(0));
        cfg.operator = vm.envOr("OPERATOR", address(0));
        cfg.graduatorKind = vm.envOr("GRADUATOR_KIND", mainnet ? string("uniswapv3") : string("mock"));
        cfg.weth9 = vm.envOr("WETH9", mainnet ? MAINNET_WETH9 : address(0));
        cfg.factory = vm.envOr("UNIV3_FACTORY", mainnet ? MAINNET_UNIV3_FACTORY : address(0));
        cfg.positionManager = vm.envOr("UNIV3_POSITION_MANAGER", mainnet ? MAINNET_UNIV3_POSITION_MANAGER : address(0));
        cfg.feeTier = uint24(vm.envOr("UNIV3_FEE_TIER", uint256(10_000)));
        cfg.outFile = vm.envOr("DEPLOYMENTS_FILE", string(""));
    }

    /// @notice Deploys and wires everything with `privateKey` (0 = forge's configured sender), then writes the
    ///         deployments file.
    function deployWith(Config memory cfg, uint256 privateKey) public returns (Deployment memory d) {
        bytes32 kind = keccak256(bytes(cfg.graduatorKind));
        bool uniswap = kind == keccak256("uniswapv3");
        if (!uniswap && kind != keccak256("mock")) revert UnknownGraduatorKind(cfg.graduatorKind);
        if (uniswap) {
            if (cfg.weth9 == address(0)) revert MissingUniswapAddress("WETH9");
            if (cfg.factory == address(0)) revert MissingUniswapAddress("UNIV3_FACTORY");
            if (cfg.positionManager == address(0)) revert MissingUniswapAddress("UNIV3_POSITION_MANAGER");
        }

        if (privateKey != 0) vm.startBroadcast(privateKey);
        else vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        Roles memory r = _roles(cfg, deployer);

        // Step 1: launchpad, owned by the deployer until the graduator is wired.
        MindLaunchpad launchpad = new MindLaunchpad(deployer, r.treasury, r.computeTreasury, r.operator);
        // Step 2: graduator pointing at the launchpad.
        address graduator = _deployGraduator(cfg, uniswap, address(launchpad), r.owner);
        // Step 3: wire it, then hand over ownership (two-step).
        launchpad.setGraduator(graduator);
        if (r.owner != deployer) launchpad.transferOwnership(r.owner);
        vm.stopBroadcast();

        d = Deployment({
            launchpad: address(launchpad),
            graduator: graduator,
            graduatorKind: cfg.graduatorKind,
            deployer: deployer,
            owner: r.owner,
            outFile: bytes(cfg.outFile).length > 0 ? cfg.outFile : _defaultOutFile()
        });
        _write(d);
        _log(d, r);
    }

    /// @dev Resolved role addresses.
    struct Roles {
        address owner;
        address treasury;
        address computeTreasury;
        address operator;
    }

    function _roles(Config memory cfg, address deployer) internal pure returns (Roles memory r) {
        r.owner = cfg.owner == address(0) ? deployer : cfg.owner;
        r.treasury = cfg.treasury == address(0) ? r.owner : cfg.treasury;
        r.computeTreasury = cfg.computeTreasury == address(0) ? r.treasury : cfg.computeTreasury;
        r.operator = cfg.operator == address(0) ? deployer : cfg.operator;
    }

    function _deployGraduator(Config memory cfg, bool uniswap, address launchpad, address owner)
        internal
        returns (address)
    {
        if (!uniswap) return address(new MockGraduator(launchpad));
        return address(
            new UniswapV3Graduator(owner, launchpad, cfg.positionManager, cfg.factory, cfg.weth9, cfg.feeTier)
        );
    }

    /// @dev `deployments/<chainId>.json`, or `deployments/dry-run/<chainId>.json` for simulations (gitignored).
    function _defaultOutFile() internal returns (string memory) {
        string memory dir = vm.isContext(VmSafe.ForgeContext.ScriptDryRun) ? "deployments/dry-run" : "deployments";
        vm.createDir(dir, true);
        return string.concat(dir, "/", vm.toString(block.chainid), ".json");
    }

    function _write(Deployment memory d) internal {
        string memory obj = "deployment";
        vm.serializeAddress(obj, "launchpad", d.launchpad);
        vm.serializeAddress(obj, "graduator", d.graduator);
        vm.serializeString(obj, "graduatorKind", d.graduatorKind);
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeUint(obj, "startBlock", block.number);
        string memory json = vm.serializeUint(obj, "deployedAt", block.timestamp);
        vm.writeJson(json, d.outFile);
    }

    function _log(Deployment memory d, Roles memory r) internal pure {
        console2.log("MindLaunchpad   ", d.launchpad);
        console2.log("Graduator       ", d.graduator, d.graduatorKind);
        console2.log("Deployer        ", d.deployer);
        console2.log("Owner (final)   ", d.owner);
        console2.log("Treasury        ", r.treasury);
        console2.log("ComputeTreasury ", r.computeTreasury);
        console2.log("Operator        ", r.operator);
        console2.log("Deployments file", d.outFile);
        if (d.owner != d.deployer) console2.log("NOTE: OWNER must call acceptOwnership() on the launchpad");
    }
}
