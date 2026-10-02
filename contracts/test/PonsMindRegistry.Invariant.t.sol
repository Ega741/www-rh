// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MindAccount} from "../src/MindAccount.sol";
import {IPonsMindRegistry} from "../src/interfaces/IPonsMindRegistry.sol";
import {IPonsV2LaunchFactory} from "../src/interfaces/pons/IPonsV2LaunchFactory.sol";
import {PonsRegistryHandler} from "./invariant/PonsRegistryHandler.sol";
import {PonsBaseTest} from "./utils/PonsBaseTest.sol";

/// @notice SPEC §9.2 invariants of the Pons registry under random launches, adoptions, trading, sweeps, graduation,
///         pool fees, harvests, funding, draws, withdrawals, fee changes, leaving and donations.
contract PonsMindRegistryInvariantTest is PonsBaseTest {
    PonsRegistryHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new PonsRegistryHandler(registry, factory, hook, owner, operator, ponsOperator);
        targetContract(address(handler));
    }

    /// @dev The registry holds exactly Σ mindBalance + protocolBalance: launch fees, initial buys and their refunds
    ///      never stay behind (no forced ETH in this setup).
    function invariant_registryEthEqualsLiabilities() public view {
        assertEq(address(registry).balance, _liabilities());
        assertEq(registry.mindsLength(), handler.tokensLength());
    }

    /// @dev Accounts forward everything they receive on harvest: between transactions they hold only ETH sent to them
    ///      directly since their last harvest.
    function invariant_accountsHoldOnlyUndeliveredDonations() public view {
        uint256 n = handler.tokensLength();
        for (uint256 i; i < n; ++i) {
            address account = registry.accountOf(handler.tokens(i));
            assertEq(account.balance, handler.undelivered(account));
        }
    }

    /// @dev Initial buys go straight to the creator: the registry and the accounts never hold Pons tokens.
    function invariant_noTokensStuck() public view {
        uint256 n = handler.tokensLength();
        for (uint256 i; i < n; ++i) {
            address token = handler.tokens(i);
            assertEq(IERC20(token).balanceOf(address(registry)), 0);
            assertEq(IERC20(token).balanceOf(registry.accountOf(token)), 0);
        }
    }

    /// @dev The per-epoch draw cap is never exceeded.
    function invariant_drawCap() public view {
        (uint256 maxPerEpoch,) = registry.drawLimit();
        uint256 n = handler.tokensLength();
        for (uint256 i; i < n; ++i) {
            (uint256 drawn,) = registry.drawnInEpoch(handler.tokens(i));
            assertLe(drawn, maxPerEpoch);
        }
    }

    /// @dev Records stay consistent: one account per token and back, bound to this registry, curve as recorded by
    ///      Pons, and the account is the creator fee recipient unless the mind left.
    function invariant_bookkeeping() public view {
        uint256 n = handler.tokensLength();
        for (uint256 i; i < n; ++i) {
            address token = handler.tokens(i);
            assertEq(registry.mindAt(i), token);
            IPonsMindRegistry.PonsMind memory m = registry.ponsMind(token);
            assertEq(registry.tokenOf(m.account), token);
            assertEq(MindAccount(payable(m.account)).registry(), address(registry));
            IPonsV2LaunchFactory.LaunchedToken memory lt = factory.getLaunchedToken(token);
            assertEq(lt.curve, m.curve);
            assertTrue(m.launchedHere != m.adopted, "every handler mind is launched or adopted");
            if (m.launchedHere) assertEq(lt.deployer, address(registry));
            if (lt.creatorFeeRecipient != m.account) {
                assertEq(lt.creatorFeeRecipient, registry.getMind(token).creator, "only after leave");
            }
        }
    }

    /// @dev Deterministic walk through every phase (the fuzzer reaches them randomly).
    function test_handler_fullLifecycle() public {
        handler.warp(60); // past the snipe-tax window of the initial launches
        handler.adopt(2);
        handler.buy(1, 0, 3 ether);
        handler.buy(2, 0, 3 ether); // crosses the threshold of tokens[0]: auto-graduation
        handler.createPool(0);
        handler.poolFees(0, 1 ether, 500);
        handler.donateToAccount(3, 1, 0.05 ether);
        handler.ponsSweep(1);
        invariant_accountsHoldOnlyUndeliveredDonations();
        handler.harvest(0);
        handler.harvest(1);
        handler.harvest(2);
        handler.fundMind(0, 1, 1 ether);
        handler.drawCompute(1, 0.1 ether);
        handler.setMindFeeBps(500);
        handler.buy(3, 2, 1 ether);
        handler.harvest(2);
        handler.leave(1);
        handler.withdrawProtocolFees();
        assertEq(uint8(factory.getLaunchedToken(handler.tokens(0)).phase), 2, "PoolCreated");
        assertGt(registry.mindBalance(handler.tokens(0)), 0);
        assertGt(handler.calls("harvest"), 0);
        invariant_registryEthEqualsLiabilities();
        invariant_accountsHoldOnlyUndeliveredDonations();
        invariant_noTokensStuck();
        invariant_drawCap();
        invariant_bookkeeping();
    }
}
