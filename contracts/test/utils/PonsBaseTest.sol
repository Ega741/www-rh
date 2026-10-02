// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PonsMindRegistry} from "../../src/PonsMindRegistry.sol";
import {MindAccount} from "../../src/MindAccount.sol";
import {IMindCore} from "../../src/interfaces/IMindCore.sol";
import {IPonsMindRegistry} from "../../src/interfaces/IPonsMindRegistry.sol";
import {IPonsV2LaunchFactory} from "../../src/interfaces/pons/IPonsV2LaunchFactory.sol";
import {MockPonsCurve} from "../mocks/pons/MockPonsCurve.sol";
import {MockPonsFactory} from "../mocks/pons/MockPonsFactory.sol";
import {MockPonsFeeEscrow} from "../mocks/pons/MockPonsFeeEscrow.sol";
import {MockPonsMemeHook} from "../mocks/pons/MockPonsMemeHook.sol";

/// @notice Shared fixture for the Pons mode suites: the Pons mocks (factory with one enabled mainnet-like launch
///         config, escrow, hook) and a {PonsMindRegistry} wired to them, funded actors and helpers.
abstract contract PonsBaseTest is Test {
    PonsMindRegistry internal registry;
    MockPonsFactory internal factory;
    MockPonsFeeEscrow internal escrow;
    MockPonsMemeHook internal hook;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal computeTreasury = makeAddr("computeTreasury");
    address internal operator = makeAddr("operator");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal stranger = makeAddr("stranger");
    address internal ponsOwner = makeAddr("ponsOwner");
    address internal ponsProtocol = makeAddr("ponsProtocol");
    address internal ponsOperator = makeAddr("ponsOperator");

    bytes32 internal constant MODEL_ID = keccak256("claude-opus-5-5");
    bytes32 internal constant PERSONA_HASH = keccak256("a curious mind");
    string internal constant METADATA_URI = "runner://metadata/0123456789abcdef";
    bytes32 internal constant SALT = keccak256("Mind One MIND 0");

    uint256 internal constant LAUNCH_FEE = 0.0005 ether;
    uint256 internal constant SUPPLY = 1_000_000_000 ether;
    uint256 internal constant PHANTOM = 4.2 ether;
    uint256 internal constant THRESHOLD = 4.2 ether;
    uint256 internal constant CURVE_FEE_BPS = 100;
    uint24 internal constant POOL_FEE = 10_000;
    int24 internal constant TICK_SPACING = 200;
    uint16 internal constant TAX_BPS = 200;
    uint256 internal constant PROTOCOL_SHARE_BPS = 3000;

    function setUp() public virtual {
        vm.warp(1_750_000_000);
        escrow = new MockPonsFeeEscrow();
        hook = new MockPonsMemeHook(ponsOwner, escrow, ponsProtocol);
        factory = new MockPonsFactory(ponsOwner, hook, escrow, LAUNCH_FEE);
        vm.startPrank(ponsOwner);
        hook.setFactory(address(factory));
        hook.setFeeSweepOperator(ponsOperator);
        factory.addLaunchConfig(
            IPonsV2LaunchFactory.LaunchConfig({
                supply: SUPPLY,
                curveFeeBps: CURVE_FEE_BPS,
                phantomQuote: PHANTOM,
                graduationThreshold: THRESHOLD,
                poolFee: POOL_FEE,
                tickSpacing: TICK_SPACING,
                enabled: true
            })
        );
        factory.setLaunchEnabled(true);
        vm.stopPrank();

        registry = new PonsMindRegistry(
            owner, treasury, computeTreasury, operator, address(factory), address(escrow), address(hook)
        );

        vm.deal(creator, 1000 ether);
        vm.deal(alice, 1000 ether);
        vm.deal(bob, 1000 ether);
        vm.deal(stranger, 1000 ether);
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    function _params(bytes32 salt) internal pure returns (IPonsMindRegistry.LaunchParams memory p) {
        p.name = "Mind One";
        p.symbol = "MIND";
        p.logo = "ipfs://logo";
        p.description = "a mind that reads the web";
        p.socials = IPonsV2LaunchFactory.Socials({
            twitter: "@mind", telegram: "", discord: "", website: "https://mind.example", farcaster: ""
        });
        p.creatorTaxBps = TAX_BPS;
        p.expectedEconomics = bytes32(0);
        p.salt = salt;
        p.launchConfigId = 0;
    }

    function _launch(address who, uint256 quoteIn) internal returns (address token, address curve, address account) {
        return _launchWith(who, _params(SALT), quoteIn, 0);
    }

    function _launchWith(address who, IPonsMindRegistry.LaunchParams memory p, uint256 quoteIn, uint256 minTokensOut)
        internal
        returns (address token, address curve, address account)
    {
        uint256 value = factory.launchFee() + quoteIn + registry.creationFee();
        vm.prank(who);
        (token, curve, account) =
            registry.launchMind{value: value}(p, quoteIn, minTokensOut, MODEL_ID, PERSONA_HASH, METADATA_URI);
    }

    /// @dev A token launched directly on Pons by `who` (creator fee recipient `recipient`), for adoption tests.
    function _launchDirect(address who, address recipient, bytes32 salt, bool buyback)
        internal
        returns (address token, address curve)
    {
        IPonsV2LaunchFactory.TokenParams memory tp;
        tp.name = "Wild Coin";
        tp.symbol = "WILD";
        tp.creatorFeeRecipient = recipient;
        tp.creatorTaxBps = TAX_BPS;
        tp.buybackEnabled = buyback;
        tp.salt = salt;
        vm.prank(who);
        (token, curve) = factory.launchToken{value: LAUNCH_FEE}(tp, 0, address(0), new address[](0));
    }

    function _buy(address who, address curve, uint256 quoteIn) internal returns (uint256 tokensOut) {
        vm.prank(who);
        tokensOut = MockPonsCurve(curve).buy{value: quoteIn}(quoteIn, 0, who);
    }

    function _sell(address who, address curve, uint256 tokensIn) internal returns (uint256 quoteOut) {
        address token = MockPonsCurve(curve).token();
        vm.startPrank(who);
        IERC20(token).approve(curve, tokensIn);
        quoteOut = MockPonsCurve(curve).sell(tokensIn, 0, who);
        vm.stopPrank();
    }

    /// @dev Creator share a sweep of `curve` would credit right now (protocol share 30 %, tax in full).
    function _pendingCreatorShare(address curve) internal view returns (uint256) {
        uint256 pending = MockPonsCurve(curve).quoteFeeBalance();
        return pending - pending * PROTOCOL_SHARE_BPS / 10_000 + MockPonsCurve(curve).creatorTaxBalance();
    }

    /// @dev Buys past the threshold (auto-graduation to `Swept`).
    function _graduate(address who, address curve) internal {
        _buy(who, curve, 10 ether);
        assertTrue(MockPonsCurve(curve).graduated(), "graduated");
    }

    function _phase(address token) internal view returns (IPonsV2LaunchFactory.GraduationPhase) {
        return factory.getLaunchedToken(token).phase;
    }

    function _status(address token) internal view returns (IMindCore.MindStatus) {
        return registry.getMind(token).status;
    }

    function _harvest(address token) internal {
        vm.prank(stranger);
        registry.harvest(token);
    }

    function _assertSolvent() internal view {
        assertEq(address(registry).balance, _liabilities(), "registry ETH == sum(mindBalance) + protocolBalance");
    }

    function _liabilities() internal view returns (uint256 total) {
        total = registry.protocolBalance();
        uint256 n = registry.mindsLength();
        for (uint256 i; i < n; ++i) {
            total += registry.mindBalance(registry.mindAt(i));
        }
    }

    function _account(address token) internal view returns (MindAccount) {
        return MindAccount(payable(registry.accountOf(token)));
    }
}
