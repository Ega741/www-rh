// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BeagleToken} from "../../src/BeagleToken.sol";
import {CreditDesk} from "../../src/CreditDesk.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockPriceSource} from "../../src/mocks/MockPriceSource.sol";
import {DeskHandler} from "./DeskHandler.sol";

/// @dev Shared invariant suite (SPEC §3.4); instantiated once per burn mode below.
abstract contract CreditDeskInvariantBase is Test {
    CreditDesk internal desk;
    IERC20 internal token;
    MockPriceSource internal ps;
    DeskHandler internal handler;
    bool internal native;
    uint256 internal initialSupply;

    function _setUp(bool native_) internal {
        vm.warp(1_700_000_000);
        native = native_;
        address owner = makeAddr("owner");
        address operator = makeAddr("operator");
        ps = new MockPriceSource(1e16, block.timestamp);
        token = native_
            ? IERC20(address(new BeagleToken(address(this))))
            : IERC20(address(new MockERC20("Plain", "PLN", 18)));
        desk = new CreditDesk(token, native_, ps, owner, operator);
        handler = new DeskHandler(desk, ps, owner, operator, native_);

        address[] memory actors = handler.actors();
        for (uint256 i = 0; i < actors.length; i++) {
            if (native_) token.transfer(actors[i], 100_000_000e18);
            else MockERC20(address(token)).mint(actors[i], 100_000_000e18);
        }
        initialSupply = token.totalSupply();

        bytes4[] memory selectors = new bytes4[](10);
        selectors[0] = DeskHandler.burn.selector;
        selectors[1] = DeskHandler.burnWithPermit.selector;
        selectors[2] = DeskHandler.openBudget.selector;
        selectors[3] = DeskHandler.draw.selector;
        selectors[4] = DeskHandler.closeBudget.selector;
        selectors[5] = DeskHandler.warp.selector;
        selectors[6] = DeskHandler.setPrice.selector;
        selectors[7] = DeskHandler.breakPrice.selector;
        selectors[8] = DeskHandler.setPaused.selector;
        selectors[9] = DeskHandler.setMinBurn.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// Invariant 1: totals equal the sums over emitted `CreditPurchased` + `BudgetDrawn` events.
    function invariant_totalsMatchEvents() public view {
        assertEq(desk.totalBurned(), handler.ghostBurned(), "totalBurned != sum(events.tokenAmount)");
        assertEq(desk.totalUsdMicro(), handler.ghostUsd(), "totalUsdMicro != sum(events.usdMicro)");
    }

    /// Invariant 2: the desk never holds tokens; burned tokens are gone (native) or parked at DEAD.
    function invariant_deskHoldsNothingAndBurnsAreAccounted() public view {
        assertEq(token.balanceOf(address(desk)), 0, "desk holds tokens");
        if (native) {
            assertEq(initialSupply - token.totalSupply(), desk.totalBurned(), "supply delta != totalBurned");
        } else {
            assertEq(token.balanceOf(desk.DEAD()), desk.totalBurned(), "DEAD balance != totalBurned");
        }
    }

    /// Invariant 3: `drawn <= cap`; a closed or expired budget never increases `drawn`.
    function invariant_budgetsBounded() public view {
        uint256[] memory ids = handler.budgetIds();
        for (uint256 i = 0; i < ids.length; i++) {
            (,, uint128 cap, uint128 drawn, uint64 deadline, bool closed) = desk.budgets(ids[i]);
            assertLe(drawn, cap, "drawn > cap");
            if (handler.frozen(ids[i])) {
                assertEq(drawn, handler.frozenDrawn(ids[i]), "frozen budget drawn changed");
                assertTrue(closed || block.timestamp > deadline, "frozen budget is live");
            }
        }
        assertEq(desk.nextBudgetId(), ids.length + 1, "budget ids not sequential");
    }

    /// Invariant 4: receipt ids are strictly increasing and unique across purchases and draws.
    function invariant_receiptIdsSequential() public view {
        assertEq(desk.nextReceiptId(), handler.ghostReceipts() + 1, "nextReceiptId != receipts + 1");
        assertEq(handler.lastReceiptId(), handler.ghostReceipts(), "last receipt id != count");
    }

    function afterInvariant() public view {
        console.log("burn ok/revert:   %d / %d", handler.nBurnOk(), handler.nBurnRevert());
        console.log("permit ok/revert: %d / %d", handler.nPermitOk(), handler.nPermitRevert());
        console.log("draw ok/revert:   %d / %d", handler.nDrawOk(), handler.nDrawRevert());
        console.log("open / close:     %d / %d", handler.nOpenOk(), handler.nCloseOk());
        console.log("attempts paused / bad price: %d / %d", handler.nAttemptsPaused(), handler.nAttemptsBadPrice());
    }
}

contract CreditDeskNativeInvariantTest is CreditDeskInvariantBase {
    function setUp() public {
        _setUp(true);
    }
}

contract CreditDeskDeadInvariantTest is CreditDeskInvariantBase {
    function setUp() public {
        _setUp(false);
    }
}
