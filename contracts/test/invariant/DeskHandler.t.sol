// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BeagleToken} from "../../src/BeagleToken.sol";
import {CreditDesk} from "../../src/CreditDesk.sol";
import {MockPriceSource} from "../../src/mocks/MockPriceSource.sol";
import {DeskHandler} from "./DeskHandler.sol";

/// @dev Self-test of the invariant handler: each action path succeeds once with sane inputs, and the blockers the
///      invariants rely on (stale / unavailable price, the credit floor, draws on an expired budget) really occur.
contract DeskHandlerTest is Test {
    function test_handlerActionsSucceedAndAccount() public {
        vm.warp(1_700_000_000);
        address owner = makeAddr("owner");
        address operator = makeAddr("operator");
        MockPriceSource ps = new MockPriceSource(1e16, block.timestamp);
        BeagleToken token = new BeagleToken(address(this));
        CreditDesk desk = new CreditDesk(IERC20(address(token)), true, ps, owner, operator);
        DeskHandler h = new DeskHandler(desk, ps, owner, operator, true);
        address[] memory actors = h.actors();
        for (uint256 i = 0; i < actors.length; i++) {
            token.transfer(actors[i], 100_000_000e18);
        }
        // Seeds are hashed inside the handler, so try a handful per action and require at least one success.
        for (uint256 i = 0; i < 8; i++) {
            h.openBudget(i, i, uint128(i), uint64(i));
            h.draw(i, i, bytes32(i));
            h.burn(i, i, i);
            h.burnWithPermit(i, i, i, i % 2 == 0);
            h.closeBudget(i, i);
            h.warp(i, i % 2 == 1);
            h.warpPastDeadline(i);
            h.setPrice(i);
            h.breakPrice(uint8(i), i % 2 == 0);
            h.setPaused(uint8(i));
            h.setMinBurn(i);
        }
        console.log("open/close", h.nOpenOk(), h.nCloseOk());
        console.log("draw ok/rev", h.nDrawOk(), h.nDrawRevert());
        console.log("burn ok/rev", h.nBurnOk(), h.nBurnRevert());
        console.log("permit ok/rev", h.nPermitOk(), h.nPermitRevert());
        assertGe(h.nOpenOk(), 1);
        assertGe(h.nDrawOk(), 1);
        assertGe(h.nBurnOk(), 1);
        assertGe(h.nPermitOk(), 1);

        // Deterministic coverage of the blockers (independent of what the hashed seeds above happened to hit).
        if (desk.paused()) {
            vm.prank(owner);
            desk.unpause();
        }
        vm.prank(owner);
        desk.setMinBurn(0);
        ps.set(0, block.timestamp);
        h.burn(1, 1, 7); // price unavailable
        ps.set(1e16, block.timestamp - 2 days);
        h.burn(1, 1, 7); // price stale
        ps.set(1e16, block.timestamp);
        for (uint256 i = 0; i < 64 && h.nFloorRejects() == 0; i++) {
            h.burn(i, i, i + 100); // one quarter of the otherwise-successful burns carry a floor one µUSD too high
        }
        h.openBudget(1, 1, 1, 1);
        uint256[] memory ids = h.budgetIds();
        uint64 latest;
        for (uint256 i = 0; i < ids.length; i++) {
            (,,,, uint64 deadline,) = desk.budgets(ids[i]);
            if (deadline > latest) latest = deadline;
        }
        vm.warp(uint256(latest) + 1); // every budget is now expired …
        ps.set(1e16, block.timestamp); // … and the price is fresh
        for (uint256 i = 0; i < 8; i++) {
            h.draw(i, i, bytes32(i));
        }
        console.log("attempts stale/unavailable", h.nAttemptsStale(), h.nAttemptsUnavailable());
        console.log("floor rejects / expired-fresh draws", h.nFloorRejects(), h.nDrawExpiredFresh());
        assertGe(h.nAttemptsStale(), 1, "no stale-price attempt");
        assertGe(h.nAttemptsUnavailable(), 1, "no unavailable-price attempt");
        assertGe(h.nFloorRejects(), 1, "no credit-floor rejection");
        assertGe(h.nDrawExpiredFresh(), 1, "no draw attempt on an expired budget with a fresh price");

        assertEq(desk.totalBurned(), h.ghostBurned());
        assertEq(desk.totalUsdMicro(), h.ghostUsd());
        assertEq(desk.nextReceiptId(), h.ghostReceipts() + 1);
    }
}
