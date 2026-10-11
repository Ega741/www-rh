// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ManualPriceSource} from "../src/ManualPriceSource.sol";

/// @title PostPrice
/// @notice Posts a price to a `ManualPriceSource`. Env: PRICE_SOURCE (address), PRICE_E18 (uint),
///         POSTER_PRIVATE_KEY (uint). The post must respect the source's step/interval bounds.
contract PostPrice is Script {
    function run() external {
        ManualPriceSource source = ManualPriceSource(vm.envAddress("PRICE_SOURCE"));
        uint256 priceE18 = vm.envUint("PRICE_E18");
        uint256 pk = vm.envUint("POSTER_PRIVATE_KEY");

        (uint256 oldPrice, uint256 oldAt) = source.latestPrice();
        console.log("ManualPriceSource:", address(source));
        console.log("current price (E18) / updatedAt:", oldPrice, oldAt);
        console.log("posting price (E18):", priceE18, "from", vm.addr(pk));

        vm.startBroadcast(pk);
        source.post(priceE18);
        vm.stopBroadcast();

        (uint256 newPrice, uint256 newAt) = source.latestPrice();
        console.log("new price (E18) / updatedAt:", newPrice, newAt);
    }
}
