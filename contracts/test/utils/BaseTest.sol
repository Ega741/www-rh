// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {MindLaunchpad} from "../../src/MindLaunchpad.sol";
import {MindToken} from "../../src/MindToken.sol";
import {MockGraduator} from "../../src/MockGraduator.sol";
import {IMindLaunchpad} from "../../src/interfaces/IMindLaunchpad.sol";
import {CurveMath} from "../../src/libraries/CurveMath.sol";

/// @notice Shared fixture: a launchpad wired to a {MockGraduator}, funded actors and trading helpers.
abstract contract BaseTest is Test {
    MindLaunchpad internal launchpad;
    MockGraduator internal mockGraduator;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal computeTreasury = makeAddr("computeTreasury");
    address internal operator = makeAddr("operator");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant MODEL_ID = keccak256("claude-opus-5-5");
    bytes32 internal constant PERSONA_HASH = keccak256("a curious mind");
    string internal constant METADATA_URI = "runner://metadata/0123456789abcdef";

    uint256 internal constant TOTAL_SUPPLY = CurveMath.TOTAL_SUPPLY;
    uint256 internal constant CURVE_SUPPLY = CurveMath.CURVE_SUPPLY;
    uint256 internal constant LP_SUPPLY = CurveMath.LP_SUPPLY;
    uint256 internal constant FEE_BPS = 100;
    address internal constant BURN = 0x000000000000000000000000000000000000dEaD;

    function setUp() public virtual {
        vm.warp(1_750_000_000);
        launchpad = new MindLaunchpad(owner, treasury, computeTreasury, operator);
        mockGraduator = new MockGraduator(address(launchpad));
        vm.prank(owner);
        launchpad.setGraduator(address(mockGraduator));

        vm.deal(creator, 1000 ether);
        vm.deal(alice, 1000 ether);
        vm.deal(bob, 1000 ether);
        vm.deal(stranger, 1000 ether);
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    function _createMind() internal returns (address token) {
        vm.prank(creator);
        token = launchpad.createMind("Mind One", "MIND", METADATA_URI, MODEL_ID, PERSONA_HASH, 0);
    }

    function _buy(address who, address token, uint256 ethIn) internal returns (uint256 tokensOut) {
        vm.prank(who);
        tokensOut = launchpad.buy{value: ethIn}(token, 0, block.timestamp);
    }

    function _sell(address who, address token, uint256 tokensIn) internal returns (uint256 ethOut) {
        vm.startPrank(who);
        MindToken(token).approve(address(launchpad), tokensIn);
        ethOut = launchpad.sell(token, tokensIn, 0, block.timestamp);
        vm.stopPrank();
    }

    /// @dev Sells out the curve with one large buy from `who`.
    function _complete(address who, address token) internal {
        _buy(who, token, 10 ether);
        assertEq(uint8(launchpad.getCurve(token).phase), uint8(IMindLaunchpad.CurvePhase.Complete));
    }

    function _curve(address token) internal view returns (uint256 reserve, uint256 sold) {
        IMindLaunchpad.CurveState memory c = launchpad.getCurve(token);
        return (c.realEthReserve, c.tokensSold);
    }

    function _status(address token) internal view returns (IMindLaunchpad.MindStatus) {
        return launchpad.getMind(token).status;
    }

    /// @dev Whether buying `ethIn` from (`reserve`, `sold`) takes the capped (completing) path and hits the
    ///      rounding guard, i.e. the recomputed `net' + fee'` exceeds `ethIn`.
    function _guardTriggers(uint256 reserve, uint256 sold, uint256 ethIn) internal pure returns (bool) {
        uint256 x = CurveMath.VIRTUAL_ETH + reserve;
        uint256 y = CurveMath.VIRTUAL_TOKENS - sold;
        uint256 net = ethIn - ethIn * FEE_BPS / 10_000;
        uint256 rawOut = y - Math.ceilDiv(x * y, x + net);
        uint256 remaining = CURVE_SUPPLY - sold;
        return rawOut > remaining && CurveMath.ethForTokens(reserve, sold, remaining, FEE_BPS) > ethIn;
    }

    /// @dev Scans states reachable from a fresh curve by one buy of `startEth + i * step` for one where buying
    ///      exactly `minEthToComplete` triggers the rounding guard. Returns the initial buy and completing amount.
    function _findGuardState(uint256 startEth, uint256 step, uint256 tries)
        internal
        pure
        returns (bool found, uint256 initialBuy, uint256 completingEth)
    {
        for (uint256 i; i < tries; ++i) {
            uint256 seed = startEth + i * step;
            (uint256 out,, uint256 fee) = CurveMath.quoteBuy(0, 0, seed, FEE_BPS);
            uint256 reserve = seed - fee;
            uint256 minEth = CurveMath.minEthToComplete(reserve, out, FEE_BPS);
            if (_guardTriggers(reserve, out, minEth)) return (true, seed, minEth);
        }
    }
}
