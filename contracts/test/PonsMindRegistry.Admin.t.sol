// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {PonsMindRegistry} from "../src/PonsMindRegistry.sol";
import {IMindCore} from "../src/interfaces/IMindCore.sol";
import {PonsBaseTest} from "./utils/PonsBaseTest.sol";

/// @notice MindCore through the Pons registry (SPEC §9.2: "draw/anchor/status via MindCore"): vault funding and
///         epoch-capped draws to the compute treasury, memory anchoring, status rules, creator config, roles,
///         protocol fee withdrawal, Ownable2Step and the renounce block.
contract PonsMindRegistryAdminTest is PonsBaseTest {
    address internal token;

    function setUp() public override {
        super.setUp();
        (token,,) = _launch(creator, 0);
    }

    function _fund(uint256 amount) internal {
        vm.prank(alice);
        registry.fundMind{value: amount}(token);
    }

    // ---------------------------------------------------------------------------------------------
    // Vault
    // ---------------------------------------------------------------------------------------------

    function test_fundMind() public {
        vm.expectEmit(true, true, false, true, address(registry));
        emit IMindCore.MindFunded(token, alice, 1 ether);
        _fund(1 ether);
        assertEq(registry.mindBalance(token), 1 ether);
        vm.prank(alice);
        vm.expectRevert(IMindCore.ZeroAmount.selector);
        registry.fundMind{value: 0}(token);
        vm.prank(alice);
        vm.expectRevert(IMindCore.NotAMind.selector);
        registry.fundMind{value: 1}(makeAddr("random"));
        _assertSolvent();
    }

    function test_drawCompute_toComputeTreasury_inEveryStatus() public {
        _fund(2 ether);
        bytes32 receipt = keccak256("usage-ledger-1");
        vm.expectEmit(true, false, false, true, address(registry));
        emit IMindCore.ComputeDrawn(token, 0.05 ether, receipt);
        vm.prank(operator);
        registry.drawCompute(token, 0.05 ether, receipt);
        assertEq(computeTreasury.balance, 0.05 ether);
        assertEq(registry.mindBalance(token), 1.95 ether);

        vm.prank(operator);
        registry.setMindStatus(token, IMindCore.MindStatus.Dormant);
        vm.prank(operator);
        registry.drawCompute(token, 0.05 ether, receipt);
        vm.prank(creator);
        registry.setCreatorPaused(token, true);
        vm.prank(operator);
        registry.drawCompute(token, 0.05 ether, receipt);
        assertEq(computeTreasury.balance, 0.15 ether);
        _assertSolvent();
    }

    function test_drawCompute_guards() public {
        _fund(1 ether);
        vm.prank(stranger);
        vm.expectRevert(IMindCore.NotOperator.selector);
        registry.drawCompute(token, 1, bytes32(0));
        vm.startPrank(operator);
        vm.expectRevert(IMindCore.NotAMind.selector);
        registry.drawCompute(makeAddr("random"), 1, bytes32(0));
        vm.expectRevert(IMindCore.ZeroAmount.selector);
        registry.drawCompute(token, 0, bytes32(0));
        vm.expectRevert(IMindCore.InsufficientMindBalance.selector);
        registry.drawCompute(token, 1 ether + 1, bytes32(0));
        vm.stopPrank();
    }

    function test_drawCompute_epochCapAndReset() public {
        _fund(3 ether);
        vm.startPrank(operator);
        registry.drawCompute(token, 0.25 ether, bytes32(0));
        vm.expectRevert(IMindCore.DrawLimitExceeded.selector);
        registry.drawCompute(token, 1, bytes32(0));
        (uint256 drawn, uint64 epochStart) = registry.drawnInEpoch(token);
        assertEq(drawn, 0.25 ether);
        assertEq(epochStart, block.timestamp);
        vm.warp(block.timestamp + 1 days);
        registry.drawCompute(token, 0.25 ether, bytes32(0));
        vm.stopPrank();
        (drawn, epochStart) = registry.drawnInEpoch(token);
        assertEq(drawn, 0.25 ether);
        assertEq(epochStart, block.timestamp);

        // Owner bounds: MAX_DRAW_PER_EPOCH = 2 ether, epoch >= 1 hour.
        vm.startPrank(owner);
        vm.expectRevert(IMindCore.InvalidDrawLimit.selector);
        registry.setDrawLimit(2 ether + 1, 1 days);
        vm.expectRevert(IMindCore.InvalidDrawLimit.selector);
        registry.setDrawLimit(1 ether, 3599);
        vm.expectEmit(false, false, false, true, address(registry));
        emit IMindCore.DrawLimitUpdated(2 ether, 1 hours);
        registry.setDrawLimit(2 ether, 1 hours);
        vm.stopPrank();
        vm.prank(operator);
        registry.drawCompute(token, 1.75 ether, bytes32(0));
        _assertSolvent();
    }

    function test_drawCompute_rejectingOrReenteringTreasury() public {
        _fund(1 ether);
        Rejector rejector = new Rejector();
        vm.prank(owner);
        registry.setComputeTreasury(address(rejector));
        vm.prank(operator);
        vm.expectRevert(IMindCore.EthTransferFailed.selector);
        registry.drawCompute(token, 0.1 ether, bytes32(0));
        assertEq(registry.mindBalance(token), 1 ether);

        ReenteringTreasury reenter = new ReenteringTreasury(registry, token);
        vm.prank(owner);
        registry.setComputeTreasury(address(reenter));
        vm.prank(operator);
        vm.expectRevert(IMindCore.EthTransferFailed.selector); // inner ReentrancyGuardReentrantCall
        registry.drawCompute(token, 0.1 ether, bytes32(0));
        assertEq(registry.mindBalance(token), 1 ether);
        _assertSolvent();
    }

    // ---------------------------------------------------------------------------------------------
    // Operator / creator
    // ---------------------------------------------------------------------------------------------

    function test_anchorMemory() public {
        vm.expectEmit(true, true, false, true, address(registry));
        emit IMindCore.MemoryAnchored(token, 7, keccak256("batch"), "runner://memory/7");
        vm.prank(operator);
        registry.anchorMemory(token, 7, keccak256("batch"), "runner://memory/7");
        vm.prank(stranger);
        vm.expectRevert(IMindCore.NotOperator.selector);
        registry.anchorMemory(token, 8, bytes32(0), "");
        vm.prank(operator);
        vm.expectRevert(IMindCore.NotAMind.selector);
        registry.anchorMemory(makeAddr("random"), 8, bytes32(0), "");
    }

    function test_statusRules() public {
        vm.startPrank(operator);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IMindCore.MindStatusChanged(token, IMindCore.MindStatus.Dormant);
        registry.setMindStatus(token, IMindCore.MindStatus.Dormant);
        vm.expectRevert(IMindCore.InvalidStatus.selector);
        registry.setMindStatus(token, IMindCore.MindStatus.Paused);
        vm.stopPrank();

        vm.prank(creator);
        registry.setCreatorPaused(token, true);
        assertEq(uint8(_status(token)), uint8(IMindCore.MindStatus.Paused));
        vm.prank(operator);
        vm.expectRevert(IMindCore.InvalidStatus.selector);
        registry.setMindStatus(token, IMindCore.MindStatus.Alive);
        vm.prank(creator);
        registry.setCreatorPaused(token, false);
        assertEq(uint8(_status(token)), uint8(IMindCore.MindStatus.Alive));

        vm.prank(stranger);
        vm.expectRevert(IMindCore.NotCreator.selector);
        registry.setCreatorPaused(token, true);
        vm.prank(stranger);
        vm.expectRevert(IMindCore.NotOperator.selector);
        registry.setMindStatus(token, IMindCore.MindStatus.Dormant);
    }

    function test_setMindConfig() public {
        bytes32 model = keccak256("claude-sonnet-5");
        vm.expectEmit(true, false, false, true, address(registry));
        emit IMindCore.MindConfigUpdated(token, model, bytes32(uint256(1)), "ipfs://new");
        vm.prank(creator);
        registry.setMindConfig(token, model, bytes32(uint256(1)), "ipfs://new");
        IMindCore.MindInfo memory info = registry.getMind(token);
        assertEq(info.modelId, model);
        assertEq(info.metadataURI, "ipfs://new");
        vm.startPrank(creator);
        vm.expectRevert(IMindCore.InvalidModel.selector);
        registry.setMindConfig(token, bytes32(0), bytes32(0), "");
        vm.expectRevert(IMindCore.MetadataTooLong.selector);
        registry.setMindConfig(token, model, bytes32(0), string(new bytes(2049)));
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(IMindCore.NotCreator.selector);
        registry.setMindConfig(token, model, bytes32(0), "");
    }

    // ---------------------------------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------------------------------

    function test_roleSetters() public {
        address a = makeAddr("new");
        vm.startPrank(owner);
        vm.expectEmit(false, false, false, true, address(registry));
        emit IMindCore.OperatorUpdated(a);
        registry.setOperator(a);
        vm.expectEmit(false, false, false, true, address(registry));
        emit IMindCore.TreasuryUpdated(a);
        registry.setTreasury(a);
        vm.expectEmit(false, false, false, true, address(registry));
        emit IMindCore.ComputeTreasuryUpdated(a);
        registry.setComputeTreasury(a);
        vm.expectEmit(false, false, false, true, address(registry));
        emit IMindCore.CreationFeeUpdated(0.01 ether);
        registry.setCreationFee(0.01 ether);
        vm.expectRevert(IMindCore.ZeroAddress.selector);
        registry.setOperator(address(0));
        vm.expectRevert(IMindCore.ZeroAddress.selector);
        registry.setTreasury(address(0));
        vm.expectRevert(IMindCore.ZeroAddress.selector);
        registry.setComputeTreasury(address(0));
        vm.stopPrank();
        assertEq(registry.operator(), a);
        assertEq(registry.treasury(), a);
        assertEq(registry.computeTreasury(), a);
        assertEq(registry.creationFee(), 0.01 ether);
    }

    function test_accessControl_ownerOnly() public {
        bytes memory unauthorized = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger);
        vm.startPrank(stranger);
        vm.expectRevert(unauthorized);
        registry.setOperator(stranger);
        vm.expectRevert(unauthorized);
        registry.setTreasury(stranger);
        vm.expectRevert(unauthorized);
        registry.setComputeTreasury(stranger);
        vm.expectRevert(unauthorized);
        registry.setCreationFee(1);
        vm.expectRevert(unauthorized);
        registry.setDrawLimit(1, 1 days);
        vm.expectRevert(unauthorized);
        registry.setMindFeeBps(1);
        vm.expectRevert(unauthorized);
        registry.pause();
        vm.expectRevert(unauthorized);
        registry.unpause();
        vm.expectRevert(unauthorized);
        registry.withdrawProtocolFees(stranger);
        vm.stopPrank();
    }

    function test_withdrawProtocolFees() public {
        vm.prank(owner);
        registry.setCreationFee(0.1 ether);
        _launchWith(alice, _params(keccak256("2")), 0, 0);
        assertEq(registry.protocolBalance(), 0.1 ether);

        vm.prank(treasury);
        vm.expectRevert(IMindCore.ZeroAddress.selector);
        registry.withdrawProtocolFees(address(0));
        vm.expectEmit(true, false, false, true, address(registry));
        emit IMindCore.ProtocolFeesWithdrawn(treasury, 0.1 ether);
        vm.prank(treasury);
        registry.withdrawProtocolFees(treasury);
        assertEq(treasury.balance, 0.1 ether);
        assertEq(registry.protocolBalance(), 0);
        vm.prank(owner);
        vm.expectRevert(IMindCore.ZeroAmount.selector);
        registry.withdrawProtocolFees(owner);
        _assertSolvent();
    }

    function test_ownership_twoStep_andRenounceDisabled() public {
        address next = makeAddr("multisig");
        vm.prank(owner);
        registry.transferOwnership(next);
        assertEq(registry.owner(), owner);
        assertEq(registry.pendingOwner(), next);
        vm.prank(next);
        registry.acceptOwnership();
        assertEq(registry.owner(), next);

        vm.prank(next);
        vm.expectRevert(IMindCore.RenounceDisabled.selector);
        registry.renounceOwnership();
        vm.prank(stranger);
        vm.expectRevert(IMindCore.RenounceDisabled.selector);
        registry.renounceOwnership();
    }

    function test_views_unknownToken() public {
        address random = makeAddr("random");
        assertFalse(registry.isMind(random));
        assertEq(registry.getMind(random).creator, address(0));
        assertEq(registry.ponsMind(random).account, address(0));
        assertEq(registry.accountOf(random), address(0));
        assertEq(registry.tokenOf(random), address(0));
        assertEq(registry.mindBalance(random), 0);
        vm.expectRevert();
        registry.mindAt(5);
    }
}

/// @notice Rejects every ETH transfer.
contract Rejector {
    receive() external payable {
        revert("no");
    }
}

/// @notice Re-enters drawCompute when paid.
contract ReenteringTreasury {
    PonsMindRegistry internal immutable registry;
    address internal immutable token;

    constructor(PonsMindRegistry registry_, address token_) {
        registry = registry_;
        token = token_;
    }

    receive() external payable {
        registry.drawCompute(token, 1, bytes32(0));
    }
}
