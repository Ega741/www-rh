// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";

import {CurveMath} from "../src/libraries/CurveMath.sol";

/// @title CurveFixtures
/// @notice Deterministic builder of the curve equivalence fixture (`packages/shared/fixtures/curve.json`): every
///         case is a `CurveMath.quoteBuy` / `quoteSell` evaluated at the default `tradeFeeBps` (100). Shared by
///         `script/GenerateFixtures.s.sol` (writes the file) and `test/Fixture.t.sol` (checks the checked-in file
///         is current and replays every case on a real {MindLaunchpad}).
library CurveFixtures {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice Trade fee used for every case.
    uint256 internal constant FEE_BPS = 100;
    /// @notice Repo-relative path (from `contracts/`) of the fixture file.
    string internal constant PATH = "../packages/shared/fixtures/curve.json";

    /// @notice One fixture case. Fields not applicable to the op are 0 (`ethOut` for buys; `tokensOut`, `ethUsed`
    ///         for sells).
    struct Case {
        bool isBuy;
        uint256 realEthReserve;
        uint256 tokensSold;
        uint256 amountIn;
        uint256 tokensOut;
        uint256 ethOut;
        uint256 ethUsed;
        uint256 fee;
        bool completes;
    }

    /// @dev Growable case list (memory).
    struct List {
        Case[] items;
        uint256 length;
    }

    /// @notice All cases, in file order.
    function build() internal pure returns (Case[] memory cases) {
        List memory l = List(new Case[](128), 0);

        // A. Buys on a fresh curve, from 1 wei to just below completion.
        uint256[12] memory freshBuys = [
            uint256(1),
            100,
            1e9,
            1e12,
            1e15,
            0.01 ether,
            0.1 ether,
            0.5 ether,
            1 ether,
            2 ether,
            3 ether,
            4 ether
        ];
        for (uint256 i; i < freshBuys.length; ++i) {
            _buy(l, 0, 0, freshBuys[i]);
        }

        // B. A trading walk: each case starts where the previous one ended; it sells back to zero twice.
        (uint256 r, uint256 s) = (0, 0);
        (r, s) = _buy(l, r, s, 0.3 ether);
        (r, s) = _buy(l, r, s, 1.2 ether);
        (r, s) = _sell(l, r, s, s / 3);
        (r, s) = _buy(l, r, s, 0.05 ether);
        (r, s) = _sell(l, r, s, s / 10);
        (r, s) = _buy(l, r, s, 2 ether);
        (uint256 walkR, uint256 walkS) = (r, s); // a state with k > k0, reused in C
        (r, s) = _sell(l, r, s, s / 2);
        (r, s) = _buy(l, r, s, 0.777 ether);
        (r, s) = _sell(l, r, s, s); // back to zero tokens sold (rounding dust stays in the reserve)
        (r, s) = _buy(l, r, s, 1 ether);
        (r, s) = _sell(l, r, s, s); // and back to zero again

        // C. Completion from several states: the exact minimal completing amount, 1 and 2 wei less (do not
        //    complete), 1 wei more and large overpayments (capped + refund).
        _completion(l, 0, 0);
        (uint256 r1, uint256 s1) = _state(1 ether);
        _completion(l, r1, s1);
        (uint256 r2, uint256 s2) = _state(3.5 ether);
        _completion(l, r2, s2);
        (uint256 r3, uint256 s3) = _state(4.04 ether); // a few hundred thousand tokens before sell-out
        _completion(l, r3, s3);
        _completion(l, walkR, walkS);

        // D. Sells at several states, including selling everything back to zero.
        _sell(l, r1, s1, 1e18);
        _sell(l, r1, s1, s1);
        _sell(l, r2, s2, 1_000_000e18);
        _sell(l, r2, s2, s2 / 2);
        _sell(l, r2, s2, s2);
        _sell(l, r3, s3, 1e18);
        _sell(l, r3, s3, s3);
        _sell(l, walkR, walkS, walkS);

        // E. More minimal completing amounts (1-wei guard) at neighbouring states.
        _edgeCases(l);

        cases = new Case[](l.length);
        for (uint256 i; i < l.length; ++i) {
            cases[i] = l.items[i];
        }
    }

    /// @notice Renders `cases` as the fixture JSON (decimal strings, one case per line).
    function render(Case[] memory cases) internal pure returns (string memory json) {
        json = string.concat('{\n  "tradeFeeBps": ', VM.toString(FEE_BPS), ',\n  "cases": [\n');
        for (uint256 i; i < cases.length; ++i) {
            json = string.concat(json, "    ", _renderCase(cases[i]), i + 1 < cases.length ? ",\n" : "\n");
        }
        json = string.concat(json, "  ]\n}\n");
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    function _renderCase(Case memory c) private pure returns (string memory) {
        string memory head = string.concat(
            '{"op": "',
            c.isBuy ? "buy" : "sell",
            '", "realEthReserve": "',
            VM.toString(c.realEthReserve),
            '", "tokensSold": "',
            VM.toString(c.tokensSold),
            '", "amountIn": "',
            VM.toString(c.amountIn)
        );
        return string.concat(
            head,
            '", "tokensOut": "',
            VM.toString(c.tokensOut),
            '", "ethOut": "',
            VM.toString(c.ethOut),
            '", "ethUsed": "',
            VM.toString(c.ethUsed),
            '", "fee": "',
            VM.toString(c.fee),
            '", "completes": ',
            c.completes ? "true" : "false",
            "}"
        );
    }

    function _push(List memory l, Case memory c) private pure {
        l.items[l.length++] = c;
    }

    /// @dev State after one buy of `ethIn` on a fresh curve.
    function _state(uint256 ethIn) private pure returns (uint256 reserve, uint256 sold) {
        (uint256 out, uint256 used, uint256 fee) = CurveMath.quoteBuy(0, 0, ethIn, FEE_BPS);
        return (used - fee, out);
    }

    function _buy(List memory l, uint256 reserve, uint256 sold, uint256 ethIn)
        private
        pure
        returns (uint256 newReserve, uint256 newSold)
    {
        (uint256 out, uint256 used, uint256 fee) = CurveMath.quoteBuy(reserve, sold, ethIn, FEE_BPS);
        bool completes = out == CurveMath.CURVE_SUPPLY - sold;
        _push(l, Case(true, reserve, sold, ethIn, out, 0, used, fee, completes));
        return (reserve + used - fee, sold + out);
    }

    function _sell(List memory l, uint256 reserve, uint256 sold, uint256 tokensIn)
        private
        pure
        returns (uint256 newReserve, uint256 newSold)
    {
        (uint256 ethOut, uint256 fee) = CurveMath.quoteSell(reserve, sold, tokensIn, FEE_BPS);
        _push(l, Case(false, reserve, sold, tokensIn, 0, ethOut, 0, fee, false));
        return (reserve - ethOut - fee, sold - tokensIn);
    }

    function _completion(List memory l, uint256 reserve, uint256 sold) private pure {
        uint256 minEth = CurveMath.minEthToComplete(reserve, sold, FEE_BPS);
        _buy(l, reserve, sold, minEth);
        _buy(l, reserve, sold, minEth - 1);
        _buy(l, reserve, sold, minEth - 2);
        _buy(l, reserve, sold, minEth + 1);
        _buy(l, reserve, sold, 10 ether);
        _buy(l, reserve, sold, 1000 ether);
    }

    /// @dev Minimal completing amounts (and 1 wei less) at three neighbouring states reached by fresh buys of
    ///      `0.6 ether + i` wei. With `tradeFeeBps = 100` the gross-up `net' + fee'` of the capped path is always
    ///      exactly `minEthToComplete + 1`, so each of these exercises the 1-wei guard (`ethUsed` clamped to `ethIn`).
    function _edgeCases(List memory l) private pure {
        for (uint256 i; i < 3; ++i) {
            (uint256 reserve, uint256 sold) = _state(0.6 ether + i);
            uint256 minEth = CurveMath.minEthToComplete(reserve, sold, FEE_BPS);
            _buy(l, reserve, sold, minEth);
            _buy(l, reserve, sold, minEth - 1);
        }
    }
}
