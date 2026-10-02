// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {MindLaunchpad} from "../src/MindLaunchpad.sol";
import {MockGraduator} from "../src/MockGraduator.sol";
import {UniswapV3Graduator} from "../src/UniswapV3Graduator.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {IMindLaunchpad} from "../src/interfaces/IMindLaunchpad.sol";
import {MockWETH9} from "./mocks/MockWETH9.sol";
import {UniV3Factory} from "./mocks/uniswapv3/UniV3Factory.sol";
import {UniV3PositionManager} from "./mocks/uniswapv3/UniV3PositionManager.sol";

/// @notice Runs the deployment script in-process for both graduator kinds and checks the wiring and the JSON.
contract DeployScriptTest is Test {
    // Anvil's first default key (public test key).
    uint256 internal constant DEPLOYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    address internal deployer = vm.addr(DEPLOYER_KEY);
    Deploy internal script;

    function setUp() public {
        script = new Deploy();
        vm.deal(deployer, 10 ether);
    }

    function _cfg(string memory kind, address owner, string memory out) internal pure returns (Deploy.Config memory c) {
        c.owner = owner;
        c.graduatorKind = kind;
        c.feeTier = 10_000;
        c.outFile = out;
    }

    function test_deploy_mock_defaultsToDeployerRoles() public {
        string memory out = "cache/deploy-test-mock.json";
        Deploy.Deployment memory d = script.deployWith(_cfg("mock", address(0), out), DEPLOYER_KEY);

        MindLaunchpad launchpad = MindLaunchpad(payable(d.launchpad));
        assertEq(d.deployer, deployer);
        assertEq(launchpad.owner(), deployer);
        assertEq(launchpad.treasury(), deployer);
        assertEq(launchpad.computeTreasury(), deployer);
        assertEq(launchpad.operator(), deployer);
        assertEq(launchpad.graduator(), d.graduator);
        assertEq(MockGraduator(d.graduator).launchpad(), d.launchpad);
        assertEq(launchpad.graduationGrace(), 1 days);

        string memory json = vm.readFile(out);
        assertEq(vm.parseJsonAddress(json, ".launchpad"), d.launchpad);
        assertEq(vm.parseJsonAddress(json, ".graduator"), d.graduator);
        assertEq(vm.parseJsonString(json, ".graduatorKind"), "mock");
        assertEq(vm.parseJsonUint(json, ".chainId"), block.chainid);
        assertEq(vm.parseJsonUint(json, ".deployedAt"), block.timestamp);
        assertFalse(vm.keyExistsJson(json, ".startBlock"));
    }

    function test_deploy_uniswapv3_withSeparateOwner() public {
        UniV3Factory factory = new UniV3Factory();
        UniV3PositionManager npm = new UniV3PositionManager(address(factory));
        MockWETH9 weth = new MockWETH9();
        address owner = makeAddr("multisig");
        Deploy.Config memory c = _cfg("uniswapv3", owner, "cache/deploy-test-uniswapv3.json");
        c.treasury = makeAddr("treasury");
        c.computeTreasury = makeAddr("computeTreasury");
        c.operator = makeAddr("operator");
        c.weth9 = address(weth);
        c.factory = address(factory);
        c.positionManager = address(npm);

        Deploy.Deployment memory d = script.deployWith(c, DEPLOYER_KEY);
        MindLaunchpad launchpad = MindLaunchpad(payable(d.launchpad));
        assertEq(launchpad.owner(), deployer, "ownership is two-step");
        assertEq(launchpad.pendingOwner(), owner);
        vm.prank(owner);
        launchpad.acceptOwnership();
        assertEq(launchpad.owner(), owner);
        assertEq(launchpad.treasury(), c.treasury);
        assertEq(launchpad.computeTreasury(), c.computeTreasury);
        assertEq(launchpad.operator(), c.operator);

        UniswapV3Graduator g = UniswapV3Graduator(payable(d.graduator));
        assertEq(launchpad.graduator(), address(g));
        assertEq(g.owner(), deployer, "graduator ownership is two-step too");
        assertEq(g.pendingOwner(), owner);
        vm.prank(owner);
        g.acceptOwnership();
        assertEq(g.owner(), owner);
        assertEq(g.launchpad(), d.launchpad);
        assertEq(address(g.weth9()), address(weth));
        assertEq(address(g.factory()), address(factory));
        assertEq(address(g.positionManager()), address(npm));
        assertEq(g.feeTier(), 10_000);
        assertEq(g.priceToleranceBps(), 100);
        assertEq(vm.parseJsonString(vm.readFile(d.outFile), ".graduatorKind"), "uniswapv3");
    }

    function test_deploy_refusesMockGraduatorOnMainnet() public {
        vm.chainId(4663);
        vm.expectRevert(abi.encodeWithSelector(Deploy.MockGraduatorNotAllowedOnMainnet.selector, 4663));
        script.deployWith(_cfg("mock", address(0), "cache/x.json"), DEPLOYER_KEY);
        // Testnet and local chains still accept the mock.
        vm.chainId(46_630);
        Deploy.Deployment memory d = script.deployWith(_cfg("mock", address(0), "cache/deploy-test-mock.json"), DEPLOYER_KEY);
        assertEq(MindLaunchpad(payable(d.launchpad)).graduator(), d.graduator);
    }

    function test_deployedLaunchpadRejectsForeignGraduator() public {
        Deploy.Deployment memory d =
            script.deployWith(_cfg("mock", address(0), "cache/deploy-test-mock.json"), DEPLOYER_KEY);
        MockGraduator foreign = new MockGraduator(address(0xBEEF));
        vm.prank(deployer);
        vm.expectRevert(IMindLaunchpad.InvalidGraduator.selector);
        MindLaunchpad(payable(d.launchpad)).setGraduator(address(foreign));
    }

    function test_deploy_rejectsBadConfig() public {
        vm.expectRevert(abi.encodeWithSelector(Deploy.UnknownGraduatorKind.selector, "v2"));
        script.deployWith(_cfg("v2", address(0), "cache/x.json"), DEPLOYER_KEY);
        vm.expectRevert(abi.encodeWithSelector(Deploy.MissingUniswapAddress.selector, "WETH9"));
        script.deployWith(_cfg("uniswapv3", address(0), "cache/x.json"), DEPLOYER_KEY);
    }

    function test_configFromEnv_defaults() public {
        string[9] memory vars = [
            "GRADUATOR_KIND",
            "WETH9",
            "UNIV3_FACTORY",
            "UNIV3_POSITION_MANAGER",
            "UNIV3_FEE_TIER",
            "OWNER",
            "TREASURY",
            "COMPUTE_TREASURY",
            "OPERATOR"
        ];
        for (uint256 i; i < vars.length; ++i) {
            // The defaults are only observable when the deployment env is not set in this shell.
            if (bytes(vm.envOr(vars[i], string(""))).length > 0) vm.skip(true);
        }
        // Off mainnet the default graduator is the mock and no Uniswap addresses are assumed.
        Deploy.Config memory c = script.configFromEnv();
        assertEq(c.graduatorKind, "mock");
        assertEq(c.feeTier, 10_000);

        vm.chainId(4663);
        c = script.configFromEnv();
        assertEq(c.graduatorKind, "uniswapv3");
        assertEq(c.weth9, 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73);
        assertEq(c.factory, 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA);
        assertEq(c.positionManager, 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3);
        assertEq(c.owner, address(0), "roles default to the deployer");
        assertEq(c.operator, address(0));
    }
}
