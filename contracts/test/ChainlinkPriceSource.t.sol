// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AggregatorV3Interface} from "../src/interfaces/AggregatorV3Interface.sol";
import {ChainlinkPriceSource} from "../src/ChainlinkPriceSource.sol";
import {CreditDesk} from "../src/CreditDesk.sol";
import {BeagleToken} from "../src/BeagleToken.sol";
import {MockAggregatorV3} from "../src/mocks/MockAggregatorV3.sol";

contract ChainlinkPriceSourceTest is Test {
    function setUp() public {
        vm.warp(1_700_000_000);
    }

    function test_constructor_zeroFeedReverts() public {
        vm.expectRevert(ChainlinkPriceSource.ZeroAddress.selector);
        new ChainlinkPriceSource(AggregatorV3Interface(address(0)));
    }

    function test_constructor_badDecimalsReverts() public {
        MockAggregatorV3 feed = new MockAggregatorV3(37);
        vm.expectRevert(ChainlinkPriceSource.BadDecimals.selector);
        new ChainlinkPriceSource(feed);
    }

    function test_constructor_state() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8);
        ChainlinkPriceSource src = new ChainlinkPriceSource(feed);
        assertEq(address(src.feed()), address(feed));
        assertEq(src.feedDecimals(), 8);
    }

    function test_rescale8Decimals() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8);
        feed.set(250_000, block.timestamp - 10); // $0.0025 with 8 decimals
        ChainlinkPriceSource src = new ChainlinkPriceSource(feed);
        (uint256 p, uint256 t) = src.latestPrice();
        assertEq(p, 2_500_000_000_000_000);
        assertEq(t, block.timestamp - 10);
    }

    function test_rescale18Decimals() public {
        MockAggregatorV3 feed = new MockAggregatorV3(18);
        feed.set(1e16, 5);
        ChainlinkPriceSource src = new ChainlinkPriceSource(feed);
        (uint256 p, uint256 t) = src.latestPrice();
        assertEq(p, 1e16);
        assertEq(t, 5);
    }

    function test_rescale20Decimals() public {
        MockAggregatorV3 feed = new MockAggregatorV3(20);
        feed.set(1e18 + 99, 7); // truncates the two extra digits
        ChainlinkPriceSource src = new ChainlinkPriceSource(feed);
        (uint256 p,) = src.latestPrice();
        assertEq(p, 1e16);
    }

    function test_nonPositiveAnswerIsUnavailable() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8);
        ChainlinkPriceSource src = new ChainlinkPriceSource(feed);
        feed.set(0, 42);
        (uint256 p, uint256 t) = src.latestPrice();
        assertEq(p, 0);
        assertEq(t, 42);
        feed.set(-1, 43);
        (p, t) = src.latestPrice();
        assertEq(p, 0);
        assertEq(t, 43);
    }

    function testFuzz_rescale(uint8 dec, uint256 answer) public {
        dec = uint8(bound(dec, 0, 36));
        answer = bound(answer, 1, 1e36);
        MockAggregatorV3 feed = new MockAggregatorV3(dec);
        feed.set(int256(answer), block.timestamp);
        ChainlinkPriceSource src = new ChainlinkPriceSource(feed);
        (uint256 p,) = src.latestPrice();
        uint256 expected = dec <= 18 ? answer * 10 ** (18 - dec) : answer / 10 ** (dec - 18);
        assertEq(p, expected);
    }

    function test_worksWithDesk() public {
        MockAggregatorV3 feed = new MockAggregatorV3(8);
        feed.set(1_000_000, block.timestamp); // $0.01
        ChainlinkPriceSource src = new ChainlinkPriceSource(feed);
        BeagleToken token = new BeagleToken(address(this));
        CreditDesk desk = new CreditDesk(IERC20(address(token)), true, src, address(this), address(this));
        (uint256 usd, uint256 p,) = desk.quote(1000e18);
        assertEq(p, 1e16);
        assertEq(usd, 10_000_000); // $10
        feed.set(-5, block.timestamp);
        vm.expectRevert(CreditDesk.PriceUnavailable.selector);
        desk.quote(1);
    }
}
