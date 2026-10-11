// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {BeagleToken} from "../src/BeagleToken.sol";
import {PermitSigner} from "./utils/PermitSigner.sol";

contract BeagleTokenTest is Test, PermitSigner {
    BeagleToken internal token;
    uint256 internal constant ALICE_PK = 0xA11CE;
    address internal alice;

    function setUp() public {
        alice = vm.addr(ALICE_PK);
        token = new BeagleToken(alice);
    }

    function test_metadataAndSupply() public view {
        assertEq(token.name(), "Beagle");
        assertEq(token.symbol(), "BEAGLE");
        assertEq(token.decimals(), 18);
        assertEq(token.TOTAL_SUPPLY(), 1_000_000_000e18);
        assertEq(token.totalSupply(), token.TOTAL_SUPPLY());
        assertEq(token.balanceOf(alice), token.TOTAL_SUPPLY());
    }

    function test_constructor_zeroRecipientReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InvalidReceiver.selector, address(0)));
        new BeagleToken(address(0));
    }

    function test_burn_reducesSupply() public {
        vm.prank(alice);
        token.burn(5e18);
        assertEq(token.totalSupply(), token.TOTAL_SUPPLY() - 5e18);
        assertEq(token.balanceOf(alice), token.TOTAL_SUPPLY() - 5e18);
    }

    function test_burnFrom_needsAllowance() public {
        address spender = makeAddr("spender");
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, spender, uint256(0), uint256(1))
        );
        vm.prank(spender);
        token.burnFrom(alice, 1);

        vm.prank(alice);
        token.approve(spender, 7);
        vm.prank(spender);
        token.burnFrom(alice, 7);
        assertEq(token.totalSupply(), token.TOTAL_SUPPLY() - 7);
        assertEq(token.allowance(alice, spender), 0);
    }

    function test_permit_setsAllowanceAndBumpsNonce() public {
        address spender = makeAddr("spender");
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = signPermit(token, ALICE_PK, spender, 123e18, deadline);
        assertEq(token.nonces(alice), 0);
        token.permit(alice, spender, 123e18, deadline, v, r, s);
        assertEq(token.allowance(alice, spender), 123e18);
        assertEq(token.nonces(alice), 1);
        // Replay is rejected (nonce consumed).
        vm.expectRevert();
        token.permit(alice, spender, 123e18, deadline, v, r, s);
    }

    function test_permit_expiredReverts() public {
        address spender = makeAddr("spender");
        uint256 deadline = block.timestamp + 1;
        (uint8 v, bytes32 r, bytes32 s) = signPermit(token, ALICE_PK, spender, 1, deadline);
        vm.warp(deadline + 1);
        vm.expectRevert();
        token.permit(alice, spender, 1, deadline, v, r, s);
    }
}
