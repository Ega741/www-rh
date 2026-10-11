// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {CreditMath} from "../src/CreditMath.sol";

/// @title GenerateFixtures
/// @notice Writes `packages/shared/fixtures/quote.json`: reference quotes computed by `CreditMath` that the
///         TypeScript shared-package credit math (packages/shared) is tested against. CI regenerates and diffs the file.
/// @dev Run with `forge script script/GenerateFixtures.s.sol` (no RPC / broadcast needed).
contract GenerateFixtures is Script {
    struct Case {
        uint256 amount;
        uint256 priceE18;
        uint8 decimals;
    }

    function run() external {
        Case[] memory cases = _cases();
        string memory json = "[";
        for (uint256 i = 0; i < cases.length; i++) {
            Case memory c = cases[i];
            uint256 usd = CreditMath.usdMicro(c.amount, c.priceE18, c.decimals);
            uint256 back = CreditMath.tokensForUsdMicro(usd, c.priceE18, c.decimals);
            string memory k = string.concat("case", vm.toString(i));
            vm.serializeString(k, "amount", vm.toString(c.amount));
            vm.serializeString(k, "priceE18", vm.toString(c.priceE18));
            vm.serializeUint(k, "decimals", c.decimals);
            vm.serializeString(k, "usdMicro", vm.toString(usd));
            string memory obj = vm.serializeString(k, "tokensBack", vm.toString(back));
            json = string.concat(json, i == 0 ? "" : ",", obj);
        }
        json = string.concat(json, "]");

        string memory dir = string.concat(vm.projectRoot(), "/../packages/shared/fixtures");
        vm.createDir(dir, true);
        string memory path = string.concat(dir, "/quote.json");
        vm.writeJson(json, path);
        console.log("Wrote", cases.length, "cases to", path);
    }

    /// @dev Edge cases: 0, 1 wei, 1e36; decimals 6, 8, 18; prices 1e9 … 1e24; rounding boundaries.
    function _cases() internal pure returns (Case[] memory cases) {
        cases = new Case[](30);
        uint256 n;
        // 18 decimals
        cases[n++] = Case(0, 2_500_000_000_000_000, 18); // zero amount
        cases[n++] = Case(1, 2_500_000_000_000_000, 18); // 1 wei → 0
        cases[n++] = Case(1, 1e24, 18); // 1 wei at $1M → 0
        cases[n++] = Case(1e18, 2_500_000_000_000_000, 18); // 1 token at $0.0025
        cases[n++] = Case(1000e18, 2_500_000_000_000_000, 18); // spec example: $2.50
        cases[n++] = Case(1000e18, 1e16, 18); // anvil e2e: $10
        cases[n++] = Case(1e18, 1e18, 18); // $1
        cases[n++] = Case(1e18 + 1, 1e18, 18); // floor stays $1
        cases[n++] = Case(3_333_333_333_333_333_333, 3e17, 18); // 999_999 µUSD (floor)
        cases[n++] = Case(123_456_789e12, 7e15, 18); // odd rounding
        cases[n++] = Case(33, 3e18, 18); // dust → 0
        cases[n++] = Case(2e18, 5e17, 18); // $1
        cases[n++] = Case(1e24, 1e9, 18); // 1M tokens at $1e-9
        cases[n++] = Case(type(uint128).max, 1e16, 18); // large amount
        cases[n++] = Case(1e36, 1e9, 18); // 1e36 edge, low price
        cases[n++] = Case(1e36, 1e16, 18); // 1e36 edge, $0.01
        cases[n++] = Case(1e36, 1e24, 18); // 1e36 edge, high price
        // 6 decimals
        cases[n++] = Case(0, 1e9, 6);
        cases[n++] = Case(1, 1e9, 6); // 1 unit → 0
        cases[n++] = Case(1, 1e24, 6); // 1 unit at $1M → 1 USD
        cases[n++] = Case(1e6, 1e18, 6); // $1
        cases[n++] = Case(1e6, 2_500_000_000_000_000, 6); // $0.0025
        cases[n++] = Case(999_999, 1e18, 6); // 999_999 µUSD
        cases[n++] = Case(1e36, 1e24, 6); // 1e36 edge
        // 8 decimals
        cases[n++] = Case(1e8, 1e18, 8); // $1
        cases[n++] = Case(1e8, 1e9, 8); // 0.001 µUSD → 0
        cases[n++] = Case(1, 1e24, 8); // 1 sat at $1M → 10_000 µUSD
        cases[n++] = Case(5e8, 123_456_789_000, 8); // rounding
        cases[n++] = Case(7e35, 9e23, 8); // large
        cases[n++] = Case(1e36, 1e9, 8); // 1e36 edge
        assert(n == cases.length);
    }
}
