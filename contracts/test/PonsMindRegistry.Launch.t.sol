// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {PonsMindRegistry} from "../src/PonsMindRegistry.sol";
import {MindAccount} from "../src/MindAccount.sol";
import {IMindCore} from "../src/interfaces/IMindCore.sol";
import {IPonsMindRegistry} from "../src/interfaces/IPonsMindRegistry.sol";
import {IPonsV2BondingCurve} from "../src/interfaces/pons/IPonsV2BondingCurve.sol";
import {IPonsV2LaunchFactory} from "../src/interfaces/pons/IPonsV2LaunchFactory.sol";
import {MockPonsCurve} from "./mocks/pons/MockPonsCurve.sol";
import {MockPonsFactory} from "./mocks/pons/MockPonsFactory.sol";
import {MockPonsLaunchDeployer} from "./mocks/pons/MockPonsLaunchDeployer.sol";
import {PonsBaseTest} from "./utils/PonsBaseTest.sol";

/// @notice Factory stand-in returning configurable launch results, to reach {IPonsMindRegistry.LaunchFailed}.
contract FakeLaunchFactory {
    address public tokenOut;
    address public curveOut;

    function set(address token_, address curve_) external {
        tokenOut = token_;
        curveOut = curve_;
    }

    function launchFee() external pure returns (uint256) {
        return 0;
    }

    function launchToken(IPonsV2LaunchFactory.TokenParams calldata, uint256, address, address[] calldata)
        external
        payable
        returns (address, address)
    {
        return (tokenOut, curveOut);
    }
}

