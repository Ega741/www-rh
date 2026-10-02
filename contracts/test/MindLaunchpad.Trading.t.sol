// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MindToken} from "../src/MindToken.sol";
import {IMindLaunchpad} from "../src/interfaces/IMindLaunchpad.sol";
import {CurveMath} from "../src/libraries/CurveMath.sol";
import {BaseTest} from "./utils/BaseTest.sol";

/// @notice createMind, buy, sell, completion/refund, fee split and the related events.
contract MindLaunchpadTradingTest is BaseTest {
    // ---------------------------------------------------------------------------------------------
    // createMind
    // ---------------------------------------------------------------------------------------------

    function test_createMind_registersTokenAndMind() public {
        vm.expectEmit(false, true, false, true, address(launchpad));
        emit IMindLaunchpad.MindCreated(address(0), creator, "Mind One", "MIND", METADATA_URI, MODEL_ID, PERSONA_HASH);
        address token = _createMind();

        assertTrue(launchpad.isMind(token));
        assertEq(launchpad.mindsLength(), 1);
        assertEq(launchpad.mindAt(0), token);
        IMindLaunchpad.MindInfo memory info = launchpad.getMind(token);
        assertEq(info.creator, creator);
        assertEq(info.modelId, MODEL_ID);
        assertEq(info.personaHash, PERSONA_HASH);
        assertEq(info.metadataURI, METADATA_URI);
        assertEq(info.createdAt, block.timestamp);
        assertEq(uint8(info.status), uint8(IMindLaunchpad.MindStatus.Alive));

        IMindLaunchpad.CurveState memory c = launchpad.getCurve(token);
        assertEq(c.realEthReserve, 0);
        assertEq(c.tokensSold, 0);
        assertEq(uint8(c.phase), uint8(IMindLaunchpad.CurvePhase.Bonding));

        MindToken t = MindToken(token);
        assertEq(t.name(), "Mind One");
        assertEq(t.symbol(), "MIND");
        assertEq(t.decimals(), 18);
        assertEq(t.totalSupply(), TOTAL_SUPPLY);
        assertEq(t.balanceOf(address(launchpad)), TOTAL_SUPPLY);
        assertEq(t.launchpad(), address(launchpad));
        assertEq(t.creator(), creator);
        assertEq(launchpad.currentPrice(token), CurveMath.price(0, 0));
    }

    function test_createMind_withInitialBuy() public {
        uint256 ethIn = 0.5 ether;
        (uint256 quoteOut, uint256 quoteUsed, uint256 quoteFee) = CurveMath.quoteBuy(0, 0, ethIn, FEE_BPS);
        vm.prank(creator);
        address token =
            launchpad.createMind{value: ethIn}("Mind One", "MIND", METADATA_URI, MODEL_ID, PERSONA_HASH, quoteOut);
        assertEq(MindToken(token).balanceOf(creator), quoteOut);
        (uint256 reserve, uint256 sold) = _curve(token);
        assertEq(reserve, quoteUsed - quoteFee);
        assertEq(sold, quoteOut);
        assertEq(launchpad.mindBalance(token), quoteFee * 7000 / 10_000);
    }

    function test_createMind_initialBuySlippage() public {
        (uint256 quoteOut,,) = CurveMath.quoteBuy(0, 0, 1 ether, FEE_BPS);
        vm.prank(creator);
        vm.expectRevert(IMindLaunchpad.Slippage.selector);
        launchpad.createMind{value: 1 ether}("Mind One", "MIND", METADATA_URI, MODEL_ID, PERSONA_HASH, quoteOut + 1);
    }

    function test_createMind_creationFee() public {
        vm.prank(owner);
        launchpad.setCreationFee(0.01 ether);

        vm.prank(creator);
        vm.expectRevert(IMindLaunchpad.InsufficientCreationFee.selector);
        launchpad.createMind{value: 0.009 ether}("Mind One", "MIND", METADATA_URI, MODEL_ID, PERSONA_HASH, 0);

        vm.prank(creator);
        address token =
            launchpad.createMind{value: 0.01 ether}("Mind One", "MIND", METADATA_URI, MODEL_ID, PERSONA_HASH, 0);
        assertEq(launchpad.protocolBalance(), 0.01 ether);
        assertEq(launchpad.mindBalance(token), 0);
        (, uint256 sold) = _curve(token);
        assertEq(sold, 0, "no initial buy when msg.value == creationFee");

        // Fee + initial buy.
        vm.prank(creator);
        address token2 =
            launchpad.createMind{value: 0.11 ether}("Mind Two", "MIND2", METADATA_URI, MODEL_ID, PERSONA_HASH, 0);
        (uint256 out,, uint256 fee) = CurveMath.quoteBuy(0, 0, 0.1 ether, FEE_BPS);
        assertEq(MindToken(token2).balanceOf(creator), out);
        assertEq(launchpad.protocolBalance(), 0.02 ether + fee - fee * 7000 / 10_000);
    }

    function test_createMind_validation() public {
        string memory name65 = string(new bytes(65));
        string memory symbol17 = string(new bytes(17));
        string memory uri2049 = string(new bytes(2049));
        vm.startPrank(creator);
        vm.expectRevert(IMindLaunchpad.InvalidName.selector);
        launchpad.createMind("", "MIND", METADATA_URI, MODEL_ID, PERSONA_HASH, 0);
        vm.expectRevert(IMindLaunchpad.InvalidName.selector);
        launchpad.createMind(name65, "MIND", METADATA_URI, MODEL_ID, PERSONA_HASH, 0);
        vm.expectRevert(IMindLaunchpad.InvalidSymbol.selector);
        launchpad.createMind("Mind", "", METADATA_URI, MODEL_ID, PERSONA_HASH, 0);
        vm.expectRevert(IMindLaunchpad.InvalidSymbol.selector);
        launchpad.createMind("Mind", symbol17, METADATA_URI, MODEL_ID, PERSONA_HASH, 0);
        vm.expectRevert(IMindLaunchpad.MetadataTooLong.selector);
        launchpad.createMind("Mind", "MIND", uri2049, MODEL_ID, PERSONA_HASH, 0);
        vm.expectRevert(IMindLaunchpad.InvalidModel.selector);
        launchpad.createMind("Mind", "MIND", METADATA_URI, bytes32(0), PERSONA_HASH, 0);

        // Rule 1 order: name, symbol, metadata, model, then the creation fee.
        vm.expectRevert(IMindLaunchpad.MetadataTooLong.selector);
        launchpad.createMind("Mind", "MIND", uri2049, bytes32(0), PERSONA_HASH, 0);
        vm.stopPrank();
        vm.prank(owner);
        launchpad.setCreationFee(1 ether);
        vm.startPrank(creator);
        vm.expectRevert(IMindLaunchpad.InvalidName.selector);
        launchpad.createMind("", "", METADATA_URI, MODEL_ID, PERSONA_HASH, 0);
        vm.expectRevert(IMindLaunchpad.InvalidModel.selector);
        launchpad.createMind("Mind", "MIND", METADATA_URI, bytes32(0), PERSONA_HASH, 0);
        vm.stopPrank();
        vm.prank(owner);
        launchpad.setCreationFee(0);
        vm.startPrank(creator);

        // Boundaries are accepted.
        launchpad.createMind(string(new bytes(64)), string(new bytes(16)), string(new bytes(2048)), MODEL_ID, 0, 0);
        launchpad.createMind("M", "M", "", MODEL_ID, PERSONA_HASH, 0);
        vm.stopPrank();
        assertEq(launchpad.mindsLength(), 2);
    }

    // ---------------------------------------------------------------------------------------------
    // buy
    // ---------------------------------------------------------------------------------------------

    function test_buy_matchesQuoteAndEmits() public {
        address token = _createMind();
        uint256 ethIn = 1 ether;
        (uint256 out, uint256 used, uint256 fee) = launchpad.quoteBuy(token, ethIn);
        assertEq(used, ethIn);
        uint256 mindShare = fee * 7000 / 10_000;

        vm.expectEmit(true, false, false, true, address(launchpad));
        emit IMindLaunchpad.FeeAccrued(token, mindShare, fee - mindShare);
        vm.expectEmit(true, true, false, true, address(launchpad));
        emit IMindLaunchpad.Trade(token, alice, true, ethIn, out, fee, ethIn - fee, out);
        uint256 got = _buy(alice, token, ethIn);

        assertEq(got, out);
        assertEq(MindToken(token).balanceOf(alice), out);
        assertEq(MindToken(token).balanceOf(address(launchpad)), TOTAL_SUPPLY - out);
        assertEq(launchpad.mindBalance(token), mindShare);
        assertEq(launchpad.protocolBalance(), fee - mindShare);
        assertEq(address(launchpad).balance, ethIn);
        assertGt(launchpad.currentPrice(token), CurveMath.price(0, 0));
    }

    function test_buy_reverts() public {
        address token = _createMind();
        vm.startPrank(alice);
        vm.expectRevert(IMindLaunchpad.Expired.selector);
        launchpad.buy{value: 1 ether}(token, 0, block.timestamp - 1);
        vm.expectRevert(IMindLaunchpad.ZeroAmount.selector);
        launchpad.buy(token, 0, block.timestamp);
        vm.expectRevert(IMindLaunchpad.NotAMind.selector);
        launchpad.buy{value: 1 ether}(address(0xBEEF), 0, block.timestamp);
        (uint256 out,,) = launchpad.quoteBuy(token, 1 ether);
        vm.expectRevert(IMindLaunchpad.Slippage.selector);
        launchpad.buy{value: 1 ether}(token, out + 1, block.timestamp);
        vm.stopPrank();
    }

    function testFuzz_buy_matchesCurveMath(uint256 ethIn) public {
        address token = _createMind();
        ethIn = bound(ethIn, 1, 50 ether);
        (uint256 out, uint256 used, uint256 fee) = CurveMath.quoteBuy(0, 0, ethIn, FEE_BPS);
        uint256 balBefore = alice.balance;
        uint256 got = _buy(alice, token, ethIn);
        assertEq(got, out);
        assertEq(balBefore - alice.balance, used, "net ETH paid == ethUsed");
        (uint256 reserve, uint256 sold) = _curve(token);
        assertEq(reserve, used - fee);
        assertEq(sold, out);
        assertEq(launchpad.mindBalance(token) + launchpad.protocolBalance(), fee);
        assertEq(address(launchpad).balance, used);
    }

    // ---------------------------------------------------------------------------------------------
    // sell
    // ---------------------------------------------------------------------------------------------

    function test_sell_matchesQuoteAndEmits() public {
        address token = _createMind();
        uint256 bought = _buy(alice, token, 1 ether);
        (uint256 reserveBefore, uint256 soldBefore) = _curve(token);
        uint256 tokensIn = bought / 3;
        (uint256 ethOut, uint256 fee) = launchpad.quoteSell(token, tokensIn);
        uint256 mindBefore = launchpad.mindBalance(token);
        uint256 balBefore = alice.balance;

        vm.startPrank(alice);
        MindToken(token).approve(address(launchpad), tokensIn);
        vm.expectEmit(true, true, false, true, address(launchpad));
        emit IMindLaunchpad.Trade(
            token, alice, false, ethOut, tokensIn, fee, reserveBefore - ethOut - fee, soldBefore - tokensIn
        );
        uint256 got = launchpad.sell(token, tokensIn, ethOut, block.timestamp);
        vm.stopPrank();

        assertEq(got, ethOut);
        assertEq(alice.balance - balBefore, ethOut);
        assertEq(MindToken(token).balanceOf(alice), bought - tokensIn);
        assertEq(launchpad.mindBalance(token) - mindBefore, fee * 7000 / 10_000);
        (uint256 reserve, uint256 sold) = _curve(token);
        assertEq(reserve, reserveBefore - ethOut - fee);
        assertEq(sold, soldBefore - tokensIn);
    }

    function test_sell_reverts() public {
        address token = _createMind();
        uint256 bought = _buy(alice, token, 1 ether);
        vm.startPrank(alice);
        MindToken(token).approve(address(launchpad), type(uint256).max);
        vm.expectRevert(IMindLaunchpad.Expired.selector);
        launchpad.sell(token, 1e18, 0, block.timestamp - 1);
        vm.expectRevert(IMindLaunchpad.ZeroAmount.selector);
        launchpad.sell(token, 0, 0, block.timestamp);
        vm.expectRevert(IMindLaunchpad.ExceedsTokensSold.selector);
        launchpad.sell(token, bought + 1, 0, block.timestamp);
        (uint256 ethOut,) = launchpad.quoteSell(token, bought);
        vm.expectRevert(IMindLaunchpad.Slippage.selector);
        launchpad.sell(token, bought, ethOut + 1, block.timestamp);
        // A dust sell that would pay out nothing is refused.
        vm.expectRevert(IMindLaunchpad.ZeroAmount.selector);
        launchpad.sell(token, 1, 0, block.timestamp);
        vm.expectRevert(IMindLaunchpad.NotAMind.selector);
        launchpad.sell(address(0xBEEF), 1, 0, block.timestamp);
        vm.stopPrank();
        vm.expectRevert(IMindLaunchpad.ExceedsTokensSold.selector);
        launchpad.quoteSell(token, bought + 1);
        vm.expectRevert(IMindLaunchpad.ZeroAmount.selector);
        launchpad.quoteSell(token, 0);
        vm.expectRevert(IMindLaunchpad.ZeroAmount.selector);
        launchpad.quoteBuy(token, 0);
        vm.expectRevert(IMindLaunchpad.NotAMind.selector);
        launchpad.quoteBuy(address(0xBEEF), 1);
        vm.expectRevert(IMindLaunchpad.NotAMind.selector);
        launchpad.quoteSell(address(0xBEEF), 1);
        vm.expectRevert(IMindLaunchpad.NotAMind.selector);
        launchpad.currentPrice(address(0xBEEF));
    }

    function test_sell_withoutApprovalReverts() public {
        address token = _createMind();
        uint256 bought = _buy(alice, token, 1 ether);
        vm.prank(alice);
        vm.expectRevert();
        launchpad.sell(token, bought, 0, block.timestamp);
    }

    function test_sellEverythingBackToZero() public {
        address token = _createMind();
        uint256 a = _buy(alice, token, 1 ether);
        uint256 b = _buy(bob, token, 2 ether);
        _sell(alice, token, a);
        _sell(bob, token, b);
        (uint256 reserve, uint256 sold) = _curve(token);
        assertEq(sold, 0);
        // Rounding dust stays in the reserve, never negative.
        assertLt(reserve, 10);
        assertEq(MindToken(token).balanceOf(address(launchpad)), TOTAL_SUPPLY);
        assertGe(address(launchpad).balance, reserve + launchpad.mindBalance(token) + launchpad.protocolBalance());
    }

    function testFuzz_roundTripOnLaunchpadNeverProfits(uint256 seed, uint256 ethIn) public {
        address token = _createMind();
        seed = bound(seed, 0, 3 ether);
        if (seed > 0) _buy(bob, token, seed);
        ethIn = bound(ethIn, 1e9, 5 ether);
        uint256 balBefore = alice.balance;
        uint256 got = _buy(alice, token, ethIn);
        if (uint8(launchpad.getCurve(token).phase) != uint8(IMindLaunchpad.CurvePhase.Bonding)) return;
        (uint256 ethOut,) = launchpad.quoteSell(token, got);
        if (ethOut == 0) return;
        _sell(alice, token, got);
        assertLe(alice.balance, balBefore, "round trip profit");
    }

    // ---------------------------------------------------------------------------------------------
    // Completion
    // ---------------------------------------------------------------------------------------------

    function test_completingBuyCapsAndRefunds() public {
        address token = _createMind();
        _buy(bob, token, 1 ether);
        (uint256 reserve, uint256 sold) = _curve(token);
        uint256 ethIn = 10 ether;
        (uint256 out, uint256 used, uint256 fee) = CurveMath.quoteBuy(reserve, sold, ethIn, FEE_BPS);
        assertEq(out, CURVE_SUPPLY - sold);
        assertLt(used, ethIn);

        uint256 balBefore = alice.balance;
        vm.expectEmit(true, true, false, true, address(launchpad));
        emit IMindLaunchpad.Trade(token, alice, true, used, out, fee, reserve + used - fee, CURVE_SUPPLY);
        vm.expectEmit(true, false, false, true, address(launchpad));
        emit IMindLaunchpad.CurveCompleted(token, reserve + used - fee);
        _buy(alice, token, ethIn);

        assertEq(balBefore - alice.balance, used, "refund of ethIn - ethUsed");
        IMindLaunchpad.CurveState memory c = launchpad.getCurve(token);
        assertEq(uint8(c.phase), uint8(IMindLaunchpad.CurvePhase.Complete));
        assertEq(c.tokensSold, CURVE_SUPPLY);
        assertEq(c.realEthReserve, reserve + used - fee);
        assertEq(MindToken(token).balanceOf(address(launchpad)), LP_SUPPLY);
        assertEq(used, CurveMath.ethForTokens(reserve, sold, out, FEE_BPS));
        assertApproxEqAbs(c.realEthReserve, 4 ether, 1);
    }

    function test_completedCurveRejectsTrades() public {
        address token = _createMind();
        uint256 bought = _buy(alice, token, 10 ether);
        vm.prank(bob);
        vm.expectRevert(IMindLaunchpad.WrongPhase.selector);
        launchpad.buy{value: 1 ether}(token, 0, block.timestamp);
        vm.startPrank(alice);
        MindToken(token).approve(address(launchpad), bought);
        vm.expectRevert(IMindLaunchpad.WrongPhase.selector);
        launchpad.sell(token, bought, 0, block.timestamp);
        vm.stopPrank();
        vm.expectRevert(IMindLaunchpad.WrongPhase.selector);
        launchpad.quoteBuy(token, 1 ether);
        vm.expectRevert(IMindLaunchpad.WrongPhase.selector);
        launchpad.quoteSell(token, 1);
        // The curve price is still readable while Complete.
        (uint256 reserve,) = _curve(token);
        assertEq(launchpad.currentPrice(token), CurveMath.price(reserve, CURVE_SUPPLY));
    }

    function test_exactMinimalCompletingAmount_andOneTwoWeiLess() public {
        for (uint256 delta; delta <= 2; ++delta) {
            address token = _createMind();
            _buy(bob, token, 0.7 ether);
            (uint256 reserve, uint256 sold) = _curve(token);
            uint256 minEth = CurveMath.minEthToComplete(reserve, sold, FEE_BPS);
            uint256 balBefore = alice.balance;
            _buy(alice, token, minEth - delta);
            IMindLaunchpad.CurveState memory c = launchpad.getCurve(token);
            assertEq(balBefore - alice.balance, minEth - delta, "no refund");
            if (delta == 0) {
                assertEq(uint8(c.phase), uint8(IMindLaunchpad.CurvePhase.Complete));
                assertEq(c.tokensSold, CURVE_SUPPLY);
            } else {
                assertEq(uint8(c.phase), uint8(IMindLaunchpad.CurvePhase.Bonding));
                assertLt(c.tokensSold, CURVE_SUPPLY);
            }
        }
    }

    /// @dev Directive D6: at the threshold the gross-up `net' + fee'` can exceed `msg.value` by 1 wei; the
    ///      launchpad then charges exactly `msg.value` (no refund, no revert) and the fee absorbs the difference.
    function test_completingBuyRoundingGuard() public {
        (bool found, uint256 seed, uint256 minEth) = _findGuardState(1 ether, 1, 50);
        assertTrue(found);
        address token = _createMind();
        _buy(bob, token, seed);
        (uint256 reserve, uint256 sold) = _curve(token);
        assertTrue(_guardTriggers(reserve, sold, minEth));
        assertEq(CurveMath.ethForTokens(reserve, sold, CURVE_SUPPLY - sold, FEE_BPS), minEth + 1);

        uint256 netNeeded = _netNeeded(reserve, sold);
        uint256 feesBefore = launchpad.protocolBalance() + launchpad.mindBalance(token);
        uint256 balBefore = alice.balance;

        vm.expectEmit(true, true, false, true, address(launchpad));
        emit IMindLaunchpad.Trade(
            token, alice, true, minEth, CURVE_SUPPLY - sold, minEth - netNeeded, reserve + netNeeded, CURVE_SUPPLY
        );
        _buy(alice, token, minEth);

        assertEq(balBefore - alice.balance, minEth, "charged exactly msg.value, no refund");
        (uint256 reserveAfter, uint256 soldAfter) = _curve(token);
        assertEq(soldAfter, CURVE_SUPPLY);
        assertEq(reserveAfter, reserve + netNeeded, "reserve += net'");
        assertEq(launchpad.protocolBalance() + launchpad.mindBalance(token) - feesBefore, minEth - netNeeded);
    }

    function _netNeeded(uint256 reserve, uint256 sold) internal pure returns (uint256) {
        uint256 x = CurveMath.VIRTUAL_ETH + reserve;
        uint256 y = CurveMath.VIRTUAL_TOKENS - sold;
        uint256 yEnd = y - (CURVE_SUPPLY - sold);
        return (x * y + yEnd - 1) / yEnd - x;
    }

    function test_completingBuyRefundToRejectingContractReverts() public {
        address token = _createMind();
        Rejecter r = new Rejecter();
        vm.deal(address(r), 20 ether);
        vm.expectRevert(IMindLaunchpad.EthTransferFailed.selector);
        r.buy(launchpad, token, 10 ether);
        // A non-completing buy needs no refund and works.
        r.buy(launchpad, token, 1 ether);
    }

    function test_createMindWithCompletingInitialBuy() public {
        uint256 balBefore = creator.balance;
        vm.prank(creator);
        address token = launchpad.createMind{value: 20 ether}("Whale", "WHALE", METADATA_URI, MODEL_ID, PERSONA_HASH, 0);
        assertEq(uint8(launchpad.getCurve(token).phase), uint8(IMindLaunchpad.CurvePhase.Complete));
        assertEq(MindToken(token).balanceOf(creator), CURVE_SUPPLY);
        uint256 used = CurveMath.ethForTokens(0, 0, CURVE_SUPPLY, FEE_BPS);
        assertEq(balBefore - creator.balance, used);
    }

    // ---------------------------------------------------------------------------------------------
    // Fee split
    // ---------------------------------------------------------------------------------------------

    function testFuzz_feeSplit(uint16 tradeFeeBps, uint16 mindShareBps, uint256 ethIn) public {
        tradeFeeBps = uint16(bound(tradeFeeBps, 0, 500));
        mindShareBps = uint16(bound(mindShareBps, 0, 10_000));
        ethIn = bound(ethIn, 1e6, 3 ether);
        vm.prank(owner);
        launchpad.setFeeParams(IMindLaunchpad.FeeParams(tradeFeeBps, mindShareBps, 250));
        address token = _createMind();

        (uint256 out,, uint256 fee) = CurveMath.quoteBuy(0, 0, ethIn, tradeFeeBps);
        uint256 mindAmount = fee * mindShareBps / 10_000;
        vm.expectEmit(true, false, false, true, address(launchpad));
        emit IMindLaunchpad.FeeAccrued(token, mindAmount, fee - mindAmount);
        _buy(alice, token, ethIn);
        assertEq(launchpad.mindBalance(token), mindAmount);
        assertEq(launchpad.protocolBalance(), fee - mindAmount);

        (uint256 ethOut, uint256 sellFee) = launchpad.quoteSell(token, out);
        vm.assume(ethOut > 0);
        uint256 sellMind = sellFee * mindShareBps / 10_000;
        _sell(alice, token, out);
        assertEq(launchpad.mindBalance(token), mindAmount + sellMind);
        assertEq(launchpad.protocolBalance(), fee - mindAmount + sellFee - sellMind);
    }
}

/// @dev Buyer contract that rejects ETH (refunds fail).
contract Rejecter {
    function buy(IMindLaunchpad launchpad, address token, uint256 value) external {
        launchpad.buy{value: value}(token, 0, block.timestamp);
    }
}
