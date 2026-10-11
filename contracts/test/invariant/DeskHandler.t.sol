// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BeagleToken} from "../../src/BeagleToken.sol";
import {CreditDesk} from "../../src/CreditDesk.sol";
import {MockPriceSource} from "../../src/mocks/MockPriceSource.sol";
import {DeskHandler} from "./DeskHandler.sol";

/// @dev Self-test of the invariant handler: each action path succeeds once with sane inputs.
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
        assertEq(desk.totalBurned(), h.ghostBurned());
        assertEq(desk.totalUsdMicro(), h.ghostUsd());
        assertEq(desk.nextReceiptId(), h.ghostReceipts() + 1);
    }
}