/// @notice SPEC §9.2 launchMind: value accounting, account clones, Pons launch parameters (recipient, buyback off,
///         native quote, exemptions), registration and events, initial buy with refund forwarding, creation fee,
///         economics guard, canLaunch / launch fee gating, validation and pause.
contract PonsMindRegistryLaunchTest is PonsBaseTest {
    // ---------------------------------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------------------------------

    function test_constructor_initialState() public view {
        assertEq(registry.owner(), owner);
        assertEq(registry.treasury(), treasury);
        assertEq(registry.computeTreasury(), computeTreasury);
        assertEq(registry.operator(), operator);
        assertEq(address(registry.factory()), address(factory));
        assertEq(address(registry.feeEscrow()), address(escrow));
        assertEq(address(registry.memeHook()), address(hook));
        assertEq(registry.mindFeeBps(), 0);
        assertEq(registry.creationFee(), 0);
        (uint256 maxPerEpoch, uint32 epochSeconds) = registry.drawLimit();
        assertEq(maxPerEpoch, 0.25 ether);
        assertEq(epochSeconds, 1 days);
        assertEq(registry.mindsLength(), 0);
        assertFalse(registry.paused());
        MindAccount impl = MindAccount(payable(registry.accountImplementation()));
        assertEq(impl.registry(), address(registry), "implementation bound to its registry");
    }

    function test_constructor_emitsAndValidates() public {
        vm.expectEmit(false, false, false, true);
        emit IMindCore.TreasuryUpdated(treasury);
        vm.expectEmit(false, false, false, true);
        emit IMindCore.ComputeTreasuryUpdated(computeTreasury);
        vm.expectEmit(false, false, false, true);
        emit IMindCore.OperatorUpdated(operator);
        vm.expectEmit(false, false, false, true);
        emit IMindCore.DrawLimitUpdated(0.25 ether, 1 days);
        vm.expectEmit(false, false, false, true);
        emit IPonsMindRegistry.MindFeeUpdated(0);
        new PonsMindRegistry(
            owner, treasury, computeTreasury, operator, address(factory), address(escrow), address(hook)
        );

        address f = address(factory);
        address e = address(escrow);
        address h = address(hook);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new PonsMindRegistry(address(0), treasury, computeTreasury, operator, f, e, h);
        vm.expectRevert(IMindCore.ZeroAddress.selector);
        new PonsMindRegistry(owner, address(0), computeTreasury, operator, f, e, h);
        vm.expectRevert(IMindCore.ZeroAddress.selector);
        new PonsMindRegistry(owner, treasury, address(0), operator, f, e, h);
        vm.expectRevert(IMindCore.ZeroAddress.selector);
        new PonsMindRegistry(owner, treasury, computeTreasury, address(0), f, e, h);
        vm.expectRevert(IMindCore.ZeroAddress.selector);
        new PonsMindRegistry(owner, treasury, computeTreasury, operator, address(0), e, h);
        vm.expectRevert(IMindCore.ZeroAddress.selector);
        new PonsMindRegistry(owner, treasury, computeTreasury, operator, f, address(0), h);
        vm.expectRevert(IMindCore.ZeroAddress.selector);
        new PonsMindRegistry(owner, treasury, computeTreasury, operator, f, e, address(0));
    }

    function test_accountImplementation_cannotBeInitializedOrUsed() public {
        MindAccount impl = MindAccount(payable(registry.accountImplementation()));
        vm.expectRevert(MindAccount.AlreadyInitialized.selector);
        impl.initialize(stranger);
        vm.prank(stranger);
        vm.expectRevert(MindAccount.NotRegistry.selector);
        impl.claim(escrow);
    }

    // ---------------------------------------------------------------------------------------------
    // launchMind: records, Pons parameters, events
    // ---------------------------------------------------------------------------------------------

    function test_launchMind_noBuy_registersEverything() public {
        address predicted = registry.predictAccount(creator, SALT);
        uint256 protocolBefore = ponsProtocol.balance;
        uint256 creatorBefore = creator.balance;

        (address token, address curve, address account) = _launch(creator, 0);

        assertEq(account, predicted, "account at predicted address");
        assertEq(creatorBefore - creator.balance, LAUNCH_FEE, "msg.value == launchFee");
        assertEq(ponsProtocol.balance - protocolBefore, LAUNCH_FEE, "launch fee paid to Pons");
        assertEq(address(registry).balance, 0);

        // Registry records.
        assertTrue(registry.isMind(token));
        assertEq(registry.mindsLength(), 1);
        assertEq(registry.mindAt(0), token);
        IMindCore.MindInfo memory info = registry.getMind(token);
        assertEq(info.creator, creator);
        assertEq(info.modelId, MODEL_ID);
        assertEq(info.personaHash, PERSONA_HASH);
        assertEq(info.metadataURI, METADATA_URI);
        assertEq(info.createdAt, block.timestamp);
        assertEq(uint8(info.status), uint8(IMindCore.MindStatus.Alive));
        IPonsMindRegistry.PonsMind memory m = registry.ponsMind(token);
        assertEq(m.curve, curve);
        assertEq(m.account, account);
        assertEq(m.launchConfigId, 0);
        assertTrue(m.launchedHere);
        assertFalse(m.adopted);
        assertEq(registry.accountOf(token), account);
        assertEq(registry.tokenOf(account), token);
        assertEq(registry.poolIdOf(token), bytes32(0));
        assertEq(MindAccount(payable(account)).registry(), address(registry));

        // Pons launch record: account is the creator fee recipient, registry the deployer, native quote, no buyback.
        IPonsV2LaunchFactory.LaunchedToken memory lt = factory.getLaunchedToken(token);
        assertTrue(lt.exists);
        assertEq(lt.token, token);
        assertEq(lt.curve, curve);
        assertEq(lt.deployer, address(registry));
        assertEq(lt.creatorFeeRecipient, account);
        assertEq(lt.pairToken, address(0));
        assertEq(lt.creatorTaxBps, TAX_BPS);
        assertFalse(lt.buybackEnabled);
        assertEq(uint8(lt.phase), uint8(IPonsV2LaunchFactory.GraduationPhase.NotGraduated));
        assertEq(MockPonsCurve(curve).deployer(), account, "curve pays creator fees to the account");
        assertFalse(MockPonsCurve(curve).buybackEnabled());
        assertEq(MockPonsCurve(curve).creatorTaxBps(), TAX_BPS);
        assertEq(IERC20(token).balanceOf(curve), SUPPLY);

        // Snipe-tax exemptions: Pons exempts the launching account (registry) and the recipient (account); the
        // registry adds the human creator.
        assertTrue(MockPonsCurve(curve).snipeTaxExempt(address(registry)));
        assertTrue(MockPonsCurve(curve).snipeTaxExempt(account));
        assertTrue(MockPonsCurve(curve).snipeTaxExempt(creator));
        assertFalse(MockPonsCurve(curve).snipeTaxExempt(stranger));
    }

    function test_launchMind_events() public {
        address account = registry.predictAccount(creator, SALT);
        vm.recordLogs();
        (address token, address curve,) = _launch(creator, 0);
        // Exact event content (the token address is only known afterwards, so check the recorded logs).
        bytes32 createdTopic = IMindCore.MindCreated.selector;
        bytes32 launchedTopic = IPonsMindRegistry.MindLaunched.selector;
        bytes32 tokenLaunchedTopic = IPonsV2LaunchFactory.TokenLaunched.selector;
        bool sawCreated;
        bool sawLaunched;
        bool sawTokenLaunched;
        uint256 createdIndex;
        uint256 launchedIndex;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(registry) && logs[i].topics[0] == createdTopic) {
                sawCreated = true;
                createdIndex = i;
                assertEq(logs[i].topics[1], bytes32(uint256(uint160(token))));
                assertEq(logs[i].topics[2], bytes32(uint256(uint160(creator))));
                (string memory name, string memory symbol, string memory uri, bytes32 model, bytes32 persona) =
                    abi.decode(logs[i].data, (string, string, string, bytes32, bytes32));
                assertEq(name, "Mind One");
                assertEq(symbol, "MIND");
                assertEq(uri, METADATA_URI);
                assertEq(model, MODEL_ID);
                assertEq(persona, PERSONA_HASH);
            } else if (logs[i].emitter == address(registry) && logs[i].topics[0] == launchedTopic) {
                sawLaunched = true;
                launchedIndex = i;
                assertEq(logs[i].topics[1], bytes32(uint256(uint160(token))));
                assertEq(logs[i].topics[2], bytes32(uint256(uint160(curve))));
                assertEq(logs[i].topics[3], bytes32(uint256(uint160(account))));
                (address c, uint256 configId) = abi.decode(logs[i].data, (address, uint256));
                assertEq(c, creator);
                assertEq(configId, 0);
            } else if (logs[i].emitter == address(factory) && logs[i].topics[0] == tokenLaunchedTopic) {
                sawTokenLaunched = true;
                assertEq(logs[i].topics[3], bytes32(uint256(uint160(address(registry)))), "Pons deployer");
            }
        }
        assertTrue(sawCreated && sawLaunched && sawTokenLaunched);
        assertLt(createdIndex, launchedIndex, "MindCreated before MindLaunched");
    }

    function test_launchMind_creationFee_toProtocolBalance() public {
        vm.prank(owner);
        registry.setCreationFee(0.01 ether);
        IPonsMindRegistry.LaunchParams memory p = _params(SALT);
        address account = registry.predictAccount(creator, SALT);

        vm.prank(creator);
        vm.expectRevert(IPonsMindRegistry.WrongValue.selector);
        registry.launchMind{value: LAUNCH_FEE}(p, 0, 0, MODEL_ID, PERSONA_HASH, METADATA_URI);

        vm.recordLogs();
        (address token,,) = _launch(creator, 0);
        assertEq(registry.protocolBalance(), 0.01 ether);
        assertEq(address(registry).balance, 0.01 ether);
        assertEq(registry.mindBalance(token), 0);
        bool sawFee;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(registry) && logs[i].topics[0] == IMindCore.FeeAccrued.selector) {
                sawFee = true;
                (uint256 mindAmount, uint256 protocolAmount) = abi.decode(logs[i].data, (uint256, uint256));
                assertEq(mindAmount, 0);
                assertEq(protocolAmount, 0.01 ether);
            }
        }
        assertTrue(sawFee);
        assertEq(registry.accountOf(token), account);
        _assertSolvent();
    }

    function test_launchMind_wrongValue() public {
        IPonsMindRegistry.LaunchParams memory p = _params(SALT);
        vm.startPrank(creator);
        vm.expectRevert(IPonsMindRegistry.WrongValue.selector);
        registry.launchMind{value: LAUNCH_FEE - 1}(p, 0, 0, MODEL_ID, PERSONA_HASH, METADATA_URI);
        vm.expectRevert(IPonsMindRegistry.WrongValue.selector);
        registry.launchMind{value: LAUNCH_FEE + 1}(p, 0, 0, MODEL_ID, PERSONA_HASH, METADATA_URI);
        vm.expectRevert(IPonsMindRegistry.WrongValue.selector);
        registry.launchMind{value: LAUNCH_FEE + 1 ether - 1}(p, 1 ether, 0, MODEL_ID, PERSONA_HASH, METADATA_URI);
        vm.expectRevert(IPonsMindRegistry.WrongValue.selector);
        registry.launchMind{value: 0}(p, 0, 0, MODEL_ID, PERSONA_HASH, METADATA_URI);
        vm.stopPrank();
    }

    function test_launchMind_followsLiveLaunchFee() public {
        vm.prank(ponsOwner);
        factory.setLaunchFee(0.001 ether);
        IPonsMindRegistry.LaunchParams memory p = _params(SALT);
        vm.prank(creator);
        vm.expectRevert(IPonsMindRegistry.WrongValue.selector);
        registry.launchMind{value: LAUNCH_FEE}(p, 0, 0, MODEL_ID, PERSONA_HASH, METADATA_URI);
        (uint256 launchFee, uint256 total,) = registry.launchQuote(0, 0);
        assertEq(launchFee, 0.001 ether);
        assertEq(total, 0.001 ether);
        _launch(creator, 0);
        // Zero launch fee works too.
        vm.prank(ponsOwner);
        factory.setLaunchFee(0);
        _launchWith(creator, _params(keccak256("other")), 0, 0);
    }

    function test_launchQuote() public {
        vm.prank(owner);
        registry.setCreationFee(0.02 ether);
        (uint256 launchFee, uint256 total, bytes32 economics) = registry.launchQuote(0, 1 ether);
        assertEq(launchFee, LAUNCH_FEE);
        assertEq(total, LAUNCH_FEE + 1 ether + 0.02 ether);
        assertEq(economics, factory.previewLaunchEconomics(0, address(0)));
        vm.expectRevert(MockPonsFactory.InvalidLaunchConfigId.selector);
        registry.launchQuote(7, 0);
    }

    // ---------------------------------------------------------------------------------------------
    // Initial buy and refunds
    // ---------------------------------------------------------------------------------------------

    function test_launchMind_initialBuy_tokensToCreator_noSnipeTax() public {
        uint256 creatorBefore = creator.balance;
        (address token, address curve,) = _launch(creator, 1 ether);

        // Same outcome as an untaxed buy of 1 ETH on a fresh curve: fee 1 %, tax 2 %, constant product.
        uint256 net = 1 ether - 0.01 ether - 0.02 ether;
        uint256 expectedOut = net * SUPPLY / (PHANTOM + net);
        assertEq(IERC20(token).balanceOf(creator), expectedOut, "tokens to the creator, untaxed");
        assertEq(IERC20(token).balanceOf(address(registry)), 0);
        assertEq(creatorBefore - creator.balance, LAUNCH_FEE + 1 ether);
        assertEq(MockPonsCurve(curve).quoteFeeBalance(), 0.01 ether);
        assertEq(MockPonsCurve(curve).creatorTaxBalance(), 0.02 ether);
        assertEq(MockPonsCurve(curve).realQuoteReserve(), net);
        assertEq(address(registry).balance, 0);
    }

    function test_launchMind_initialBuy_crossingThreshold_refundForwardedAndGraduates() public {
        uint256 creatorBefore = creator.balance;
        address predictedAccount = registry.predictAccount(creator, SALT);
        vm.recordLogs();
        (address token, address curve, address account) = _launch(creator, 10 ether);
        assertEq(account, predictedAccount);

        // The curve capped the buy at the sellable allocation, refunded the registry, which forwarded it.
        uint256 refund;
        uint256 spent;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != curve) continue;
            if (logs[i].topics[0] == IPonsV2BondingCurve.CurveBuyRefunded.selector) {
                assertEq(logs[i].topics[1], bytes32(uint256(uint160(address(registry)))), "refund to registry");
                refund = abi.decode(logs[i].data, (uint256));
            } else if (logs[i].topics[0] == IPonsV2BondingCurve.CurveBuy.selector) {
                (spent,,,) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
            }
        }
        assertGt(refund, 0, "refund happened");
        assertEq(spent + refund, 10 ether);
        assertEq(creatorBefore - creator.balance, LAUNCH_FEE + spent, "refund forwarded to the creator");
        assertEq(address(registry).balance, 0, "registry keeps nothing");
        assertEq(IERC20(token).balanceOf(creator), SUPPLY - SUPPLY * PHANTOM / (PHANTOM + THRESHOLD));

        // Auto-graduation in the crossing buy: curve drained into the factory, creator fees credited to the account.
        assertTrue(MockPonsCurve(curve).graduated());
        assertEq(uint8(_phase(token)), uint8(IPonsV2LaunchFactory.GraduationPhase.Swept));
        assertGt(escrow.balanceOf(account), 0, "graduation sweep credited the account");
        assertEq(registry.claimable(token), escrow.balanceOf(account));
    }

    function test_launchMind_initialBuy_slippage() public {
        IPonsMindRegistry.LaunchParams memory p = _params(SALT);
        uint256 value = LAUNCH_FEE + 1 ether;
        vm.prank(creator);
        vm.expectPartialRevert(MockPonsCurve.SlippageExceeded.selector);
        registry.launchMind{value: value}(p, 1 ether, type(uint128).max, MODEL_ID, PERSONA_HASH, METADATA_URI);
        assertEq(registry.mindsLength(), 0, "nothing registered");
    }

    function test_launchMind_refundToRejectingCreator_reverts() public {
        RejectingCreator c = new RejectingCreator(registry);
        vm.deal(address(c), 20 ether);
        IPonsMindRegistry.LaunchParams memory p = _params(SALT);
        vm.expectRevert(IMindCore.EthTransferFailed.selector);
        c.launch{value: LAUNCH_FEE + 10 ether}(p, 10 ether);
        // Without a refund it works.
        c.launch{value: LAUNCH_FEE + 1 ether}(p, 1 ether);
    }

    function testFuzz_launchMind_valueAccounting(uint256 quoteIn, uint256 creationFee, bool exactEconomics) public {
        quoteIn = bound(quoteIn, 0, 20 ether);
        if (quoteIn != 0 && quoteIn < 1e9) quoteIn = 1e9;
        creationFee = bound(creationFee, 0, 1 ether);
        vm.prank(owner);
        registry.setCreationFee(creationFee);
        IPonsMindRegistry.LaunchParams memory p = _params(SALT);
        if (exactEconomics) p.expectedEconomics = factory.previewLaunchEconomics(0, address(0));

        uint256 creatorBefore = creator.balance;
        uint256 protocolBefore = ponsProtocol.balance;
        uint256 heldBefore = address(factory).balance + address(escrow).balance;
        (address token, address curve,) = _launchWith(creator, p, quoteIn, 0);

        uint256 paid = creatorBefore - creator.balance;
        uint256 held = address(factory).balance + address(escrow).balance + curve.balance - heldBefore;
        assertEq(paid, (ponsProtocol.balance - protocolBefore) + registry.protocolBalance() + held, "ETH conserved");
        assertEq(registry.protocolBalance(), creationFee);
        assertEq(address(registry).balance, creationFee, "only the creation fee stays");
        assertLe(paid, LAUNCH_FEE + quoteIn + creationFee);
        if (quoteIn > 0) assertGt(IERC20(token).balanceOf(creator), 0);
        assertEq(IERC20(token).balanceOf(address(registry)), 0);
        _assertSolvent();
    }

    // ---------------------------------------------------------------------------------------------
    // Snipe tax exemptions
    // ---------------------------------------------------------------------------------------------

    function test_exemptions_creatorUntaxed_strangerTaxedDuringWindow() public {
        (, address curve,) = _launch(creator, 0);
        MockPonsCurve c = MockPonsCurve(curve);
        assertEq(c.currentSnipeTaxBps(creator), 0);
        assertGt(c.currentSnipeTaxBps(stranger), 9000, "a non-exempt buyer pays ~99 % in the launch second");

        uint256 strangerOut = c.quoteBuy(1 ether, stranger).tokensOut;
        uint256 creatorOut = c.quoteBuy(1 ether, creator).tokensOut;
        assertLt(strangerOut * 10, creatorOut, "sniper gets a fraction");
        uint256 got = _buy(stranger, curve, 1 ether);
        assertEq(got, strangerOut);

        vm.warp(block.timestamp + 15);
        assertEq(c.currentSnipeTaxBps(stranger), 0, "tax gone after snipeTaxSeconds");
    }

    // ---------------------------------------------------------------------------------------------
    // Economics guard, gating, validation
    // ---------------------------------------------------------------------------------------------

    function test_economicsGuard() public {
        IPonsMindRegistry.LaunchParams memory p = _params(SALT);
        bytes32 quoted = factory.previewLaunchEconomics(0, address(0));
        p.expectedEconomics = quoted;
        _launchWith(creator, p, 0, 0);

        // Pons re-pegs the policy between quote and launch: the pinned digest no longer matches.
        vm.prank(ponsOwner);
        hook.setHookFeeBps(150);
        bytes32 actual = factory.previewLaunchEconomics(0, address(0));
        assertTrue(actual != quoted);
        p.salt = keccak256("second");
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(MockPonsFactory.LaunchEconomicsMismatch.selector, quoted, actual));
        registry.launchMind{value: LAUNCH_FEE}(p, 0, 0, MODEL_ID, PERSONA_HASH, METADATA_URI);
        // Re-quoting (as the web does right before sending) or waiving the guard works.
        p.expectedEconomics = actual;
        _launchWith(creator, p, 0, 0);
        p.salt = keccak256("third");
        p.expectedEconomics = bytes32(0);
        _launchWith(creator, p, 0, 0);
        assertEq(registry.mindsLength(), 3);
    }

    function test_canLaunchGating() public {
        vm.prank(ponsOwner);
        factory.setLaunchEnabled(false);
        assertFalse(factory.canLaunch(address(registry)));
        IPonsMindRegistry.LaunchParams memory p = _params(SALT);
        vm.prank(creator);
        vm.expectRevert(MockPonsFactory.NotWhitelisted.selector);
        registry.launchMind{value: LAUNCH_FEE}(p, 0, 0, MODEL_ID, PERSONA_HASH, METADATA_URI);

        // Whitelisting the creator does not help: Pons gates its caller, the registry.
        vm.prank(ponsOwner);
        factory.setWhitelistedLauncher(creator, true);
        vm.prank(creator);
        vm.expectRevert(MockPonsFactory.NotWhitelisted.selector);
        registry.launchMind{value: LAUNCH_FEE}(p, 0, 0, MODEL_ID, PERSONA_HASH, METADATA_URI);

        vm.prank(ponsOwner);
        factory.setWhitelistedLauncher(address(registry), true);
        _launch(creator, 0);
    }

    function test_launchMind_accountSaltRules() public {
        _launch(creator, 0);
        IPonsMindRegistry.LaunchParams memory p = _params(SALT);
        vm.prank(creator);
        vm.expectRevert(IPonsMindRegistry.AccountExists.selector);
        registry.launchMind{value: LAUNCH_FEE}(p, 0, 0, MODEL_ID, PERSONA_HASH, METADATA_URI);
        // Another creator may reuse the salt: different account, hence a different Pons token.
        (address token2,, address account2) = _launch(alice, 0);
        assertEq(account2, registry.predictAccount(alice, SALT));
        assertEq(registry.tokenOf(account2), token2);
        assertEq(registry.mindsLength(), 2);
    }

    function test_launchMind_validation() public {
        IPonsMindRegistry.LaunchParams memory p = _params(SALT);
        vm.startPrank(creator);
        p.name = "";
        vm.expectRevert(IMindCore.InvalidName.selector);
        registry.launchMind{value: LAUNCH_FEE}(p, 0, 0, MODEL_ID, PERSONA_HASH, METADATA_URI);
        p.name = string(new bytes(65));
        vm.expectRevert(IMindCore.InvalidName.selector);
        registry.launchMind{value: LAUNCH_FEE}(p, 0, 0, MODEL_ID, PERSONA_HASH, METADATA_URI);
        p.name = "Mind One";
        p.symbol = "";
        vm.expectRevert(IMindCore.InvalidSymbol.selector);
        registry.launchMind{value: LAUNCH_FEE}(p, 0, 0, MODEL_ID, PERSONA_HASH, METADATA_URI);
        p.symbol = string(new bytes(17));
        vm.expectRevert(IMindCore.InvalidSymbol.selector);
        registry.launchMind{value: LAUNCH_FEE}(p, 0, 0, MODEL_ID, PERSONA_HASH, METADATA_URI);
        p.symbol = "MIND";
        vm.expectRevert(IMindCore.MetadataTooLong.selector);
        registry.launchMind{value: LAUNCH_FEE}(p, 0, 0, MODEL_ID, PERSONA_HASH, string(new bytes(2049)));
        vm.expectRevert(IMindCore.InvalidModel.selector);
        registry.launchMind{value: LAUNCH_FEE}(p, 0, 0, bytes32(0), PERSONA_HASH, METADATA_URI);
        // Pons-side checks bubble up.
        p.creatorTaxBps = 1001;
        vm.expectRevert(MockPonsFactory.CreatorTaxTooHigh.selector);
        registry.launchMind{value: LAUNCH_FEE}(p, 0, 0, MODEL_ID, PERSONA_HASH, METADATA_URI);
        p.creatorTaxBps = TAX_BPS;
        p.logo = string(new bytes(513));
        vm.expectRevert(MockPonsLaunchDeployer.MetadataTooLong.selector);
        registry.launchMind{value: LAUNCH_FEE}(p, 0, 0, MODEL_ID, PERSONA_HASH, METADATA_URI);
        p.logo = "";
        p.launchConfigId = 1;
        vm.expectRevert(MockPonsFactory.InvalidLaunchConfigId.selector);
        registry.launchMind{value: LAUNCH_FEE}(p, 0, 0, MODEL_ID, PERSONA_HASH, METADATA_URI);
        vm.stopPrank();
        // Boundaries accepted.
        p.launchConfigId = 0;
        p.name = string(new bytes(64));
        p.symbol = string(new bytes(16));
        vm.prank(creator);
        registry.launchMind{value: LAUNCH_FEE}(p, 0, 0, MODEL_ID, PERSONA_HASH, string(new bytes(2048)));
    }

    function test_launchMind_disabledConfig() public {
        IPonsV2LaunchFactory.LaunchConfig memory cfg = factory.getLaunchConfig(0);
        cfg.enabled = false;
        vm.prank(ponsOwner);
        factory.updateLaunchConfig(0, cfg);
        IPonsMindRegistry.LaunchParams memory p = _params(SALT);
        vm.prank(creator);
        vm.expectRevert(MockPonsFactory.LaunchConfigDisabled.selector);
        registry.launchMind{value: LAUNCH_FEE}(p, 0, 0, MODEL_ID, PERSONA_HASH, METADATA_URI);
    }

    function test_launchMind_launchFailed() public {
        FakeLaunchFactory fake = new FakeLaunchFactory();
        PonsMindRegistry r = new PonsMindRegistry(
            owner, treasury, computeTreasury, operator, address(fake), address(escrow), address(hook)
        );
        IPonsMindRegistry.LaunchParams memory p = _params(SALT);
        vm.prank(creator);
        vm.expectRevert(IPonsMindRegistry.LaunchFailed.selector);
        r.launchMind(p, 0, 0, MODEL_ID, PERSONA_HASH, METADATA_URI);

        // A token that already has a mind.
        fake.set(address(0xBEEF), address(0xCAFE));
        vm.prank(creator);
        r.launchMind(p, 0, 0, MODEL_ID, PERSONA_HASH, METADATA_URI);
        p.salt = keccak256("again");
        vm.prank(creator);
        vm.expectRevert(IPonsMindRegistry.LaunchFailed.selector);
        r.launchMind(p, 0, 0, MODEL_ID, PERSONA_HASH, METADATA_URI);
    }

    function test_pause_blocksLaunchAndAdoptionOnly() public {
        (address token,,) = _launch(creator, 0);
        vm.prank(owner);
        registry.pause();
        IPonsMindRegistry.LaunchParams memory p = _params(keccak256("x"));
        vm.prank(creator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        registry.launchMind{value: LAUNCH_FEE}(p, 0, 0, MODEL_ID, PERSONA_HASH, METADATA_URI);
        (address wild,) = _launchDirect(alice, alice, keccak256("wild"), false);
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        registry.prepareAdoption(wild, MODEL_ID, PERSONA_HASH, METADATA_URI);

        // Everything else keeps working.
        vm.prank(alice);
        registry.fundMind{value: 1 ether}(token);
        _harvest(token);
        vm.prank(operator);
        registry.drawCompute(token, 0.1 ether, bytes32(0));
        vm.prank(creator);
        registry.setCreatorPaused(token, true);

        vm.prank(owner);
        registry.unpause();
        vm.prank(creator);
        registry.launchMind{value: LAUNCH_FEE}(p, 0, 0, MODEL_ID, PERSONA_HASH, METADATA_URI);
    }
}

/// @notice A creator contract that rejects ETH (so a forwarded refund fails).
contract RejectingCreator {
    PonsMindRegistry internal immutable registry;

    constructor(PonsMindRegistry registry_) {
        registry = registry_;
    }

    function launch(IPonsMindRegistry.LaunchParams calldata p, uint256 quoteIn) external payable {
        registry.launchMind{value: msg.value}(p, quoteIn, 0, keccak256("m"), bytes32(0), "");
    }
}
