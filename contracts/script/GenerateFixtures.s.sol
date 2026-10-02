// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {CurveFixtures} from "./CurveFixtures.sol";

/// @title GenerateFixtures
/// @notice Writes `packages/shared/fixtures/curve.json`, the bonding-curve equivalence fixture checked by both
///         `forge test` (test/Fixture.t.sol) and the TypeScript mirror's vitest suite (SPEC §1).
/// @dev `forge script script/GenerateFixtures.s.sol` (no RPC, no broadcast).
contract GenerateFixtures is Script {
    function run() external {
        CurveFixtures.Case[] memory cases = CurveFixtures.build();
        vm.writeFile(CurveFixtures.PATH, CurveFixtures.render(cases));
        console2.log("wrote %d cases to %s", cases.length, CurveFixtures.PATH);
    }
}
