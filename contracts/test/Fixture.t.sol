// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MindToken} from "../src/MindToken.sol";
import {IMindLaunchpad} from "../src/interfaces/IMindLaunchpad.sol";
import {CurveMath} from "../src/libraries/CurveMath.sol";
import {CurveFixtures} from "../script/CurveFixtures.sol";
import {BaseTest} from "./utils/BaseTest.sol";

/// @notice The checked-in `packages/shared/fixtures/curve.json` is current, matches {CurveMath}, and every case
///         replays bit-for-bit on a real {MindLaunchpad} (quote views and executed trades).
contract FixtureTest is BaseTest {
    /// @dev Storage slot of `MindLaunchpad._curves` (`forge inspect MindLaunchpad storageLayout`); verified below.
    uint256 internal constant CURVES_SLOT = 13;

    string internal json;
    uint256 internal count;

    function setUp() public override {
        super.setUp();
        json = vm.readFile(CurveFixtures.PATH);
        while (vm.keyExistsJson(json, string.concat(".cases[", vm.toString(count), "]"))) {
            ++count;
        }
    }

    function _str(uint256 i, string memory field) internal view returns (string memory) {
        return vm.parseJsonString(json, string.concat(".cases[", vm.toString(i), "].", field));
    }

    function _uint(uint256 i, string memory field) internal view returns (uint256) {
        return vm.parseUint(_str(i, field));
    }

    function _case(uint256 i) internal view returns (CurveFixtures.Case memory c) {
        bytes32 op = keccak256(bytes(_str(i, "op")));
        c.completes = op == keccak256("complete");
        c.isBuy = c.completes || op == keccak256("buy");
        assertTrue(c.isBuy || op == keccak256("sell"), "op must be buy, complete or sell");
        c.realEthReserve = _uint(i, "realEthReserve");
        c.tokensSold = _uint(i, "tokensSold");
        c.amountIn = _uint(i, "amountIn");
        c.fee = _uint(i, "fee");
        string memory prefix = string.concat(".cases[", vm.toString(i), "]");
        if (c.isBuy) {
            c.tokensOut = _uint(i, "tokensOut");
            c.ethUsed = _uint(i, "ethUsed");
            assertFalse(vm.keyExistsJson(json, string.concat(prefix, ".ethOut")));
        } else {
            c.ethOut = _uint(i, "ethOut");
            assertFalse(vm.keyExistsJson(json, string.concat(prefix, ".tokensOut")));
            assertFalse(vm.keyExistsJson(json, string.concat(prefix, ".ethUsed")));
        }
    }

    function test_fixtureIsUpToDate() public view {
        assertEq(json, CurveFixtures.render(CurveFixtures.build()), "run: forge script script/GenerateFixtures.s.sol");
    }

    function test_fixtureShape() public view {
        assertEq(vm.parseJsonString(json, ".tradeFeeBps"), "100");
        assertGe(count, 40);
        uint256 completing;
        uint256 refunds;
        uint256 sells;
        uint256 sellsToZero;
        uint256 guards;
        uint256 nearThreshold;
        for (uint256 i; i < count; ++i) {
            CurveFixtures.Case memory c = _case(i);
            if (c.completes) ++completing;
            if (c.isBuy && c.ethUsed < c.amountIn) ++refunds;
            if (!c.isBuy) ++sells;
            if (!c.isBuy && c.amountIn == c.tokensSold) ++sellsToZero;
            if (c.isBuy && c.completes && _guardTriggers(c.realEthReserve, c.tokensSold, c.amountIn)) ++guards;
            if (c.isBuy && c.completes) {
                uint256 minEth = CurveMath.minEthToComplete(c.realEthReserve, c.tokensSold, FEE_BPS);
                if (c.amountIn <= minEth + 2) ++nearThreshold;
            }
        }
        assertGe(completing, 10, "completing buys");
        assertGe(refunds, 5, "completing buys with refund");
        assertGe(sells, 10, "sells");
        assertGe(sellsToZero, 3, "sells back to zero");
        assertGe(guards, 5, "minimal completing amounts hitting the 1-wei guard");
        assertGe(nearThreshold, 3, "completing buys within 2 wei of the minimal completing amount");
    }

    function test_fixtureMatchesCurveMath() public view {
        for (uint256 i; i < count; ++i) {
            CurveFixtures.Case memory c = _case(i);
            if (c.isBuy) {
                (uint256 out, uint256 used, uint256 fee) =
                    CurveMath.quoteBuy(c.realEthReserve, c.tokensSold, c.amountIn, FEE_BPS);
                assertEq(out, c.tokensOut, "tokensOut");
                assertEq(used, c.ethUsed, "ethUsed");
                assertEq(fee, c.fee, "fee");
                assertEq(out == CURVE_SUPPLY - c.tokensSold, c.completes, "completes");
                assertEq(c.ethOut, 0);
            } else {
                (uint256 ethOut, uint256 fee) = CurveMath.quoteSell(c.realEthReserve, c.tokensSold, c.amountIn, FEE_BPS);
                assertEq(ethOut, c.ethOut, "ethOut");
                assertEq(fee, c.fee, "fee");
                assertFalse(c.completes);
                assertEq(c.tokensOut, 0);
                assertEq(c.ethUsed, 0);
            }
        }
    }

    /// @dev Injects each case's curve state into a fresh mind and executes the trade on the launchpad.
    function test_fixtureReplaysOnLaunchpad() public {
        for (uint256 i; i < count; ++i) {
            CurveFixtures.Case memory c = _case(i);
            address token = _createMind();
            _inject(token, c.realEthReserve, c.tokensSold);
            if (c.isBuy) _replayBuy(token, c);
            else _replaySell(token, c);
        }
    }

    function _inject(address token, uint256 reserve, uint256 sold) internal {
        bytes32 slot = keccak256(abi.encode(token, CURVES_SLOT));
        vm.store(address(launchpad), slot, bytes32(reserve | (sold << 128)));
        IMindLaunchpad.CurveState memory s = launchpad.getCurve(token);
        assertEq(s.realEthReserve, reserve, "storage layout changed: update CURVES_SLOT");
        assertEq(s.tokensSold, sold, "storage layout changed: update CURVES_SLOT");
        assertEq(uint8(s.phase), uint8(IMindLaunchpad.CurvePhase.Bonding));
        // Back the injected reserve with ETH so sells can pay out.
        vm.deal(address(launchpad), address(launchpad).balance + reserve);
    }

    function _replayBuy(address token, CurveFixtures.Case memory c) internal {
        (uint256 qOut, uint256 qUsed, uint256 qFee) = launchpad.quoteBuy(token, c.amountIn);
        assertEq(qOut, c.tokensOut, "quoteBuy tokensOut");
        assertEq(qUsed, c.ethUsed, "quoteBuy ethUsed");
        assertEq(qFee, c.fee, "quoteBuy fee");

        vm.deal(alice, c.amountIn);
        vm.expectEmit(true, true, false, true, address(launchpad));
        emit IMindLaunchpad.Trade(
            token,
            alice,
            true,
            c.ethUsed,
            c.tokensOut,
            c.fee,
            c.realEthReserve + c.ethUsed - c.fee,
            c.tokensSold + c.tokensOut
        );
        vm.prank(alice);
        uint256 out = launchpad.buy{value: c.amountIn}(token, c.tokensOut, block.timestamp);
        assertEq(out, c.tokensOut);
        assertEq(alice.balance, c.amountIn - c.ethUsed, "refund");
        IMindLaunchpad.CurvePhase phase = launchpad.getCurve(token).phase;
        assertEq(phase == IMindLaunchpad.CurvePhase.Complete, c.completes, "phase");
        // Clean up the buyer's tokens so the next case starts from zero.
        vm.prank(alice);
        assertTrue(MindToken(token).transfer(BURN, out));
    }

    function _replaySell(address token, CurveFixtures.Case memory c) internal {
        (uint256 qOut, uint256 qFee) = launchpad.quoteSell(token, c.amountIn);
        assertEq(qOut, c.ethOut, "quoteSell ethOut");
        assertEq(qFee, c.fee, "quoteSell fee");

        vm.prank(address(launchpad));
        assertTrue(MindToken(token).transfer(bob, c.amountIn));
        uint256 before = bob.balance;
        vm.startPrank(bob);
        MindToken(token).approve(address(launchpad), c.amountIn);
        vm.expectEmit(true, true, false, true, address(launchpad));
        emit IMindLaunchpad.Trade(
            token,
            bob,
            false,
            c.ethOut,
            c.amountIn,
            c.fee,
            c.realEthReserve - c.ethOut - c.fee,
            c.tokensSold - c.amountIn
        );
        uint256 ethOut = launchpad.sell(token, c.amountIn, c.ethOut, block.timestamp);
        vm.stopPrank();
        assertEq(ethOut, c.ethOut);
        assertEq(bob.balance - before, c.ethOut);
    }
}
