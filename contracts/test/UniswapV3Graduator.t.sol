// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Vm} from "forge-std/Vm.sol";

import {MindToken} from "../src/MindToken.sol";
import {UniswapV3Graduator} from "../src/UniswapV3Graduator.sol";
import {IMindLaunchpad} from "../src/interfaces/IMindLaunchpad.sol";
import {INonfungiblePositionManager} from "../src/interfaces/uniswap/INonfungiblePositionManager.sol";
import {IUniswapV3Pool} from "../src/interfaces/uniswap/IUniswapV3Pool.sol";
import {MockWETH9} from "./mocks/MockWETH9.sol";
import {UniV3Factory} from "./mocks/uniswapv3/UniV3Factory.sol";
import {UniV3Math as M} from "./mocks/uniswapv3/UniV3Math.sol";
import {UniV3Pool} from "./mocks/uniswapv3/UniV3Pool.sol";
import {UniV3PositionManager} from "./mocks/uniswapv3/UniV3PositionManager.sol";
import {BaseTest} from "./utils/BaseTest.sol";

/// @notice UniswapV3Graduator against the Uniswap v3 models with the real liquidity / swap math
///         (test/mocks/uniswapv3): both token orderings, fresh / pre-created / skewed pools, the price correction
///         (free moves, trades against third-party liquidity, PoolPriceSkewed), the swap callback, tolerance and mint
///         minimums, leftovers, harvest, access control.
contract UniswapV3GraduatorTest is BaseTest {
    uint24 internal constant FEE_TIER = 10_000;
    int24 internal constant SPACING = 200;
    address internal constant WETH_LOW = address(0x1000); // WETH is token0
    address internal constant WETH_HIGH = address(0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF); // coin is token0

    UniV3Factory internal factory;
    UniV3PositionManager internal npm;
    MockWETH9 internal weth;
    UniswapV3Graduator internal graduator;
    address internal attacker = makeAddr("attacker");

    struct Expectation {
        address token;
        uint256 reserve;
        uint256 gradFee;
        uint256 ethLiquidity;
        uint256 mindBefore;
        address token0;
        address token1;
        uint256 amount0;
        uint256 amount1;
        uint160 expectedSqrtPrice;
    }

    function setUp() public override {
        super.setUp();
        factory = new UniV3Factory();
        npm = new UniV3PositionManager(address(factory));
        factory.setManager(address(npm));
        vm.deal(attacker, 1000 ether);
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    /// @dev Deploys WETH at `wethAt` (low => WETH is token0, high => the coin is token0) and wires a graduator.
    function _wire(address wethAt) internal {
        deployCodeTo("MockWETH9.sol:MockWETH9", wethAt);
        weth = MockWETH9(payable(wethAt));
        graduator = new UniswapV3Graduator(owner, address(launchpad), address(npm), address(factory), wethAt, FEE_TIER);
        vm.prank(owner);
        launchpad.setGraduator(address(graduator));
    }

    function _completeAndExpect() internal returns (Expectation memory e) {
        return _completeAndExpect(0);
    }

    /// @dev Creates a coin; the attacker buys `attackerEth` worth of coins first (when non-zero); alice completes.
    function _completeAndExpect(uint256 attackerEth) internal returns (Expectation memory e) {
        e.token = _createMind();
        if (attackerEth > 0) _buy(attacker, e.token, attackerEth);
        _complete(alice, e.token);
        (e.reserve,) = _curve(e.token);
        e.gradFee = e.reserve * 250 / 10_000;
        e.ethLiquidity = e.reserve - e.gradFee;
        e.mindBefore = launchpad.mindBalance(e.token) + e.gradFee * 7000 / 10_000;
        bool tokenIs0 = e.token < address(weth);
        (e.token0, e.token1, e.amount0, e.amount1) = tokenIs0
            ? (e.token, address(weth), LP_SUPPLY, e.ethLiquidity)
            : (address(weth), e.token, e.ethLiquidity, LP_SUPPLY);
        e.expectedSqrtPrice = _sqrtPriceX96(e.amount0, e.amount1);
    }

    /// @dev Reference implementation of the graduator's price derivation (SPEC §2.4 step 2).
    function _sqrtPriceX96(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        return uint160(Math.sqrt(Math.mulDiv(amount1, 1 << 192, amount0)));
    }

    /// @dev Pool sqrt price at which sqrt(WETH per coin) is `coinSqrtBps / 10000` of the expected one
    ///      (5000 => the coin is 4x cheaper, 20000 => 4x more expensive), in the pool's token order.
    function _poolSqrt(Expectation memory e, uint256 coinSqrtBps) internal pure returns (uint160) {
        uint256 scaled = e.token == e.token0
            ? uint256(e.expectedSqrtPrice) * coinSqrtBps / 10_000
            : uint256(e.expectedSqrtPrice) * 10_000 / coinSqrtBps;
        return SafeCast.toUint160(scaled);
    }

    function _price(address pool) internal view returns (uint160 sqrtPriceX96) {
        (sqrtPriceX96,,,,,,) = IUniswapV3Pool(pool).slot0();
    }

    /// @dev Largest tick whose sqrt ratio is <= `sqrtP`, rounded down to a multiple of the tick spacing.
    function _tickBelow(uint160 sqrtP) internal pure returns (int24) {
        int256 lo = M.MIN_TICK;
        int256 hi = M.MAX_TICK;
        while (lo < hi) {
            int256 mid = lo + (hi - lo + 1) / 2;
            // forge-lint: disable-next-line(unsafe-typecast)
            if (M.getSqrtRatioAtTick(int24(mid)) <= sqrtP) lo = mid;
            else hi = mid - 1;
        }
        int256 aligned = lo >= 0 ? lo / SPACING * SPACING : -((-lo + SPACING - 1) / SPACING * SPACING);
        // forge-lint: disable-next-line(unsafe-typecast)
        return int24(aligned);
    }

    /// @dev Attacker creates the pool and initializes it at `coinSqrtBps` (see {_poolSqrt}).
    function _preSkew(Expectation memory e, uint256 coinSqrtBps) internal returns (address pool, uint160 actual) {
        actual = _poolSqrt(e, coinSqrtBps);
        vm.startPrank(attacker);
        pool = factory.createPool(e.token, address(weth), FEE_TIER);
        IUniswapV3Pool(pool).initialize(actual);
        vm.stopPrank();
    }

    /// @dev Attacker mints a position between the two coin sqrt-price factors with up to `coins` coins and
    ///      `wethAmount` WETH (the position manager takes what the range needs at the current price).
    function _attackerRange(Expectation memory e, uint256 fromBps, uint256 toBps, uint256 coins, uint256 wethAmount)
        internal
        returns (uint256 tokenId)
    {
        uint160 sa = _poolSqrt(e, fromBps);
        uint160 sb = _poolSqrt(e, toBps);
        (sa, sb) = sa < sb ? (sa, sb) : (sb, sa);
        (uint256 desired0, uint256 desired1) = e.token == e.token0 ? (coins, wethAmount) : (wethAmount, coins);
        vm.startPrank(attacker);
        weth.deposit{value: wethAmount}();
        weth.approve(address(npm), wethAmount);
        MindToken(e.token).approve(address(npm), coins);
        (tokenId,,,) = npm.mint(
            INonfungiblePositionManager.MintParams({
                token0: e.token0,
                token1: e.token1,
                fee: FEE_TIER,
                tickLower: _tickBelow(sa),
                tickUpper: _tickBelow(sb),
                amount0Desired: desired0,
                amount1Desired: desired1,
                amount0Min: 0,
                amount1Min: 0,
                recipient: attacker,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();
    }

    /// @dev Attacker's ETH + WETH + coins valued at the fair (expected) price, in wei.
    function _attackerValue(Expectation memory e) internal view returns (uint256) {
        uint256 coins = MindToken(e.token).balanceOf(attacker);
        return attacker.balance + weth.balanceOf(attacker) + coins * e.ethLiquidity / LP_SUPPLY;
    }

    /// @dev Attacker withdraws its position and collects its swap fees.
    function _attackerExit(uint256 tokenId) internal {
        vm.startPrank(attacker);
        npm.burnAll(tokenId, attacker);
        npm.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId, recipient: attacker, amount0Max: type(uint128).max, amount1Max: type(uint128).max
            })
        );
        vm.stopPrank();
    }

    function _countSkewEvents(Vm.Log[] memory logs) internal view returns (uint256 n) {
        bytes32 topic = UniswapV3Graduator.GraduatedAtSkewedPrice.selector;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(graduator) && logs[i].topics[0] == topic) ++n;
        }
    }

    function _assertGraduatorEmpty(address token) internal view {
        assertEq(MindToken(token).balanceOf(address(graduator)), 0, "graduator keeps no tokens");
        assertEq(weth.balanceOf(address(graduator)), 0, "graduator keeps no WETH");
        assertEq(address(graduator).balance, 0, "graduator keeps no ETH");
        assertEq(MindToken(token).allowance(address(graduator), address(npm)), 0);
        assertEq(weth.allowance(address(graduator), address(npm)), 0);
    }

    /// @dev All curves here are graduated (zero reserve), so the launchpad holds exactly vaults + protocol fees.
    function _assertSolvent(address) internal view {
        uint256 total = launchpad.protocolBalance();
        for (uint256 i; i < launchpad.mindsLength(); ++i) {
            total += launchpad.mindBalance(launchpad.mindAt(i));
        }
        assertEq(address(launchpad).balance, total);
    }

    /// @dev The graduator's position holds (almost) all of the graduation liquidity: only full-range rounding dust
    ///      (relative ~4e-16) is returned / burned.
    function _assertFullLiquidity(Expectation memory e, uint256 burnBefore) internal view {
        UniV3Pool.Range memory r = UniV3Pool(graduator.poolOf(e.token)).rangeAt(0);
        assertGt(r.liquidity, 0);
        uint256 ethReturned = launchpad.mindBalance(e.token) - e.mindBefore;
        uint256 burned = MindToken(e.token).balanceOf(BURN) - burnBefore;
        assertLe(ethReturned, 1e6, "only dust ETH returned");
        assertLe(burned, 1e12, "only dust coins burned");
    }

    // ---------------------------------------------------------------------------------------------
    // Fresh pool, both orderings
    // ---------------------------------------------------------------------------------------------

    function test_graduate_freshPool_wethIsToken0() public {
        _wire(WETH_LOW);
        _freshPool();
    }

    function test_graduate_freshPool_tokenIsToken0() public {
        _wire(WETH_HIGH);
        _freshPool();
    }

    function _freshPool() internal {
        Expectation memory e = _completeAndExpect();
        assertEq(factory.getPool(e.token0, e.token1, FEE_TIER), address(0));

        vm.recordLogs();
        launchpad.graduate(e.token);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countSkewEvents(logs), 0, "no skew event for a fresh pool");

        address pool = factory.getPool(e.token0, e.token1, FEE_TIER);
        assertTrue(pool != address(0));
        assertEq(_price(pool), e.expectedSqrtPrice, "pool initialized at the amounts' price");
        assertEq(IUniswapV3Pool(pool).token0(), e.token0);

        IMindLaunchpad.CurveState memory c = launchpad.getCurve(e.token);
        assertEq(c.pool, pool);
        assertEq(c.positionId, 1);
        assertEq(graduator.positionOf(e.token), 1);
        assertEq(graduator.poolOf(e.token), pool);
        assertEq(npm.ownerOf(1), address(graduator), "LP NFT stays with the graduator");
        (,,,,, int24 tickLower, int24 tickUpper, uint128 liquidity,,,,) = npm.positions(1);
        assertEq(tickLower, -887_200);
        assertEq(tickUpper, 887_200);
        assertGt(liquidity, 0);
        assertEq(IUniswapV3Pool(pool).liquidity(), liquidity);

        // Only rounding dust is left over: returned ETH credited, unused tokens burned.
        uint256 poolWeth = weth.balanceOf(pool);
        uint256 poolTokens = MindToken(e.token).balanceOf(pool);
        uint256 ethReturned = e.ethLiquidity - poolWeth;
        assertLe(ethReturned, 1e6, "full-range rounding dust only");
        assertLe(LP_SUPPLY - poolTokens, 1e12);
        assertEq(MindToken(e.token).balanceOf(BURN), LP_SUPPLY - poolTokens);
        assertEq(launchpad.mindBalance(e.token), e.mindBefore + ethReturned);
        _assertGraduatorEmpty(e.token);
        _assertSolvent(e.token);
    }

    // ---------------------------------------------------------------------------------------------
    // Pre-skewed pools without liquidity: the correction moves the price for free
    // ---------------------------------------------------------------------------------------------

    function test_graduate_skewedPool_wethIsToken0_priceHigh() public {
        _wire(WETH_LOW);
        _skewed(true, false);
    }

    function test_graduate_skewedPool_wethIsToken0_priceLow() public {
        _wire(WETH_LOW);
        _skewed(false, false);
    }

    function test_graduate_skewedPool_tokenIsToken0_priceHigh() public {
        _wire(WETH_HIGH);
        _skewed(true, false);
    }

    function test_graduate_skewedPool_tokenIsToken0_priceLow() public {
        _wire(WETH_HIGH);
        _skewed(false, false);
    }

    function test_graduate_extremelySkewedPool_neverReverts() public {
        _wire(WETH_LOW);
        _skewed(true, true);
        _skewed(false, true);
        _wire(WETH_HIGH);
        _skewed(true, true);
        _skewed(false, true);
    }

    /// @dev Pre-creates and initializes the pool at 4x / 0.25x the expected price (or at the sqrt-ratio edges when
    ///      `extreme`), then graduates: the correction swap moves the price to exactly `expected` at no cost, the
    ///      skew event reports the pre-correction price and the position gets the whole liquidity.
    function _skewed(bool priceHigh, bool extreme) internal {
        Expectation memory e = _completeAndExpect();
        uint160 actual;
        if (extreme) actual = priceHigh ? M.MAX_SQRT_RATIO - 1 : M.MIN_SQRT_RATIO;
        else actual = priceHigh ? e.expectedSqrtPrice * 2 : e.expectedSqrtPrice / 2;
        address pool = factory.createPool(e.token, address(weth), FEE_TIER);
        IUniswapV3Pool(pool).initialize(actual);

        uint256 burnBefore = MindToken(e.token).balanceOf(BURN);
        vm.expectEmit(true, false, false, true, address(graduator));
        emit UniswapV3Graduator.GraduatedAtSkewedPrice(e.token, e.expectedSqrtPrice, actual);
        launchpad.graduate(e.token);

        assertEq(_price(pool), e.expectedSqrtPrice, "price corrected to the expected one");
        assertEq(launchpad.getCurve(e.token).pool, pool);
        assertEq(uint8(launchpad.getCurve(e.token).phase), uint8(IMindLaunchpad.CurvePhase.Graduated));
        assertGe(weth.balanceOf(pool), e.ethLiquidity - 1e6, "the pool got the ETH liquidity");
        assertGe(MindToken(e.token).balanceOf(pool), LP_SUPPLY - 1e12, "the pool got LP_SUPPLY");
        _assertFullLiquidity(e, burnBefore);
        _assertGraduatorEmpty(e.token);
        _assertSolvent(e.token);
    }

    /// @dev Any pre-set price, either ordering, no liquidity: graduation succeeds at exactly the expected price.
    function testFuzz_graduate_anyPreSetPrice(uint160 preSet, bool wethLow) public {
        _wire(wethLow ? WETH_LOW : WETH_HIGH);
        Expectation memory e = _completeAndExpect();
        preSet = uint160(bound(preSet, M.MIN_SQRT_RATIO, M.MAX_SQRT_RATIO - 1));
        address pool = factory.createPool(e.token, address(weth), FEE_TIER);
        IUniswapV3Pool(pool).initialize(preSet);
        uint256 burnBefore = MindToken(e.token).balanceOf(BURN);
        launchpad.graduate(e.token);
        assertEq(_price(pool), e.expectedSqrtPrice);
        _assertFullLiquidity(e, burnBefore);
        _assertGraduatorEmpty(e.token);
        _assertSolvent(e.token);
    }

    function test_graduate_preCreatedUninitializedPool() public {
        _wire(WETH_LOW);
        Expectation memory e = _completeAndExpect();
        address pool = factory.createPool(e.token, address(weth), FEE_TIER);
        vm.recordLogs();
        launchpad.graduate(e.token);
        assertEq(_countSkewEvents(vm.getRecordedLogs()), 0);
        assertEq(_price(pool), e.expectedSqrtPrice);
        assertEq(launchpad.getCurve(e.token).pool, pool);
    }

    function test_graduate_preCreatedPoolAtExactPrice() public {
        _wire(WETH_HIGH);
        Expectation memory e = _completeAndExpect();
        address pool = factory.createPool(e.token, address(weth), FEE_TIER);
        IUniswapV3Pool(pool).initialize(e.expectedSqrtPrice);
        vm.recordLogs();
        launchpad.graduate(e.token);
        assertEq(_countSkewEvents(vm.getRecordedLogs()), 0);
    }

    // ---------------------------------------------------------------------------------------------
    // Correction against third-party liquidity
    // ---------------------------------------------------------------------------------------------

    function test_correction_coinTooCheap_buysAttackerCoins_wethIsToken0() public {
        _wire(WETH_LOW);
        _coinTooCheap();
    }

    function test_correction_coinTooCheap_buysAttackerCoins_tokenIsToken0() public {
        _wire(WETH_HIGH);
        _coinTooCheap();
    }

    /// @dev Pool at a 4x cheaper coin with 100M attacker coins concentrated on the way back up (less than half the
    ///      ETH liquidity can buy them): the graduator buys them below the fair price, the price ends at exactly
    ///      `expected`, surplus coins are burned and the attacker ends up poorer than it started (fees included).
    function _coinTooCheap() internal {
        Expectation memory e = _completeAndExpect(0.5 ether);
        uint256 valueBefore = _attackerValue(e);
        (address pool, uint160 actual) = _preSkew(e, 5000);
        uint256 positionId = _attackerRange(e, 5000, 9500, 100_000_000e18, 1 ether);
        uint256 burnBefore = MindToken(e.token).balanceOf(BURN);

        vm.expectEmit(true, false, false, true, address(graduator));
        emit UniswapV3Graduator.GraduatedAtSkewedPrice(e.token, e.expectedSqrtPrice, actual);
        launchpad.graduate(e.token);

        assertEq(_price(pool), e.expectedSqrtPrice, "attacker range exhausted, then a free move to expected");
        uint256 burned = MindToken(e.token).balanceOf(BURN) - burnBefore;
        assertGt(burned, 50_000_000e18, "coins bought from the attacker in excess of the pool ratio are burned");
        assertLe(launchpad.mindBalance(e.token) - e.mindBefore, 1e6, "no ETH diverted to the vault");
        _assertGraduatorEmpty(e.token);
        _assertSolvent(e.token);

        _attackerExit(positionId);
        uint256 valueAfter = _attackerValue(e);
        emit log_named_decimal_uint("attacker loss at the fair price (ETH)", valueBefore - valueAfter, 18);
        assertLt(valueAfter, valueBefore, "attacker cannot profit beyond fair value");
    }

    function test_correction_coinTooExpensive_sellsCoinsToAttacker_wethIsToken0() public {
        _wire(WETH_LOW);
        _coinTooExpensive();
    }

    function test_correction_coinTooExpensive_sellsCoinsToAttacker_tokenIsToken0() public {
        _wire(WETH_HIGH);
        _coinTooExpensive();
    }

    /// @dev Pool at a 4x more expensive coin with 1 WETH of attacker liquidity on the way back down: the graduator
    ///      sells coins to it above the fair price; the WETH it receives cannot all fit the position at `expected`,
    ///      so the surplus is returned to the launchpad (MindFunded from the graduator) and the attacker loses.
    function _coinTooExpensive() internal {
        Expectation memory e = _completeAndExpect(0.5 ether);
        uint256 valueBefore = _attackerValue(e);
        (address pool,) = _preSkew(e, 20_000);
        uint256 positionId = _attackerRange(e, 10_500, 20_000, 50_000_000e18, 1 ether);

        vm.recordLogs();
        launchpad.graduate(e.token);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(_price(pool), e.expectedSqrtPrice);
        assertEq(_countSkewEvents(logs), 1);
        uint256 ethReturned = launchpad.mindBalance(e.token) - e.mindBefore;
        assertGt(ethReturned, 0.5 ether, "WETH received from the attacker is returned");
        uint256 found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(launchpad) && logs[i].topics[0] == IMindLaunchpad.MindFunded.selector) {
                assertEq(logs[i].topics[1], bytes32(uint256(uint160(e.token))));
                assertEq(logs[i].topics[2], bytes32(uint256(uint160(address(graduator)))));
                assertEq(abi.decode(logs[i].data, (uint256)), ethReturned);
                ++found;
            }
        }
        assertEq(found, 1, "one MindFunded for the leftover ETH");
        _assertGraduatorEmpty(e.token);
        _assertSolvent(e.token);

        _attackerExit(positionId);
        assertLt(_attackerValue(e), valueBefore, "attacker cannot profit beyond fair value");
    }

    function test_correction_attackerDeeperThanCap_revertsPoolPriceSkewed_wethIsToken0() public {
        _wire(WETH_LOW);
        _tooDeep();
    }

    function test_correction_attackerDeeperThanCap_revertsPoolPriceSkewed_tokenIsToken0() public {
        _wire(WETH_HIGH);
        _tooDeep();
    }

    /// @dev 400M attacker coins on the way back up absorb more than half of the ETH liquidity: the correction stops
    ///      short of the tolerance, graduation reverts PoolPriceSkewed and nothing changes. Once anyone arbitrages
    ///      the pool (buying the cheap coins), graduation can be retried and succeeds.
    function _tooDeep() internal {
        Expectation memory e = _completeAndExpect(1 ether);
        (address pool, uint160 actual) = _preSkew(e, 5000);
        _attackerRange(e, 5000, 9500, 400_000_000e18, 1 ether);
        (uint256 reserve, uint256 sold) = _curve(e.token);

        _expectPoolPriceSkewed(e, actual);

        // Nothing changed.
        assertEq(_price(pool), actual);
        assertEq(uint8(launchpad.getCurve(e.token).phase), uint8(IMindLaunchpad.CurvePhase.Complete));
        (uint256 reserveAfter, uint256 soldAfter) = _curve(e.token);
        assertEq(reserveAfter, reserve);
        assertEq(soldAfter, sold);
        assertEq(graduator.positionOf(e.token), 0);

        // Bob arbitrages: buys the attacker's cheap coins with WETH up to the expected price.
        _arbitrageToExpected(e, pool);
        assertEq(_price(pool), e.expectedSqrtPrice);

        launchpad.graduate(e.token);
        assertEq(uint8(launchpad.getCurve(e.token).phase), uint8(IMindLaunchpad.CurvePhase.Graduated));
        _assertGraduatorEmpty(e.token);
    }

    /// @dev Graduation reverts with PoolPriceSkewed(expected, price after the partial correction).
    function _expectPoolPriceSkewed(Expectation memory e, uint160 preCorrection) internal {
        (bool ok, bytes memory err) = address(launchpad).call(abi.encodeCall(IMindLaunchpad.graduate, (e.token)));
        assertFalse(ok, "graduation must not mint at a skewed price");
        assertEq(_selector(err), UniswapV3Graduator.PoolPriceSkewed.selector);
        assertEq(_selector(err), IMindLaunchpad.PoolPriceSkewed.selector, "decodable with the launchpad ABI");
        bytes memory args = new bytes(err.length - 4);
        for (uint256 i; i < args.length; ++i) {
            args[i] = err[i + 4];
        }
        (uint160 expected, uint160 reached) = abi.decode(args, (uint160, uint160));
        assertEq(expected, e.expectedSqrtPrice);
        uint256 distance = reached > expected ? reached - expected : expected - reached;
        assertGt(distance * 10_000, uint256(expected) * 100, "outside the 1% tolerance");
        assertTrue(reached != preCorrection, "the correction did move the price before giving up");
    }

    function _selector(bytes memory err) internal pure returns (bytes4 sel) {
        assembly ("memory-safe") {
            sel := mload(add(err, 0x20))
        }
    }

    /// @dev Bob buys coins with WETH until the pool reaches the expected price.
    function _arbitrageToExpected(Expectation memory e, address pool) internal {
        vm.startPrank(bob);
        weth.deposit{value: 20 ether}();
        weth.approve(pool, 20 ether);
        UniV3Pool(pool).swapExactInTo(e.token != e.token0, 20 ether, e.expectedSqrtPrice, bob);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------------------------------
    // Swap callback, tolerance, minimums
    // ---------------------------------------------------------------------------------------------

    function test_swapCallback_rejectsAnyCallerOutsideTheCorrection() public {
        _wire(WETH_LOW);
        Expectation memory e = _completeAndExpect();
        launchpad.graduate(e.token);
        address pool = graduator.poolOf(e.token);
        bytes memory data = abi.encode(e.token0, e.token1);

        vm.prank(stranger);
        vm.expectRevert(UniswapV3Graduator.UnauthorizedCallback.selector);
        graduator.uniswapV3SwapCallback(1, 0, data);

        // Even the real pool cannot pull funds outside a graduation's correction swap.
        vm.prank(pool);
        vm.expectRevert(UniswapV3Graduator.UnauthorizedCallback.selector);
        graduator.uniswapV3SwapCallback(0, 1, data);

        vm.prank(address(launchpad));
        vm.expectRevert(UniswapV3Graduator.UnauthorizedCallback.selector);
        graduator.uniswapV3SwapCallback(0, 0, data);
    }

    /// @dev While the correction swap of the recorded pool is running, a callback from any other address (here a
    ///      relay the pool calls into) is rejected and the whole graduation reverts.
    function test_swapCallback_otherCallerDuringCorrectionReverts() public {
        _wire(WETH_HIGH);
        Expectation memory e = _completeAndExpect();
        (address pool, uint160 actual) = _preSkew(e, 5000);
        vm.etch(pool, address(new RelayingPool(actual, new CallbackRelay())).code);
        vm.expectRevert(UniswapV3Graduator.UnauthorizedCallback.selector);
        launchpad.graduate(e.token);
        assertEq(uint8(launchpad.getCurve(e.token).phase), uint8(IMindLaunchpad.CurvePhase.Complete));
    }

    function test_setPriceToleranceBps() public {
        _wire(WETH_LOW);
        assertEq(graduator.priceToleranceBps(), 100);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        graduator.setPriceToleranceBps(50);

        vm.startPrank(owner);
        vm.expectRevert(UniswapV3Graduator.InvalidPriceTolerance.selector);
        graduator.setPriceToleranceBps(1001);
        vm.expectEmit(false, false, false, true, address(graduator));
        emit UniswapV3Graduator.PriceToleranceUpdated(1000);
        graduator.setPriceToleranceBps(1000);
        graduator.setPriceToleranceBps(0);
        vm.stopPrank();
        assertEq(graduator.priceToleranceBps(), 0);

        // Zero tolerance: free corrections still land exactly on the expected price.
        Expectation memory e = _completeAndExpect();
        _preSkew(e, 30_000);
        launchpad.graduate(e.token);
        assertEq(_price(graduator.poolOf(e.token)), e.expectedSqrtPrice);
    }

    function test_widerTolerance_acceptsPartialCorrection() public {
        _wire(WETH_HIGH);
        vm.prank(owner);
        graduator.setPriceToleranceBps(1000);
        Expectation memory e = _completeAndExpect(1 ether);
        (address pool,) = _preSkew(e, 9300);
        // Deep attacker coins between 0.93 and 0.95 of the expected coin sqrt price: the correction stops inside.
        _attackerRange(e, 9300, 9500, 400_000_000e18, 1 ether);
        launchpad.graduate(e.token);
        uint160 p = _price(pool);
        assertTrue(p != e.expectedSqrtPrice, "minted at a price inside the tolerance, not exactly expected");
        uint256 distance = p > e.expectedSqrtPrice ? p - e.expectedSqrtPrice : e.expectedSqrtPrice - p;
        assertLe(distance * 10_000, uint256(e.expectedSqrtPrice) * 1000);
        _assertGraduatorEmpty(e.token);
        _assertSolvent(e.token);
    }

    function test_mint_minimumsFollowTheTolerance() public {
        _wire(WETH_HIGH);
        vm.prank(owner);
        graduator.setPriceToleranceBps(250);
        Expectation memory e = _completeAndExpect();
        // Fresh pool at `expected`: token1 is the binding side of the floor-rounded price.
        uint256 desired0 = e.amount0;
        uint256 desired1 = Math.mulDiv(Math.mulDiv(e.amount0, e.expectedSqrtPrice, 1 << 96), e.expectedSqrtPrice, 1 << 96);
        assertLe(desired1, e.amount1);
        INonfungiblePositionManager.MintParams memory params = INonfungiblePositionManager.MintParams({
            token0: e.token0,
            token1: e.token1,
            fee: FEE_TIER,
            tickLower: -887_200,
            tickUpper: 887_200,
            amount0Desired: desired0,
            amount1Desired: desired1,
            amount0Min: desired0 * (10_000 - 2 * 250 - 100) / 10_000,
            amount1Min: desired1 * (10_000 - 2 * 250 - 100) / 10_000,
            recipient: address(graduator),
            deadline: block.timestamp
        });
        vm.expectCall(address(npm), abi.encodeCall(npm.mint, (params)));
        launchpad.graduate(e.token);
    }

    // ---------------------------------------------------------------------------------------------
    // Harvest
    // ---------------------------------------------------------------------------------------------

    function test_harvest_wethIsToken0() public {
        _wire(WETH_LOW);
        _harvest();
    }

    function test_harvest_tokenIsToken0() public {
        _wire(WETH_HIGH);
        _harvest();
    }

    function _harvest() internal {
        Expectation memory e = _completeAndExpect();
        launchpad.graduate(e.token);
        uint256 positionId = graduator.positionOf(e.token);

        // Seed fees: 0.2 ETH (as WETH) and 1M coins.
        uint128 ethFee = 0.2 ether;
        uint128 tokenFee = 1_000_000e18;
        vm.deal(address(this), ethFee);
        weth.deposit{value: ethFee}();
        vm.prank(alice);
        assertTrue(MindToken(e.token).transfer(address(this), tokenFee));
        weth.approve(address(npm), ethFee);
        MindToken(e.token).approve(address(npm), tokenFee);
        (uint128 fee0, uint128 fee1) = e.token == e.token0 ? (tokenFee, ethFee) : (ethFee, tokenFee);
        npm.accrueFees(positionId, fee0, fee1);

        uint256 mindBefore = launchpad.mindBalance(e.token);
        uint256 burnBefore = MindToken(e.token).balanceOf(BURN);
        vm.expectEmit(true, true, false, true, address(launchpad));
        emit IMindLaunchpad.MindFunded(e.token, address(graduator), ethFee);
        vm.expectEmit(true, false, false, true, address(launchpad));
        emit IMindLaunchpad.Harvested(e.token, ethFee, tokenFee);
        vm.prank(stranger);
        launchpad.harvest(e.token);

        assertEq(launchpad.mindBalance(e.token), mindBefore + ethFee, "ETH fees credited to the mind");
        assertEq(MindToken(e.token).balanceOf(BURN) - burnBefore, tokenFee, "coin fees burned");
        _assertGraduatorEmpty(e.token);
        _assertSolvent(e.token);

        // Nothing left to collect.
        vm.expectEmit(true, false, false, true, address(launchpad));
        emit IMindLaunchpad.Harvested(e.token, 0, 0);
        launchpad.harvest(e.token);
    }

    /// @dev Real swap fees: traders swap both ways through the graduated pool; harvest credits the WETH fees to the
    ///      vault and burns the coin fees.
    function test_harvest_realSwapFees() public {
        _wire(WETH_LOW);
        Expectation memory e = _completeAndExpect();
        uint256 coins = MindToken(e.token).balanceOf(alice) / 10;
        launchpad.graduate(e.token);
        address pool = graduator.poolOf(e.token);
        bool coinIs0 = e.token == e.token0;

        vm.startPrank(alice);
        MindToken(e.token).approve(pool, coins);
        uint256 wethOut = UniV3Pool(pool).swapExactIn(coinIs0, coins, alice);
        weth.approve(pool, wethOut);
        UniV3Pool(pool).swapExactIn(!coinIs0, wethOut, alice);
        vm.stopPrank();

        UniV3Pool.Range memory r = UniV3Pool(pool).rangeAt(0);
        (uint256 coinFees, uint256 wethFees) = coinIs0 ? (r.fees0, r.fees1) : (r.fees1, r.fees0);
        assertApproxEqRel(coinFees, coins / 100, 1e15, "1% of the coin input");
        assertApproxEqRel(wethFees, wethOut / 100, 1e15, "1% of the WETH input");

        uint256 mindBefore = launchpad.mindBalance(e.token);
        uint256 burnBefore = MindToken(e.token).balanceOf(BURN);
        vm.expectEmit(true, false, false, true, address(launchpad));
        emit IMindLaunchpad.Harvested(e.token, wethFees, coinFees);
        launchpad.harvest(e.token);
        assertEq(launchpad.mindBalance(e.token), mindBefore + wethFees);
        assertEq(MindToken(e.token).balanceOf(BURN) - burnBefore, coinFees);
        _assertGraduatorEmpty(e.token);
        _assertSolvent(e.token);
    }

    // ---------------------------------------------------------------------------------------------
    // Access control, config, helpers
    // ---------------------------------------------------------------------------------------------

    function test_onlyLaunchpad() public {
        _wire(WETH_LOW);
        vm.deal(stranger, 1 ether);
        vm.startPrank(stranger);
        vm.expectRevert(UniswapV3Graduator.NotLaunchpad.selector);
        graduator.graduate{value: 1 ether}(address(0xBEEF), 1);
        vm.expectRevert(UniswapV3Graduator.NotLaunchpad.selector);
        graduator.harvest(address(0xBEEF));
        vm.stopPrank();

        vm.prank(address(launchpad));
        vm.expectRevert(UniswapV3Graduator.NoPosition.selector);
        graduator.harvest(address(0xBEEF));
    }

    function test_cannotGraduateTwice() public {
        _wire(WETH_LOW);
        Expectation memory e = _completeAndExpect();
        launchpad.graduate(e.token);
        vm.deal(address(launchpad), address(launchpad).balance + 1 ether);
        vm.prank(address(launchpad));
        vm.expectRevert(UniswapV3Graduator.AlreadyGraduated.selector);
        graduator.graduate{value: 1 ether}(e.token, 1);
    }

    function test_receiveOnlyFromWeth() public {
        _wire(WETH_LOW);
        vm.prank(alice);
        (bool ok, bytes memory err) = address(graduator).call{value: 1}("");
        assertFalse(ok);
        assertEq(err, abi.encodeWithSelector(UniswapV3Graduator.UnexpectedEthSender.selector));
    }

    function test_ownerHasNoPowerOverPositions() public {
        _wire(WETH_LOW);
        Expectation memory e = _completeAndExpect();
        launchpad.graduate(e.token);
        assertEq(graduator.owner(), owner);
        // Ownership is two-step and grants nothing over the LP NFT (there is no transfer/rescue function).
        vm.prank(owner);
        graduator.transferOwnership(alice);
        vm.prank(alice);
        graduator.acceptOwnership();
        assertEq(graduator.owner(), alice);
        assertEq(npm.ownerOf(graduator.positionOf(e.token)), address(graduator));
    }

    function test_constructor() public {
        deployCodeTo("MockWETH9.sol:MockWETH9", WETH_LOW);
        address lp = address(launchpad);
        vm.expectRevert(UniswapV3Graduator.ZeroAddress.selector);
        new UniswapV3Graduator(owner, address(0), address(npm), address(factory), WETH_LOW, FEE_TIER);
        vm.expectRevert(UniswapV3Graduator.ZeroAddress.selector);
        new UniswapV3Graduator(owner, lp, address(0), address(factory), WETH_LOW, FEE_TIER);
        vm.expectRevert(UniswapV3Graduator.ZeroAddress.selector);
        new UniswapV3Graduator(owner, lp, address(npm), address(0), WETH_LOW, FEE_TIER);
        vm.expectRevert(UniswapV3Graduator.ZeroAddress.selector);
        new UniswapV3Graduator(owner, lp, address(npm), address(factory), address(0), FEE_TIER);
        vm.expectRevert(UniswapV3Graduator.UnsupportedFeeTier.selector);
        new UniswapV3Graduator(owner, lp, address(npm), address(factory), WETH_LOW, 1234);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new UniswapV3Graduator(address(0), lp, address(npm), address(factory), WETH_LOW, FEE_TIER);

        vm.expectEmit(false, false, false, true);
        emit UniswapV3Graduator.PriceToleranceUpdated(100);
        UniswapV3Graduator g = new UniswapV3Graduator(owner, lp, address(npm), address(factory), WETH_LOW, 3000);
        assertEq(g.owner(), owner);
        assertEq(g.launchpad(), lp);
        assertEq(address(g.positionManager()), address(npm));
        assertEq(address(g.factory()), address(factory));
        assertEq(address(g.weth9()), WETH_LOW);
        assertEq(g.feeTier(), 3000);
        assertEq(g.priceToleranceBps(), 100);
        assertEq(g.tickLower(), -887_220);
        assertEq(g.tickUpper(), 887_220);
        g = new UniswapV3Graduator(owner, lp, address(npm), address(factory), WETH_LOW, 500);
        assertEq(g.tickLower(), -887_270);
        assertEq(g.tickUpper(), 887_270);
        g = new UniswapV3Graduator(owner, lp, address(npm), address(factory), WETH_LOW, 10_000);
        assertEq(g.tickLower(), -887_200);
        assertEq(g.tickUpper(), 887_200);
    }

    function test_expectedPriceMatchesTheCurve() public {
        _wire(WETH_HIGH); // coin is token0: price = WETH per coin
        Expectation memory e = _completeAndExpect();
        launchpad.graduate(e.token);
        uint160 sqrtPrice = _price(graduator.poolOf(e.token));
        // (sqrtPrice / 2^96)^2 * 1e18 = wei per 1e18 coins ~ ethLiquidity * 1e18 / LP_SUPPLY (~1.95e-8 ETH per coin).
        uint256 priceWad = Math.mulDiv(Math.mulDiv(uint256(sqrtPrice), uint256(sqrtPrice), 1 << 96), 1e18, 1 << 96);
        assertApproxEqRel(priceWad, e.ethLiquidity * 1e18 / LP_SUPPLY, 1e9);
        assertApproxEqRel(priceWad, 19_500_000_000, 0.01e18);
    }
}

/// @dev Calls the graduator's swap callback from its own address (not the pool's).
contract CallbackRelay {
    function poke(UniswapV3Graduator g, bytes calldata data) external {
        g.uniswapV3SwapCallback(1, 1, data);
    }
}

/// @dev Pool stand-in (etched over a real pool's address) that, when the graduator swaps, makes a relay call the
///      graduator's callback instead of calling it itself.
contract RelayingPool {
    uint160 internal immutable _price;
    CallbackRelay internal immutable _relay;

    constructor(uint160 price_, CallbackRelay relay_) {
        _price = price_;
        _relay = relay_;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (_price, 0, 0, 1, 1, 0, true);
    }

    function swap(address, bool, int256, uint160, bytes calldata data) external returns (int256, int256) {
        _relay.poke(UniswapV3Graduator(payable(msg.sender)), data);
        return (0, 0);
    }
}
