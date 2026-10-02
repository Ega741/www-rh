// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {MindLaunchpad} from "../src/MindLaunchpad.sol";
import {MockGraduator} from "../src/MockGraduator.sol";
import {UniswapV3Graduator} from "../src/UniswapV3Graduator.sol";

/// @title Deploy
/// @notice Env-driven two-step deployment (SPEC §2.6), all in one broadcast: (1) `MindLaunchpad` owned by the
///         deployer, (2) graduator(launchpad), (3) `setGraduator`, (4) if `OWNER` is not the deployer,
///         `transferOwnership(OWNER)` on the launchpad and on a `UniswapV3Graduator` — Ownable2Step, so `OWNER` must
///         call `acceptOwnership()` on each afterwards, (5) assert the wiring, (6) write
///         `deployments/<chainId>.json` with the keys `chainId`, `launchpad`, `graduator`, `graduatorKind`,
///         `venue` (`"curve"`, SPEC §9.2) and `deployedAt` (unix seconds). Dry runs (no `--broadcast`) write `deployments/dry-run/<chainId>.json`.
/// @dev Environment:
///      - `DEPLOYER_PRIVATE_KEY`  (required) broadcaster key.
///      - `OWNER`, `TREASURY`, `COMPUTE_TREASURY`, `OPERATOR`  each defaults to the deployer when unset/empty.
///      - `GRADUATOR_KIND`        `uniswapv3` | `mock` (default: `uniswapv3` on 4663, `mock` elsewhere). `mock` is
///        refused on Robinhood Chain mainnet (4663): the mock keeps the graduation liquidity forever.
///      - `WETH9`, `UNIV3_FACTORY`, `UNIV3_POSITION_MANAGER`  required for `uniswapv3`; on 4663 they default to the
///        addresses in docs/ROBINHOOD_CHAIN.md.
///      - `UNIV3_FEE_TIER`        pool fee tier (default 10000 = 1 %).
///      - `DEPLOYMENTS_FILE`      output path override (relative to `contracts/`; its directory must exist).
contract Deploy is Script {
    /// @notice Robinhood Chain mainnet (docs/ROBINHOOD_CHAIN.md).
    uint256 internal constant ROBINHOOD_MAINNET = 4663;
    address internal constant MAINNET_WETH9 = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant MAINNET_UNIV3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address internal constant MAINNET_UNIV3_POSITION_MANAGER = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;

    /// @notice Deployment parameters.
    struct Config {
        address owner; // zero = deployer
        address treasury; // zero = deployer
        address computeTreasury; // zero = deployer
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

    /// @notice `GRADUATOR_KIND` is neither `uniswapv3` nor `mock`.
    error UnknownGraduatorKind(string kind);
    /// @notice A Uniswap v3 address required for `uniswapv3` is missing.
    error MissingUniswapAddress(string name);
    /// @notice `GRADUATOR_KIND=mock` on Robinhood Chain mainnet (4663): the mock graduator keeps every graduated
    ///         coin's ETH and tokens forever, so it must never be deployed there. Use `uniswapv3`.
    error MockGraduatorNotAllowedOnMainnet(uint256 chainId);
    /// @notice Post-deployment wiring check failed.
    error WiringFailed();

    /// @notice Entry point for `forge script`: reads the environment, deploys and writes the deployments file.
    function run() external returns (Deployment memory) {
        return deployWith(configFromEnv(), vm.envUint("DEPLOYER_PRIVATE_KEY"));
    }

    /// @notice Builds a {Config} from the environment (see the contract docs). Unset and empty variables both mean
    ///         "use the default".
    function configFromEnv() public view returns (Config memory cfg) {
        bool mainnet = block.chainid == ROBINHOOD_MAINNET;
        cfg.owner = _envAddress("OWNER", address(0));
        cfg.treasury = _envAddress("TREASURY", address(0));
        cfg.computeTreasury = _envAddress("COMPUTE_TREASURY", address(0));
        cfg.operator = _envAddress("OPERATOR", address(0));
        cfg.graduatorKind = _envString("GRADUATOR_KIND", mainnet ? "uniswapv3" : "mock");
        cfg.weth9 = _envAddress("WETH9", mainnet ? MAINNET_WETH9 : address(0));
        cfg.factory = _envAddress("UNIV3_FACTORY", mainnet ? MAINNET_UNIV3_FACTORY : address(0));
        cfg.positionManager =
            _envAddress("UNIV3_POSITION_MANAGER", mainnet ? MAINNET_UNIV3_POSITION_MANAGER : address(0));
        string memory feeTier = _envString("UNIV3_FEE_TIER", "10000");
        cfg.feeTier = SafeCast.toUint24(vm.parseUint(feeTier));
        cfg.outFile = _envString("DEPLOYMENTS_FILE", "");
    }

    function _envString(string memory name, string memory defaultValue) internal view returns (string memory value) {
        value = vm.envOr(name, string(""));
        if (bytes(value).length == 0) value = defaultValue;
    }

    function _envAddress(string memory name, address defaultValue) internal view returns (address) {
        string memory value = vm.envOr(name, string(""));
        return bytes(value).length == 0 ? defaultValue : vm.parseAddress(value);
    }

    /// @notice Deploys and wires everything, broadcasting with `privateKey`, then writes the deployments file.
    function deployWith(Config memory cfg, uint256 privateKey) public returns (Deployment memory d) {
        bytes32 kind = keccak256(bytes(cfg.graduatorKind));
        bool uniswap = kind == keccak256("uniswapv3");
        if (!uniswap && kind != keccak256("mock")) revert UnknownGraduatorKind(cfg.graduatorKind);
        if (!uniswap && block.chainid == ROBINHOOD_MAINNET) revert MockGraduatorNotAllowedOnMainnet(block.chainid);
        if (uniswap) {
            if (cfg.weth9 == address(0)) revert MissingUniswapAddress("WETH9");
            if (cfg.factory == address(0)) revert MissingUniswapAddress("UNIV3_FACTORY");
            if (cfg.positionManager == address(0)) revert MissingUniswapAddress("UNIV3_POSITION_MANAGER");
        }

        address deployer = vm.addr(privateKey);
        Roles memory r = _roles(cfg, deployer);

        vm.startBroadcast(privateKey);
        // (1) Launchpad, owned by the deployer until the graduator is wired.
        MindLaunchpad launchpad = new MindLaunchpad(deployer, r.treasury, r.computeTreasury, r.operator);
        // (2) Graduator pointing at the launchpad.
        address graduator = _deployGraduator(cfg, uniswap, address(launchpad), deployer);
        // (3) Wire it.
        launchpad.setGraduator(graduator);
        // (4) Hand over ownership (two-step: OWNER must acceptOwnership()).
        if (r.owner != deployer) {
            launchpad.transferOwnership(r.owner);
            if (uniswap) UniswapV3Graduator(payable(graduator)).transferOwnership(r.owner);
        }
        vm.stopBroadcast();
        // (5) Sanity check (setGraduator itself already required graduator.launchpad() == launchpad).
        if (launchpad.graduator() != graduator) revert WiringFailed();

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
        r.treasury = cfg.treasury == address(0) ? deployer : cfg.treasury;
        r.computeTreasury = cfg.computeTreasury == address(0) ? deployer : cfg.computeTreasury;
        r.operator = cfg.operator == address(0) ? deployer : cfg.operator;
    }

    function _deployGraduator(Config memory cfg, bool uniswap, address launchpad, address deployer)
        internal
        returns (address)
    {
        if (!uniswap) return address(new MockGraduator(launchpad));
        return
            address(
                new UniswapV3Graduator(deployer, launchpad, cfg.positionManager, cfg.factory, cfg.weth9, cfg.feeTier)
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
        vm.serializeString(obj, "venue", "curve");
        vm.serializeUint(obj, "chainId", block.chainid);
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
        if (d.owner != d.deployer) {
            console2.log("NOTE: OWNER must call acceptOwnership() on the launchpad (and on a uniswapv3 graduator)");
        }
    }
}
