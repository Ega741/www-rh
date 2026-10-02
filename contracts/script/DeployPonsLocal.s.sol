// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PonsMindRegistry} from "../src/PonsMindRegistry.sol";
import {IPonsV2LaunchFactory} from "../src/interfaces/pons/IPonsV2LaunchFactory.sol";
import {MockPonsFactory} from "../test/mocks/pons/MockPonsFactory.sol";
import {MockPonsFeeEscrow} from "../test/mocks/pons/MockPonsFeeEscrow.sol";
import {MockPonsMemeHook} from "../test/mocks/pons/MockPonsMemeHook.sol";
import {PonsDeployBase} from "./PonsDeployBase.sol";

/// @title DeployPonsLocal
/// @notice Local Pons mode (anvil e2e): deploys the Pons V2 models of `test/mocks/pons/` (fee escrow, meme hook,
///         launch factory with its launch deployer, one enabled mainnet-like launch config, public launches open) and a
///         {PonsMindRegistry} wired to them, in one broadcast, then writes `deployments/<chainId>.json`
///         `{ chainId, registry, venue: "pons", pons: { factory, feeEscrow, memeHook }, accountImplementation,
///         deployedAt }`. The mocks emit the same events as Pons (curve CurveBuy/CurveSell/CurveBuyRefunded/
///         FeesSwept/CurveCompleted, factory TokenLaunched/LaunchSwept/PoolGraduated/CreatorFeeRecipientUpdated,
///         escrow Credited/Claimed, hook PoolRegistered/PoolFeesSwept), so the runner's Pons indexer runs unchanged.
///         Refused on Robinhood Chain mainnet (4663).
/// @dev Environment (same conventions as `Deploy.s.sol`):
///      - `DEPLOYER_PRIVATE_KEY` (required) broadcaster key; it also owns the mocks, is Pons' protocol fee
///        recipient and fee sweep operator.
///      - `OWNER`, `TREASURY`, `COMPUTE_TREASURY`, `OPERATOR` each defaults to the deployer when unset/empty.
///      - `DEPLOYMENTS_FILE` output path override.
///      Launch config 0: supply 1e9 tokens, curveFeeBps 100, phantomQuote = graduationThreshold = 4.2 ether, pool fee
///      10000 / tick spacing 200; launch fee 0.0005 ether; snipe tax 99 % decaying over 15 s; protocol share 30 %.
contract DeployPonsLocal is PonsDeployBase {
    uint256 public constant LAUNCH_FEE = 0.0005 ether;
    uint256 public constant SUPPLY = 1_000_000_000 ether;
    uint256 public constant CURVE_FEE_BPS = 100;
    uint256 public constant PHANTOM_QUOTE = 4.2 ether;
    uint256 public constant GRADUATION_THRESHOLD = 4.2 ether;
    uint24 public constant POOL_FEE = 10_000;
    int24 public constant TICK_SPACING = 200;

    /// @notice Deployment parameters.
    struct Config {
        Roles roles; // zero = deployer
        string outFile; // empty = default path
    }

    /// @notice The mock Pons contracts must never be deployed on Robinhood Chain mainnet.
    error MockPonsNotAllowedOnMainnet(uint256 chainId);

    /// @notice Entry point for `forge script`.
    function run() external returns (Deployment memory) {
        return deployWith(configFromEnv(), vm.envUint("DEPLOYER_PRIVATE_KEY"));
    }

    /// @notice Builds a {Config} from the environment.
    function configFromEnv() public view returns (Config memory cfg) {
        cfg.roles = rolesFromEnv();
        cfg.outFile = _envString("DEPLOYMENTS_FILE", "");
    }

    /// @notice Deploys the Pons mocks and the registry, broadcasting with `privateKey`, and writes the deployments file.
    function deployWith(Config memory cfg, uint256 privateKey) public returns (Deployment memory) {
        if (block.chainid == ROBINHOOD_MAINNET) revert MockPonsNotAllowedOnMainnet(block.chainid);
        address deployer = vm.addr(privateKey);
        Roles memory r = _resolve(cfg.roles, deployer);

        vm.startBroadcast(privateKey);
        PonsAddresses memory p = _deployPons(deployer);
        PonsMindRegistry registry = _deployRegistry(r, p, deployer);
        vm.stopBroadcast();
        return _finish(registry, p, r, deployer, cfg.outFile);
    }

    function _deployPons(address deployer) internal returns (PonsAddresses memory p) {
        MockPonsFeeEscrow escrow = new MockPonsFeeEscrow();
        MockPonsMemeHook hook = new MockPonsMemeHook(deployer, escrow, deployer);
        MockPonsFactory factory = new MockPonsFactory(deployer, hook, escrow, LAUNCH_FEE);
        hook.setFactory(address(factory));
        factory.addLaunchConfig(
            IPonsV2LaunchFactory.LaunchConfig({
                supply: SUPPLY,
                curveFeeBps: CURVE_FEE_BPS,
                phantomQuote: PHANTOM_QUOTE,
                graduationThreshold: GRADUATION_THRESHOLD,
                poolFee: POOL_FEE,
                tickSpacing: TICK_SPACING,
                enabled: true
            })
        );
        factory.setLaunchEnabled(true);
        p = PonsAddresses({factory: address(factory), feeEscrow: address(escrow), memeHook: address(hook)});
    }
}
