// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ManualPriceSource} from "../src/ManualPriceSource.sol";

contract ManualPriceSourceTest is Test {
    ManualPriceSource internal ps;
    address internal owner = makeAddr("owner");
    address internal poster = makeAddr("poster");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant P0 = 1e16; // $0.01

    function setUp() public {
        vm.warp(1_700_000_000);
        ps = new ManualPriceSource(owner, poster);
    }

    function _post(uint256 p) internal {
        vm.prank(poster);
        ps.post(p);
    }

    // ─── Construction ─────────────────────────────────────────────────────────────────────────────────

    function test_constructor_state() public view {
        assertEq(ps.owner(), owner);
        assertEq(ps.poster(), poster);
        assertEq(ps.maxStepBps(), 2500);
        assertEq(ps.minInterval(), 60);
        (uint256 p, uint256 t) = ps.latestPrice();
        assertEq(p, 0);
        assertEq(t, 0);
    }

    function test_constructor_emitsPosterSet() public {
        vm.expectEmit();
        emit ManualPriceSource.PosterSet(poster);
        new ManualPriceSource(owner, poster);
    }

    function test_constructor_zeroOwnerReverts() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new ManualPriceSource(address(0), poster);
    }

    function test_constructor_zeroPosterAllowed() public {
        ManualPriceSource p = new ManualPriceSource(owner, address(0));
        assertEq(p.poster(), address(0));
    }

    // ─── post ─────────────────────────────────────────────────────────────────────────────────────────

    function test_post_firstPostAnyValue() public {
        vm.expectEmit();
        emit ManualPriceSource.PricePosted(P0, block.timestamp, poster);
        _post(P0);
        (uint256 p, uint256 t) = ps.latestPrice();
        assertEq(p, P0);
        assertEq(t, block.timestamp);
    }

    function test_post_notPoster() public {
        vm.expectRevert(ManualPriceSource.NotPoster.selector);
        vm.prank(stranger);
        ps.post(P0);
        vm.expectRevert(ManualPriceSource.NotPoster.selector);
        vm.prank(owner);
        ps.post(P0);
    }

    function test_post_zeroPrice() public {
        vm.expectRevert(ManualPriceSource.ZeroPrice.selector);
        _post(0);
    }

    function test_post_tooSoon() public {
        _post(P0);
        uint256 nextAllowed = block.timestamp + 60;
        vm.warp(block.timestamp + 59);
        vm.expectRevert(abi.encodeWithSelector(ManualPriceSource.PostTooSoon.selector, nextAllowed));
        _post(P0);
        vm.warp(nextAllowed);
        _post(P0 + 1); // exactly at the boundary is allowed
    }

    function test_post_stepBounds() public {
        _post(P0);
        vm.warp(block.timestamp + 60);
        uint256 upMax = P0 + P0 * 2500 / 10_000;
        vm.expectRevert(abi.encodeWithSelector(ManualPriceSource.PriceStepTooLarge.selector, P0, upMax + 1));
        _post(upMax + 1);
        _post(upMax); // +25 % exactly
        (uint256 p,) = ps.latestPrice();
        assertEq(p, upMax);

        vm.warp(block.timestamp + 60);
        uint256 downMax = upMax - upMax * 2500 / 10_000;
        vm.expectRevert(abi.encodeWithSelector(ManualPriceSource.PriceStepTooLarge.selector, upMax, downMax - 1));
        _post(downMax - 1);
        _post(downMax); // −25 % exactly
    }

    function test_post_stepCheckedBeforeInterval() public {
        _post(P0);
        vm.expectRevert(abi.encodeWithSelector(ManualPriceSource.PriceStepTooLarge.selector, P0, P0 * 2));
        _post(P0 * 2);
    }

    function test_post_boundsApplyAfterForce() public {
        vm.prank(owner);
        ps.forcePrice(P0);
        vm.expectRevert(abi.encodeWithSelector(ManualPriceSource.PostTooSoon.selector, block.timestamp + 60));
        _post(P0);
    }

    function testFuzz_post_withinBounds(uint256 start, uint256 bps, bool up) public {
        start = bound(start, 1e6, 1e30);
        bps = bound(bps, 0, 2500);
        _post(start);
        vm.warp(block.timestamp + 60);
        uint256 delta = start * bps / 10_000;
        uint256 next = up ? start + delta : start - delta;
        if (next == 0) next = 1;
        _post(next);
        (uint256 p,) = ps.latestPrice();
        assertEq(p, next);
    }

    function testFuzz_post_beyondBounds(uint256 start, uint256 bps, bool up) public {
        start = bound(start, 1e6, 1e30);
        bps = bound(bps, 2501, 20_000);
        _post(start);
        vm.warp(block.timestamp + 60);
        uint256 delta = start * bps / 10_000 + 1;
        uint256 next = up ? start + delta : (delta >= start ? 1 : start - delta);
        vm.assume(next != start);
        vm.expectRevert(abi.encodeWithSelector(ManualPriceSource.PriceStepTooLarge.selector, start, next));
        _post(next);
    }

    // ─── forcePrice ───────────────────────────────────────────────────────────────────────────────────

    function test_forcePrice_bypassesBounds() public {
        _post(P0);
        vm.expectEmit();
        emit ManualPriceSource.PriceForced(P0 * 10, block.timestamp);
        vm.prank(owner);
        ps.forcePrice(P0 * 10);
        (uint256 p, uint256 t) = ps.latestPrice();
        assertEq(p, P0 * 10);
        assertEq(t, block.timestamp);
    }

    function test_forcePrice_onlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, poster));
        vm.prank(poster);
        ps.forcePrice(P0);
    }

    function test_forcePrice_zeroMarksUnavailableAndResetsBounds() public {
        _post(P0);
        vm.prank(owner);
        ps.forcePrice(0);
        (uint256 p,) = ps.latestPrice();
        assertEq(p, 0);
        // With no price set, the next post is unconstrained.
        _post(P0 * 100);
        (p,) = ps.latestPrice();
        assertEq(p, P0 * 100);
    }

    // ─── setPoster / setBounds ────────────────────────────────────────────────────────────────────────

    function test_setPoster() public {
        address np = makeAddr("newPoster");
        vm.expectEmit();
        emit ManualPriceSource.PosterSet(np);
        vm.prank(owner);
        ps.setPoster(np);
        assertEq(ps.poster(), np);
        vm.expectRevert(ManualPriceSource.NotPoster.selector);
        _post(P0);
        vm.prank(np);
        ps.post(P0);
    }

    function test_setPoster_onlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        ps.setPoster(stranger);
    }

    function test_setBounds() public {
        vm.expectEmit();
        emit ManualPriceSource.BoundsSet(10_000, 0);
        vm.prank(owner);
        ps.setBounds(10_000, 0);
        assertEq(ps.maxStepBps(), 10_000);
        assertEq(ps.minInterval(), 0);
        _post(P0);
        _post(P0 * 2); // +100 %, no interval
        vm.expectRevert(abi.encodeWithSelector(ManualPriceSource.PriceStepTooLarge.selector, P0 * 2, P0 * 4 + 1));
        _post(P0 * 4 + 1);
    }

    function test_setBounds_bad() public {
        vm.startPrank(owner);
        vm.expectRevert(ManualPriceSource.BadBounds.selector);
        ps.setBounds(0, 60);
        vm.expectRevert(ManualPriceSource.BadBounds.selector);
        ps.setBounds(10_001, 60);
        vm.stopPrank();
    }

    function test_setBounds_onlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, poster));
        vm.prank(poster);
        ps.setBounds(100, 1);
    }

    // ─── Ownable2Step ─────────────────────────────────────────────────────────────────────────────────

    function test_ownershipTwoStep() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        ps.transferOwnership(newOwner);
        assertEq(ps.owner(), owner);
        assertEq(ps.pendingOwner(), newOwner);
        vm.prank(newOwner);
        ps.acceptOwnership();
        assertEq(ps.owner(), newOwner);
        vm.prank(newOwner);
        ps.forcePrice(P0);
    }
}
