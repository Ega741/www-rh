// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CreditMath} from "../src/CreditMath.sol";

/// @dev Exposes the internal library functions as external calls (for `expectRevert` and fuzzing).
contract CreditMathHarness {
    function usdMicro(uint256 amount, uint256 priceE18, uint8 decimals) external pure returns (uint256) {
        return CreditMath.usdMicro(amount, priceE18, decimals);
    }

    function tokensForUsdMicro(uint256 usd, uint256 priceE18, uint8 decimals) external pure returns (uint256) {
        return CreditMath.tokensForUsdMicro(usd, priceE18, decimals);
    }
}

contract CreditMathTest is Test {
    CreditMathHarness internal m;

    uint256 internal constant MAX_AMOUNT = 1e36;
    uint256 internal constant MAX_PRICE = 1e30;
    uint8 internal constant MAX_DECIMALS = 36;

    function setUp() public {
        m = new CreditMathHarness();
    }

    // ─── usdMicro ─────────────────────────────────────────────────────────────────────────────────────

    function test_usdMicro_specExample() public view {
        // 1000 BEAGLE at $0.0025 = $2.50
        assertEq(m.usdMicro(1000e18, 2_500_000_000_000_000, 18), 2_500_000);
    }

    function test_usdMicro_zeroAmount() public view {
        assertEq(m.usdMicro(0, 1e18, 18), 0);
        assertEq(m.usdMicro(0, 1e9, 6), 0);
    }

    function test_usdMicro_oneWeiRoundsToZero() public view {
        assertEq(m.usdMicro(1, 2_500_000_000_000_000, 18), 0);
        assertEq(m.usdMicro(1, 1e24, 18), 0); // 1e24 / 1e30
    }

    function test_usdMicro_floors() public view {
        // 3.333…e18 tokens at $0.30 = $0.99999999… → 999_999 µUSD
        assertEq(m.usdMicro(3_333_333_333_333_333_333, 3e17, 18), 999_999);
        // 1e18 + 1 wei at $1 → still exactly $1
        assertEq(m.usdMicro(1e18 + 1, 1e18, 18), 1_000_000);
    }

    function test_usdMicro_otherDecimals() public view {
        assertEq(m.usdMicro(1e6, 1e18, 6), 1_000_000); // 1 token (6 dec) at $1
        assertEq(m.usdMicro(1e8, 1e18, 8), 1_000_000); // 1 token (8 dec) at $1
        assertEq(m.usdMicro(1, 1e24, 6), 1_000_000); // 1 unit of a 6-dec token at $1M
        assertEq(m.usdMicro(1e36, 1e30, 36), 1e18);
    }

    function test_usdMicro_zeroPriceIsZero() public view {
        assertEq(m.usdMicro(1e18, 0, 18), 0);
    }

    function test_usdMicro_largeNoOverflow() public view {
        // 1e36 * 1e30 = 1e66 as a 512-bit intermediate; result 1e54 fits.
        assertEq(m.usdMicro(1e36, 1e30, 0), 1e54);
    }

    // ─── tokensForUsdMicro ────────────────────────────────────────────────────────────────────────────

    function test_tokensForUsdMicro_specExample() public view {
        assertEq(m.tokensForUsdMicro(2_500_000, 2_500_000_000_000_000, 18), 1000e18);
    }

    function test_tokensForUsdMicro_ceils() public view {
        // 1 µUSD at $3 / token → 1e30 / 3e18 = 333_333_333_333.33… → 333_333_333_334
        assertEq(m.tokensForUsdMicro(1, 3e18, 18), 333_333_333_334);
    }

    function test_tokensForUsdMicro_zeroUsd() public view {
        assertEq(m.tokensForUsdMicro(0, 1e18, 18), 0);
    }

    function test_tokensForUsdMicro_otherDecimals() public view {
        assertEq(m.tokensForUsdMicro(1_000_000, 1e18, 6), 1e6);
        assertEq(m.tokensForUsdMicro(1_000_000, 1e18, 8), 1e8);
    }

    function test_tokensForUsdMicro_revertsOnZeroPrice() public {
        vm.expectRevert(CreditMath.ZeroPrice.selector);
        m.tokensForUsdMicro(1, 0, 18);
    }

    // ─── Fuzz ─────────────────────────────────────────────────────────────────────────────────────────

    /// forge-config: default.fuzz.runs = 512
    function testFuzz_usdMicro_matchesReferenceAndNoOverflow(uint256 amount, uint256 price, uint8 decimals)
        public
        view
    {
        amount = bound(amount, 0, MAX_AMOUNT);
        price = bound(price, 0, MAX_PRICE);
        decimals = uint8(bound(decimals, 0, MAX_DECIMALS));
        // amount * price <= 1e66 < 2^256, so plain arithmetic is a valid reference here.
        uint256 expected = (amount * price) / 10 ** (uint256(decimals) + 12);
        assertEq(m.usdMicro(amount, price, decimals), expected);
    }

    function testFuzz_usdMicro_monotonicInAmount(uint256 a1, uint256 a2, uint256 price, uint8 decimals) public view {
        a1 = bound(a1, 0, MAX_AMOUNT);
        a2 = bound(a2, 0, MAX_AMOUNT);
        price = bound(price, 0, MAX_PRICE);
        decimals = uint8(bound(decimals, 0, MAX_DECIMALS));
        if (a1 > a2) (a1, a2) = (a2, a1);
        assertLe(m.usdMicro(a1, price, decimals), m.usdMicro(a2, price, decimals));
    }

    function testFuzz_usdMicro_monotonicInPrice(uint256 amount, uint256 p1, uint256 p2, uint8 decimals) public view {
        amount = bound(amount, 0, MAX_AMOUNT);
        p1 = bound(p1, 0, MAX_PRICE);
        p2 = bound(p2, 0, MAX_PRICE);
        decimals = uint8(bound(decimals, 0, MAX_DECIMALS));
        if (p1 > p2) (p1, p2) = (p2, p1);
        assertLe(m.usdMicro(amount, p1, decimals), m.usdMicro(amount, p2, decimals));
    }

    function testFuzz_usdMicro_additive(uint256 a1, uint256 a2, uint256 price, uint8 decimals) public view {
        a1 = bound(a1, 0, MAX_AMOUNT / 2);
        a2 = bound(a2, 0, MAX_AMOUNT / 2);
        price = bound(price, 0, MAX_PRICE);
        decimals = uint8(bound(decimals, 0, MAX_DECIMALS));
        // Splitting a burn never yields more credit than one burn, and at most 1 µUSD less.
        uint256 whole = m.usdMicro(a1 + a2, price, decimals);
        uint256 parts = m.usdMicro(a1, price, decimals) + m.usdMicro(a2, price, decimals);
        assertLe(parts, whole);
        assertLe(whole - parts, 1);
    }

    function testFuzz_tokensForUsdMicro_isExactCeil(uint256 usd, uint256 price, uint8 decimals) public view {
        usd = bound(usd, 0, 1e24); // up to 1e18 USD
        price = bound(price, 1, MAX_PRICE);
        decimals = uint8(bound(decimals, 0, MAX_DECIMALS));
        uint256 tokens = m.tokensForUsdMicro(usd, price, decimals);
        // tokens is worth at least usd …
        assertGe(m.usdMicro(tokens, price, decimals), usd);
        // … and one unit less is worth strictly less than usd.
        if (tokens > 0) assertLt(m.usdMicro(tokens - 1, price, decimals), usd);
    }

    function testFuzz_tokensForUsdMicro_monotonic(uint256 u1, uint256 u2, uint256 price, uint8 decimals) public view {
        u1 = bound(u1, 0, 1e24);
        u2 = bound(u2, 0, 1e24);
        price = bound(price, 1, MAX_PRICE);
        decimals = uint8(bound(decimals, 0, MAX_DECIMALS));
        if (u1 > u2) (u1, u2) = (u2, u1);
        assertLe(m.tokensForUsdMicro(u1, price, decimals), m.tokensForUsdMicro(u2, price, decimals));
    }

    /// usd → tokens → usd' never loses value and overshoots by at most the worth of one raw token unit
    /// (exact whenever one raw unit is worth ≤ 1 µUSD, i.e. priceE18 <= 10**(decimals + 12)).
    function testFuzz_roundTrip_usdToTokensToUsd(uint256 usd, uint256 price, uint8 decimals) public view {
        usd = bound(usd, 0, 1e24);
        price = bound(price, 1, MAX_PRICE);
        decimals = uint8(bound(decimals, 0, MAX_DECIMALS));
        uint256 scale = 10 ** (uint256(decimals) + 12);
        uint256 tokens = m.tokensForUsdMicro(usd, price, decimals);
        uint256 back = m.usdMicro(tokens, price, decimals);
        assertGe(back, usd);
        assertLe(back - usd, (price + scale - 1) / scale);
        if (price <= scale) assertEq(back, usd);
    }

    /// tokens → usd → tokens' never charges more than the original and is short by at most one µUSD's
    /// worth of tokens (exact whenever one raw unit is worth ≥ 1 µUSD, i.e. priceE18 >= 10**(decimals + 12)).
    function testFuzz_roundTrip_tokensToUsdToTokens(uint256 amount, uint256 price, uint8 decimals) public view {
        amount = bound(amount, 0, MAX_AMOUNT);
        price = bound(price, 1, MAX_PRICE);
        decimals = uint8(bound(decimals, 0, MAX_DECIMALS));
        uint256 scale = 10 ** (uint256(decimals) + 12);
        uint256 usd = m.usdMicro(amount, price, decimals);
        uint256 back = m.tokensForUsdMicro(usd, price, decimals);
        assertLe(back, amount);
        assertLe(amount - back, scale / price + 1);
        if (price >= scale) assertEq(back, amount);
    }
}
