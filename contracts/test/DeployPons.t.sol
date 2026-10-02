// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PonsMindRegistry} from "../src/PonsMindRegistry.sol";
import {MindAccount} from "../src/MindAccount.sol";
import {IPonsMindRegistry} from "../src/interfaces/IPonsMindRegistry.sol";
import {IPonsV2LaunchFactory} from "../src/interfaces/pons/IPonsV2LaunchFactory.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {DeployPons} from "../script/DeployPons.s.sol";
import {DeployPonsLocal} from "../script/DeployPonsLocal.s.sol";
import {PonsDeployBase} from "../script/PonsDeployBase.sol";
import {MockPonsFactory} from "./mocks/pons/MockPonsFactory.sol";
import {MockPonsFeeEscrow} from "./mocks/pons/MockPonsFeeEscrow.sol";
import {MockPonsMemeHook} from "./mocks/pons/MockPonsMemeHook.sol";

/// @notice Runs DeployPons (against Pons mocks standing in for mainnet), DeployPonsLocal and the curve Deploy script
///         in-process and checks the wiring, the guards and the deployments JSON.
contract DeployPonsScriptTest is Test {
    // Anvil's first default key (public test key).
    uint256 internal constant DEPLOYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    address internal deployer = vm.addr(DEPLOYER_KEY);

    DeployPons internal ponsScript;
    DeployPonsLocal internal localScript;
    MockPonsFactory internal factory;
    MockPonsFeeEscrow internal escrow;
    MockPonsMemeHook internal hook;

    function setUp() public {
        ponsScript = new DeployPons();
        localScript = new DeployPonsLocal();
        vm.deal(deployer, 10 ether);
        // A Pons stand-in for DeployPons.
        address ponsOwner = makeAddr("ponsOwner");
        escrow = new MockPonsFeeEscrow();
        hook = new MockPonsMemeHook(ponsOwner, escrow, ponsOwner);
        factory = new MockPonsFactory(ponsOwner, hook, escrow, 0.0005 ether);
        vm.prank(ponsOwner);
        hook.setFactory(address(factory));
    }

    function _ponsCfg(string memory out) internal view returns (DeployPons.Config memory c) {
        c.pons = PonsDeployBase.PonsAddresses({
            factory: address(factory), feeEscrow: address(escrow), memeHook: address(hook)
        });
        c.outFile = out;
    }

    function _assertJson(PonsDeployBase.Deployment memory d) internal view {
        string memory json = vm.readFile(d.outFile);
        assertEq(vm.parseJsonUint(json, ".chainId"), block.chainid);
        assertEq(vm.parseJsonAddress(json, ".registry"), d.registry);
        assertEq(vm.parseJsonString(json, ".venue"), "pons");
        assertEq(vm.parseJsonAddress(json, ".pons.factory"), d.pons.factory);
        assertEq(vm.parseJsonAddress(json, ".pons.feeEscrow"), d.pons.feeEscrow);
        assertEq(vm.parseJsonAddress(json, ".pons.memeHook"), d.pons.memeHook);
        assertEq(vm.parseJsonAddress(json, ".accountImplementation"), d.accountImplementation);
        assertEq(vm.parseJsonUint(json, ".deployedAt"), block.timestamp);
        assertFalse(vm.keyExistsJson(json, ".launchpad"));
    }

    // ---------------------------------------------------------------------------------------------
    // DeployPons
    // ---------------------------------------------------------------------------------------------

    function test_deployPons_defaultsToDeployerRoles() public {
        PonsDeployBase.Deployment memory d =
            ponsScript.deployWith(_ponsCfg("cache/deploy-pons-test.json"), DEPLOYER_KEY);
        PonsMindRegistry registry = PonsMindRegistry(payable(d.registry));
        assertEq(d.deployer, deployer);
        assertEq(registry.owner(), deployer);
        assertEq(registry.treasury(), deployer);
        assertEq(registry.computeTreasury(), deployer);
        assertEq(registry.operator(), deployer);
        assertEq(address(registry.factory()), address(factory));
        assertEq(address(registry.feeEscrow()), address(escrow));
        assertEq(address(registry.memeHook()), address(hook));
        assertEq(MindAccount(payable(d.accountImplementation)).registry(), d.registry);
        assertFalse(d.canLaunch, "public launches closed on the stand-in");
        _assertJson(d);
    }

    function test_deployPons_separateOwnerAndRoles() public {
        DeployPons.Config memory c = _ponsCfg("cache/deploy-pons-test-owner.json");
        address owner = makeAddr("multisig");
        c.roles = PonsDeployBase.Roles({
            owner: owner,
            treasury: makeAddr("treasury"),
            computeTreasury: makeAddr("computeTreasury"),
            operator: makeAddr("operator")
        });
        vm.prank(makeAddr("ponsOwner"));
        factory.setWhitelistedLauncher(vm.computeCreateAddress(deployer, vm.getNonce(deployer)), true);

        PonsDeployBase.Deployment memory d = ponsScript.deployWith(c, DEPLOYER_KEY);
        PonsMindRegistry registry = PonsMindRegistry(payable(d.registry));
        assertTrue(d.canLaunch, "whitelisted registry");
        assertEq(registry.owner(), deployer, "two-step");
        assertEq(registry.pendingOwner(), owner);
        vm.prank(owner);
        registry.acceptOwnership();
        assertEq(registry.owner(), owner);
        assertEq(registry.treasury(), c.roles.treasury);
        assertEq(registry.computeTreasury(), c.roles.computeTreasury);
        assertEq(registry.operator(), c.roles.operator);
        _assertJson(d);
    }

    function test_deployPons_refusesMissingOrCodelessPonsAddresses() public {
        DeployPons.Config memory c = _ponsCfg("cache/x.json");
        c.pons.factory = address(0);
        vm.expectRevert(abi.encodeWithSelector(DeployPons.MissingPonsAddress.selector, "PONS_FACTORY"));
        ponsScript.deployWith(c, DEPLOYER_KEY);
        c = _ponsCfg("cache/x.json");
        c.pons.feeEscrow = address(0);
        vm.expectRevert(abi.encodeWithSelector(DeployPons.MissingPonsAddress.selector, "PONS_FEE_ESCROW"));
        ponsScript.deployWith(c, DEPLOYER_KEY);
        c = _ponsCfg("cache/x.json");
        c.pons.memeHook = makeAddr("eoa");
        vm.expectRevert(
            abi.encodeWithSelector(DeployPons.PonsAddressHasNoCode.selector, "PONS_MEME_HOOK", c.pons.memeHook)
        );
        ponsScript.deployWith(c, DEPLOYER_KEY);
    }

    function test_deployPons_configFromEnv_defaults() public {
        string[5] memory vars = ["PONS_FACTORY", "PONS_FEE_ESCROW", "PONS_MEME_HOOK", "OWNER", "OPERATOR"];
        for (uint256 i; i < vars.length; ++i) {
            // The defaults are only observable when the deployment env is not set in this shell.
            if (bytes(vm.envOr(vars[i], string(""))).length > 0) vm.skip(true);
        }
        // Off mainnet nothing is assumed: deploying without PONS_* is refused.
        DeployPons.Config memory c = ponsScript.configFromEnv();
        assertEq(c.pons.factory, address(0));
        assertEq(c.pons.feeEscrow, address(0));
        assertEq(c.pons.memeHook, address(0));
        vm.expectRevert(abi.encodeWithSelector(DeployPons.MissingPonsAddress.selector, "PONS_FACTORY"));
        ponsScript.deployWith(c, DEPLOYER_KEY);

        // On 4663 the Pons V2 mainnet addresses are the defaults (SPEC §9.1).
        vm.chainId(4663);
        c = ponsScript.configFromEnv();
        assertEq(c.pons.factory, 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e);
        assertEq(c.pons.feeEscrow, 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e);
        assertEq(c.pons.memeHook, 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044);
        assertEq(c.roles.owner, address(0), "roles default to the deployer");
        // Without a fork there is no code there: still refused rather than wiring a dead address.
        vm.expectRevert(
            abi.encodeWithSelector(
                DeployPons.PonsAddressHasNoCode.selector, "PONS_FACTORY", 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e
            )
        );
        ponsScript.deployWith(c, DEPLOYER_KEY);
    }

    // ---------------------------------------------------------------------------------------------
    // DeployPonsLocal
    // ---------------------------------------------------------------------------------------------

    function test_deployPonsLocal_deploysWiredMocks_andLaunchWorks() public {
        DeployPonsLocal.Config memory c;
        c.outFile = "cache/deploy-pons-local-test.json";
        PonsDeployBase.Deployment memory d = localScript.deployWith(c, DEPLOYER_KEY);
        _assertJson(d);
        assertTrue(d.canLaunch);

        PonsMindRegistry registry = PonsMindRegistry(payable(d.registry));
        MockPonsFactory f = MockPonsFactory(payable(d.pons.factory));
        MockPonsMemeHook h = MockPonsMemeHook(d.pons.memeHook);
        assertEq(registry.owner(), deployer);
        assertEq(registry.operator(), deployer);
        assertEq(f.owner(), deployer);
        assertEq(h.factory(), d.pons.factory);
        assertEq(h.feeSweepOperator(), deployer);
        assertEq(h.protocolFeeRecipient(), deployer);
        assertEq(address(f.feeEscrow()), d.pons.feeEscrow);
        assertEq(f.launchFee(), 0.0005 ether);
        assertTrue(f.launchEnabled());
        assertEq(f.launchConfigCount(), 1);
        IPonsV2LaunchFactory.LaunchConfig memory cfg = f.getLaunchConfig(0);
        assertEq(cfg.supply, 1_000_000_000 ether);
        assertEq(cfg.curveFeeBps, 100);
        assertEq(cfg.phantomQuote, 4.2 ether);
        assertEq(cfg.graduationThreshold, 4.2 ether);
        assertTrue(cfg.enabled);

        // End to end: launch a mind with an initial buy, trade, harvest.
        address user = makeAddr("user");
        vm.deal(user, 10 ether);
        IPonsMindRegistry.LaunchParams memory p;
        p.name = "Local Mind";
        p.symbol = "LOCAL";
        p.creatorTaxBps = 100;
        p.salt = keccak256("local");
        (, uint256 total, bytes32 economics) = registry.launchQuote(0, 0.1 ether);
        p.expectedEconomics = economics;
        vm.prank(user);
        (address token,,) = registry.launchMind{value: total}(p, 0.1 ether, 0, keccak256("m"), bytes32(0), "");
        assertGt(IERC20(token).balanceOf(user), 0);
        registry.harvest(token);
        assertGt(registry.mindBalance(token), 0);
    }

    function test_deployPonsLocal_rolesAndMainnetGuard() public {
        DeployPonsLocal.Config memory c;
        c.outFile = "cache/deploy-pons-local-test-roles.json";
        c.roles.owner = makeAddr("multisig");
        c.roles.operator = makeAddr("operator");
        PonsDeployBase.Deployment memory d = localScript.deployWith(c, DEPLOYER_KEY);
        PonsMindRegistry registry = PonsMindRegistry(payable(d.registry));
        assertEq(registry.pendingOwner(), c.roles.owner);
        assertEq(registry.operator(), c.roles.operator);
        assertEq(registry.treasury(), deployer);

        vm.chainId(4663);
        vm.expectRevert(abi.encodeWithSelector(DeployPonsLocal.MockPonsNotAllowedOnMainnet.selector, 4663));
        localScript.deployWith(c, DEPLOYER_KEY);
    }

    // ---------------------------------------------------------------------------------------------
    // Curve venue
    // ---------------------------------------------------------------------------------------------

    function test_curveDeploy_writesVenueCurve() public {
        Deploy curveScript = new Deploy();
        Deploy.Config memory c;
        c.graduatorKind = "mock";
        c.feeTier = 10_000;
        c.outFile = "cache/deploy-curve-venue-test.json";
        Deploy.Deployment memory d = curveScript.deployWith(c, DEPLOYER_KEY);
        string memory json = vm.readFile(d.outFile);
        assertEq(vm.parseJsonString(json, ".venue"), "curve");
        assertEq(vm.parseJsonAddress(json, ".launchpad"), d.launchpad);
    }
}
