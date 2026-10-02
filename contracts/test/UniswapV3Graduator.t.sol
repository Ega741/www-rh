// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Vm} from "forge-std/Vm.sol";

import {MindToken} from "../src/MindToken.sol";
import {UniswapV3Graduator} from "../src/UniswapV3Graduator.sol";
import {IMindLaunchpad} from "../src/interfaces/IMindLaunchpad.sol";
import {IUniswapV3Pool} from "../src/interfaces/uniswap/IUniswapV3Pool.sol";
import {MockNonfungiblePositionManager} from "./mocks/MockNonfungiblePositionManager.sol";
import {MockUniswapV3Factory} from "./mocks/MockUniswapV3Factory.sol";
import {MockWETH9} from "./mocks/MockWETH9.sol";
import {BaseTest} from "./utils/BaseTest.sol";

/// @notice UniswapV3Graduator against Uniswap v3 mocks: both token orderings, fresh / pre-created / skewed pools,
///         leftovers, harvest, access control.
contract UniswapV3GraduatorTest is BaseTest {
    uint24 internal constant FEE_TIER = 10_000;
    uint160 internal constant MIN_SQRT_RATIO = 4_295_128_739;
    uint160 internal constant MAX_SQRT_RATIO = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342;
    address internal constant WETH_LOW = address(0x1000);
    address internal constant WETH_HIGH = address(0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF);

    MockUniswapV3Factory internal factory;
    MockNonfungiblePositionManager internal npm;
    MockWETH9 internal weth;
    UniswapV3Graduator internal graduator;

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
        factory = new MockUniswapV3Factory();
        npm = new MockNonfungiblePositionManager(address(factory));
        factory.setManager(address(npm));
    }

    /// @dev Deploys WETH at `wethAt` (low => WETH is token0, high => the coin is token0) and wires a graduator.
    function _wire(address wethAt) internal {
        deployCodeTo("MockWETH9.sol:MockWETH9", wethAt);
        weth = MockWETH9(payable(wethAt));
        graduator = new UniswapV3Graduator(owner, address(launchpad), address(npm), address(factory), wethAt, FEE_TIER);
        vm.prank(owner);
        launchpad.setGraduator(address(graduator));
    }

    function _completeAndExpect() internal returns (Expectation memory e) {
        e.token = _createMind();
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
        (uint160 sqrtPrice,,,,,,) = IUniswapV3Pool(pool).slot0();
        assertEq(sqrtPrice, e.expectedSqrtPrice, "pool initialized at the amounts' price");
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

        // Only rounding dust is left over: returned ETH credited, unused tokens burned.
        uint256 poolWeth = weth.balanceOf(pool);
        uint256 poolTokens = MindToken(e.token).balanceOf(pool);
        uint256 ethReturned = e.ethLiquidity - poolWeth;
        assertLe(ethReturned, 10);
        assertLe(LP_SUPPLY - poolTokens, 1e12);
        assertEq(MindToken(e.token).balanceOf(BURN), LP_SUPPLY - poolTokens);
        assertEq(launchpad.mindBalance(e.token), e.mindBefore + ethReturned);
        _assertGraduatorEmpty(e.token);
        _assertSolvent(e.token);
    }

    // ---------------------------------------------------------------------------------------------
    // Pre-created pools
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

    /// @dev Pre-creates and initializes the pool at 4x / 0.25x the expected price (or at the uint160 edges when
    ///      `extreme`), then graduates: no revert, skew event, ETH leftovers credited, token leftovers burned.
    function _skewed(bool priceHigh, bool extreme) internal {
        Expectation memory e = _completeAndExpect();
        uint160 actual;
        if (extreme) actual = priceHigh ? MAX_SQRT_RATIO - 1 : MIN_SQRT_RATIO + 1;
        else actual = priceHigh ? e.expectedSqrtPrice * 2 : e.expectedSqrtPrice / 2;
        address pool = factory.createPool(e.token, address(weth), FEE_TIER);
        IUniswapV3Pool(pool).initialize(actual);

        uint256 burnBefore = MindToken(e.token).balanceOf(BURN);
        vm.expectEmit(true, false, false, true, address(graduator));
        emit UniswapV3Graduator.GraduatedAtSkewedPrice(e.token, e.expectedSqrtPrice, actual);
        launchpad.graduate(e.token);

        (uint160 sqrtPrice,,,,,,) = IUniswapV3Pool(pool).slot0();
        assertEq(sqrtPrice, actual, "pool price untouched");
        assertEq(launchpad.getCurve(e.token).pool, pool);

        uint256 wethUsed = weth.balanceOf(pool);
        uint256 tokensUsed = MindToken(e.token).balanceOf(pool);
        uint256 ethReturned = e.ethLiquidity - wethUsed;
        uint256 tokensBurned = LP_SUPPLY - tokensUsed;
        assertEq(MindToken(e.token).balanceOf(BURN) - burnBefore, tokensBurned, "unused tokens burned");
        assertEq(launchpad.mindBalance(e.token), e.mindBefore + ethReturned, "unused ETH credited to the mind");
        // Exactly one side is (materially) left over.
        assertTrue(ethReturned > 1e9 || tokensBurned > 1e18, "a skewed pool leaves leftovers");
        // In WETH-per-token terms: a pricier coin leaves coins over, a cheaper coin leaves ETH over.
        bool coinPricier = (e.token == e.token0) == priceHigh;
        if (coinPricier) assertGt(tokensBurned, 1e18);
        else assertGt(ethReturned, 1e9);
        _assertGraduatorEmpty(e.token);
        _assertSolvent(e.token);
    }

    function test_graduate_skewedPool_emitsMindFundedForLeftoverEth() public {
        _wire(WETH_HIGH); // coin is token0: a lower price means a cheaper coin => ETH left over
        Expectation memory e = _completeAndExpect();
        address pool = factory.createPool(e.token, address(weth), FEE_TIER);
        IUniswapV3Pool(pool).initialize(e.expectedSqrtPrice / 2);
        vm.recordLogs();
        launchpad.graduate(e.token);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = IMindLaunchpad.MindFunded.selector;
        uint256 found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(launchpad) && logs[i].topics[0] == topic) {
                assertEq(logs[i].topics[1], bytes32(uint256(uint160(e.token))));
                assertEq(logs[i].topics[2], bytes32(uint256(uint160(address(graduator)))));
                assertEq(abi.decode(logs[i].data, (uint256)), e.ethLiquidity - weth.balanceOf(pool));
                ++found;
            }
        }
        assertEq(found, 1);
    }

    function test_graduate_preCreatedUninitializedPool() public {
        _wire(WETH_LOW);
        Expectation memory e = _completeAndExpect();
        address pool = factory.createPool(e.token, address(weth), FEE_TIER);
        vm.recordLogs();
        launchpad.graduate(e.token);
        assertEq(_countSkewEvents(vm.getRecordedLogs()), 0);
        (uint160 sqrtPrice,,,,,,) = IUniswapV3Pool(pool).slot0();
        assertEq(sqrtPrice, e.expectedSqrtPrice);
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

        UniswapV3Graduator g = new UniswapV3Graduator(owner, lp, address(npm), address(factory), WETH_LOW, 3000);
        assertEq(g.owner(), owner);
        assertEq(g.launchpad(), lp);
        assertEq(address(g.positionManager()), address(npm));
        assertEq(address(g.factory()), address(factory));
        assertEq(address(g.weth9()), WETH_LOW);
        assertEq(g.feeTier(), 3000);
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
        (uint160 sqrtPrice,,,,,,) = IUniswapV3Pool(graduator.poolOf(e.token)).slot0();
        // (sqrtPrice / 2^96)^2 * 1e18 = wei per 1e18 coins ~ ethLiquidity * 1e18 / LP_SUPPLY (~1.95e-8 ETH per coin).
        uint256 priceWad = Math.mulDiv(Math.mulDiv(uint256(sqrtPrice), uint256(sqrtPrice), 1 << 96), 1e18, 1 << 96);
        assertApproxEqRel(priceWad, e.ethLiquidity * 1e18 / LP_SUPPLY, 1e9);
        assertApproxEqRel(priceWad, 19_500_000_000, 0.01e18);
    }
}
