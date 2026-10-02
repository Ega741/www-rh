// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {MindLaunchpad} from "../../src/MindLaunchpad.sol";
import {MindToken} from "../../src/MindToken.sol";
import {IMindLaunchpad} from "../../src/interfaces/IMindLaunchpad.sol";
import {CurveMath} from "../../src/libraries/CurveMath.sol";
import {ConfigurableGraduator} from "../mocks/ConfigurableGraduator.sol";

/// @notice Drives the launchpad with random but valid user / operator / owner actions.
contract LaunchpadHandler is Test {
    MindLaunchpad public immutable launchpad;
    ConfigurableGraduator public immutable graduator;
    address public immutable owner;
    address public immutable operator;

    address[] public actors;
    address[] public tokens;
    mapping(address token => uint256) public lastK;
    bool public kDecreased;

    mapping(bytes32 action => uint256) public calls;

    constructor(MindLaunchpad launchpad_, ConfigurableGraduator graduator_, address owner_, address operator_) {
        launchpad = launchpad_;
        graduator = graduator_;
        owner = owner_;
        operator = operator_;
        for (uint256 i; i < 4; ++i) {
            address a = makeAddr(string(abi.encodePacked("actor", vm.toString(i))));
            actors.push(a);
            vm.deal(a, 10_000 ether);
        }
        // Start with two live curves so trading actions have targets from the first call.
        for (uint256 i; i < 2; ++i) {
            vm.prank(actors[i]);
            address token = launchpad_.createMind{value: 0.5 ether}("Mind", "MIND", "ipfs://x", keccak256("m"), 0, 0);
            tokens.push(token);
            _trackK(token);
        }
    }

    function tokensLength() external view returns (uint256) {
        return tokens.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _token(uint256 seed) internal view returns (address token, bool ok) {
        if (tokens.length == 0) return (address(0), false);
        return (tokens[seed % tokens.length], true);
    }

    function _phase(address token) internal view returns (IMindLaunchpad.CurvePhase) {
        return launchpad.getCurve(token).phase;
    }

    function _trackK(address token) internal {
        IMindLaunchpad.CurveState memory c = launchpad.getCurve(token);
        if (c.phase != IMindLaunchpad.CurvePhase.Bonding && c.phase != IMindLaunchpad.CurvePhase.Complete) return;
        uint256 k = (CurveMath.VIRTUAL_ETH + c.realEthReserve) * (CurveMath.VIRTUAL_TOKENS - c.tokensSold);
        if (k < lastK[token]) kDecreased = true;
        lastK[token] = k;
    }

    // ---------------------------------------------------------------------------------------------
    // Actions
    // ---------------------------------------------------------------------------------------------

    function createMind(uint256 actorSeed, uint256 ethIn) external {
        if (tokens.length >= 6) return;
        address a = _actor(actorSeed);
        ethIn = bound(ethIn, 0, 5 ether);
        vm.prank(a);
        address token = launchpad.createMind{value: ethIn}("Mind", "MIND", "ipfs://x", keccak256("m"), 0, 0);
        tokens.push(token);
        _trackK(token);
        calls["createMind"]++;
    }

    function buy(uint256 actorSeed, uint256 tokenSeed, uint256 ethIn) external {
        (address token, bool ok) = _token(tokenSeed);
        if (!ok || _phase(token) != IMindLaunchpad.CurvePhase.Bonding) return;
        ethIn = bound(ethIn, 1e9, 5 ether);
        address a = _actor(actorSeed);
        vm.prank(a);
        launchpad.buy{value: ethIn}(token, 0, block.timestamp);
        _trackK(token);
        calls["buy"]++;
    }

    /// @dev Sells on Bonding curves and, once the graduation grace has elapsed, on Complete curves (which reopens
    ///      them).
    function sell(uint256 actorSeed, uint256 tokenSeed, uint256 bps) external {
        (address token, bool ok) = _token(tokenSeed);
        if (!ok) return;
        IMindLaunchpad.CurvePhase phase = _phase(token);
        bool reopening = phase == IMindLaunchpad.CurvePhase.Complete && _graceElapsed(token);
        if (phase != IMindLaunchpad.CurvePhase.Bonding && !reopening) return;
        address a = _actor(actorSeed);
        uint256 amount = MindToken(token).balanceOf(a) * bound(bps, 1, 10_000) / 10_000;
        if (amount == 0) return;
        (uint256 ethOut,) = launchpad.quoteSell(token, amount);
        if (ethOut == 0) return;
        vm.startPrank(a);
        MindToken(token).approve(address(launchpad), amount);
        launchpad.sell(token, amount, ethOut, block.timestamp);
        vm.stopPrank();
        _trackK(token);
        calls["sell"]++;
        if (reopening) {
            assertEq(uint8(_phase(token)), uint8(IMindLaunchpad.CurvePhase.Bonding), "post-grace sell reopens");
            calls["sellAfterGrace"]++;
        }
    }

    /// @dev Jumps past the graduation grace of a Complete curve so post-grace sells get exercised.
    function warpPastGrace(uint256 tokenSeed, uint256 extra) external {
        (address token, bool ok) = _token(tokenSeed);
        if (!ok || _phase(token) != IMindLaunchpad.CurvePhase.Complete || _graceElapsed(token)) return;
        uint256 target = uint256(launchpad.completedAt(token)) + launchpad.graduationGrace() + bound(extra, 0, 1 hours);
        vm.warp(target);
        calls["warpPastGrace"]++;
    }

    function _graceElapsed(address token) internal view returns (bool) {
        return block.timestamp >= uint256(launchpad.completedAt(token)) + launchpad.graduationGrace();
    }

    function graduate(uint256 tokenSeed, uint256 returnBps) external {
        (address token, bool ok) = _token(tokenSeed);
        if (!ok || _phase(token) != IMindLaunchpad.CurvePhase.Complete) return;
        graduator.setGraduateBehaviour(bound(returnBps, 0, 10_000), 0);
        launchpad.graduate(token);
        calls["graduate"]++;
    }

    function harvest(uint256 tokenSeed, uint256 ethOut) external {
        (address token, bool ok) = _token(tokenSeed);
        if (!ok || _phase(token) != IMindLaunchpad.CurvePhase.Graduated) return;
        ethOut = bound(ethOut, 0, 0.1 ether);
        vm.deal(address(graduator), address(graduator).balance + ethOut);
        graduator.setHarvestBehaviour(ethOut, 0, 0);
        launchpad.harvest(token);
        calls["harvest"]++;
    }

    function fundMind(uint256 actorSeed, uint256 tokenSeed, uint256 amount) external {
        (address token, bool ok) = _token(tokenSeed);
        if (!ok) return;
        amount = bound(amount, 1, 1 ether);
        vm.prank(_actor(actorSeed));
        launchpad.fundMind{value: amount}(token);
        calls["fundMind"]++;
    }

    function drawCompute(uint256 tokenSeed, uint256 amount) external {
        (address token, bool ok) = _token(tokenSeed);
        if (!ok) return;
        uint256 balance = launchpad.mindBalance(token);
        (uint256 maxPerEpoch,) = launchpad.drawLimit();
        (uint256 drawn,) = launchpad.drawnInEpoch(token);
        uint256 room = maxPerEpoch > drawn ? maxPerEpoch - drawn : 0;
        uint256 cap = balance < room ? balance : room;
        if (cap == 0) return;
        amount = bound(amount, 1, cap);
        vm.prank(operator);
        launchpad.drawCompute(token, amount, keccak256(abi.encode(amount)));
        calls["drawCompute"]++;
    }

    function withdrawProtocolFees() external {
        if (launchpad.protocolBalance() == 0) return;
        vm.prank(owner);
        launchpad.withdrawProtocolFees(owner);
        calls["withdrawProtocolFees"]++;
    }

    function setFees(uint16 tradeFeeBps, uint16 mindShareBps, uint16 graduationFeeBps) external {
        IMindLaunchpad.FeeParams memory p = IMindLaunchpad.FeeParams(
            uint16(bound(tradeFeeBps, 0, 500)),
            uint16(bound(mindShareBps, 0, 10_000)),
            uint16(bound(graduationFeeBps, 0, 1000))
        );
        vm.prank(owner);
        launchpad.setFeeParams(p);
        calls["setFees"]++;
    }

    function warp(uint256 secondsAhead) external {
        vm.warp(block.timestamp + bound(secondsAhead, 1, 2 days));
        calls["warp"]++;
    }
}
