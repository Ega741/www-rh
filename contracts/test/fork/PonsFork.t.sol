// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PonsMindRegistry} from "../../src/PonsMindRegistry.sol";
import {IPonsMindRegistry} from "../../src/interfaces/IPonsMindRegistry.sol";
import {IPonsV2BondingCurve} from "../../src/interfaces/pons/IPonsV2BondingCurve.sol";
import {IPonsV2FeeEscrow} from "../../src/interfaces/pons/IPonsV2FeeEscrow.sol";
import {IPonsV2LaunchFactory} from "../../src/interfaces/pons/IPonsV2LaunchFactory.sol";

/// @notice Fork test of Pons mode against the live Pons V2 contracts on Robinhood Chain mainnet (SPEC §9.1). Runs only
///         when `ROBINHOOD_RPC_URL` is set (every test is skipped otherwise):
///         `ROBINHOOD_RPC_URL=https://… forge test --match-path test/fork/PonsFork.t.sol -vv`.
///         It checks that the local interfaces decode the live contracts (struct layouts included), then launches a
///         mind through a fresh registry (whitelisting it with the factory owner's key when public launches are
///         closed), trades on the real curve, harvests, leaves, and runs an adoption with a takeover (SPEC §9.7).
contract PonsForkTest is Test {
    address internal constant FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address internal constant FEE_ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address internal constant MEME_HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;

    IPonsV2LaunchFactory internal factory = IPonsV2LaunchFactory(FACTORY);
    PonsMindRegistry internal registry;
    bool internal forked;

    address internal creator = makeAddr("forkCreator");
    address internal trader = makeAddr("forkTrader");
    address internal operator = makeAddr("forkOperator");

    function setUp() public {
        string memory rpc = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
        registry = new PonsMindRegistry(
            address(this), makeAddr("treasury"), makeAddr("computeTreasury"), operator, FACTORY, FEE_ESCROW, MEME_HOOK
        );
        vm.deal(creator, 10 ether);
        vm.deal(trader, 10 ether);
    }

    modifier onlyFork() {
        if (!forked) vm.skip(true, "ROBINHOOD_RPC_URL not set");
        _;
    }

    function test_fork_interfacesDecodeLiveContracts() public onlyFork {
        assertEq(block.chainid, 4663);
        uint256 launchFee = factory.launchFee();
        IPonsV2LaunchFactory.LaunchConfig memory cfg = factory.getLaunchConfig(0);
        bytes32 economics = factory.previewLaunchEconomics(0, address(0));
        console2.log("launchFee", launchFee);
        console2.log("config0 supply / curveFeeBps", cfg.supply, cfg.curveFeeBps);
        console2.log("config0 phantom / threshold", cfg.phantomQuote, cfg.graduationThreshold);
        console2.log("maxCreatorTaxBps / snipeTaxSeconds", factory.maxCreatorTaxBps(), factory.snipeTaxSeconds());
        console2.log("launchEnabled", factory.launchEnabled());
        (uint256 fee, uint256 total, bytes32 quoted) = registry.launchQuote(0, 1 ether);
        assertEq(fee, launchFee);
        assertEq(total, launchFee + 1 ether);
        assertEq(quoted, economics);
        assertEq(IPonsV2FeeEscrow(FEE_ESCROW).balanceOf(address(registry)), 0);
    }

    function test_fork_launchTradeHarvest() public onlyFork {
        _ensureCanLaunch(address(registry));
        IPonsMindRegistry.LaunchParams memory p;
        p.name = "Fork Mind";
        p.symbol = "FORK";
        p.creatorTaxBps = 100;
        p.salt = keccak256(abi.encode("fork", block.timestamp));
        p.launchConfigId = 0;
        (, uint256 total, bytes32 economics) = registry.launchQuote(0, 0.01 ether);
        p.expectedEconomics = economics;

        vm.prank(creator);
        (address token, address curve, address account) =
            registry.launchMind{value: total}(p, 0.01 ether, 0, keccak256("claude"), bytes32(0), "");
        assertGt(IERC20(token).balanceOf(creator), 0, "initial buy delivered");
        assertEq(address(registry).balance, 0, "no ETH left behind");

        IPonsV2LaunchFactory.LaunchedToken memory lt = factory.getLaunchedToken(token);
        assertTrue(lt.exists);
        assertEq(lt.curve, curve);
        assertEq(lt.deployer, address(registry));
        assertEq(lt.creatorFeeRecipient, account);
        assertEq(lt.pairToken, address(0));
        assertFalse(lt.buybackEnabled);
        assertEq(lt.creatorTaxBps, 100);
        assertEq(uint8(lt.phase), uint8(IPonsV2LaunchFactory.GraduationPhase.NotGraduated));

        // Trade after the snipe window, then harvest: report which sweep path the live curve accepts.
        vm.warp(block.timestamp + factory.snipeTaxSeconds() + 1);
        vm.prank(trader);
        IPonsV2BondingCurve(curve).buy{value: 0.5 ether}(0.5 ether, 0, trader);
        vm.recordLogs();
        registry.harvest(token);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(registry) && logs[i].topics[0] == IPonsMindRegistry.SweepAttempted.selector)
            {
                (bool curveSwept, bool poolSwept) = abi.decode(logs[i].data, (bool, bool));
                console2.log("curveSwept / poolSwept", curveSwept, poolSwept);
                if (curveSwept) assertGt(registry.mindBalance(token), 0, "creator fees reached the vault");
            }
        }
        assertEq(registry.claimable(token), 0);
        assertEq(address(registry).balance, registry.mindBalance(token) + registry.protocolBalance());
        // Pool id the live hook will register at graduation (SPEC §9.7 derivation, checked against PoolRegistered
        // when a graduated launch is available).
        console2.logBytes32(registry.derivedPoolId(token));

        vm.prank(creator);
        registry.leave(token, creator);
        assertEq(factory.getLaunchedToken(token).creatorFeeRecipient, creator);
        assertTrue(registry.hasLeft(token));
    }

    function test_fork_adoption() public onlyFork {
        _ensureCanLaunch(creator);
        IPonsV2LaunchFactory.TokenParams memory tp;
        tp.name = "Fork Wild";
        tp.symbol = "FWILD";
        tp.salt = keccak256(abi.encode("forkwild", block.timestamp));
        uint256 launchFee = factory.launchFee();
        vm.startPrank(creator);
        (address token,) = factory.launchToken{value: launchFee}(tp, 0, address(0), new address[](0));
        address account = registry.prepareAdoption(token, keccak256("claude"), bytes32(0), "");
        assertEq(account, registry.predictAdoptionAccount(token, creator));
        assertFalse(registry.isMind(token), "registered only at activation");
        factory.transferCreatorFeeRecipient(token, account);
        vm.stopPrank();
        registry.activateAdoption(token, creator);
        assertTrue(registry.ponsMind(token).adopted);
        assertEq(registry.getMind(token).creator, creator);
        assertEq(factory.getLaunchedToken(token).creatorFeeRecipient, account);

        // Leave (harvests first), then the new recipient takes over with its own account.
        address heir = makeAddr("forkHeir");
        vm.prank(creator);
        registry.leave(token, heir);
        assertTrue(registry.hasLeft(token));
        vm.prank(heir);
        address heirAccount = registry.prepareAdoption(token, keccak256("claude"), bytes32(0), "");
        vm.prank(heir);
        factory.transferCreatorFeeRecipient(token, heirAccount);
        registry.activateAdoption(token, heir);
        assertEq(registry.getMind(token).creator, heir);
        assertEq(registry.accountOf(token), heirAccount);
        assertFalse(registry.hasLeft(token));
    }

    /// @dev Whitelists `launcher` with the factory owner's key when public launches are closed.
    function _ensureCanLaunch(address launcher) internal {
        if (factory.canLaunch(launcher)) return;
        (bool ok, bytes memory ret) = FACTORY.staticcall(abi.encodeWithSignature("owner()"));
        require(ok && ret.length >= 32, "owner()");
        vm.prank(abi.decode(ret, (address)));
        (ok,) = FACTORY.call(abi.encodeWithSignature("setWhitelistedLauncher(address,bool)", launcher, true));
        require(ok && factory.canLaunch(launcher), "whitelist");
    }
}
