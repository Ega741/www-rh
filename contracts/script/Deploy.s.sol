// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {BeagleToken} from "../src/BeagleToken.sol";
import {CreditDesk} from "../src/CreditDesk.sol";
import {ManualPriceSource} from "../src/ManualPriceSource.sol";

/// @title Deploy
/// @notice Deploys `ManualPriceSource` + `CreditDesk` (and `BeagleToken` when `TOKEN` is unset) and writes
///         `deployments/<chainId>.json`. Environment (SPEC §3.5):
///         DEPLOYER_PRIVATE_KEY (or `--private-key`), TOKEN, TOKEN_RECIPIENT, NATIVE_BURN, OWNER, OPERATOR,
///         POSTER, INITIAL_PRICE_E18, MAX_PRICE_AGE, MIN_BURN.
contract Deploy is Script {
    error NativeBurnRequired();
    error BadMaxPriceAge();

    struct Config {
        address deployer;
        address token; // zero → deploy BeagleToken
        address tokenRecipient;
        bool nativeBurn;
        address owner;
        address operator;
        address poster;
        uint256 initialPriceE18;
        uint32 maxPriceAge;
        uint256 minBurn;
    }

    function run() external {
        uint256 pk = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        Config memory c = _config(pk != 0 ? vm.addr(pk) : msg.sender);
        uint256 deployBlock = block.number;

        if (pk != 0) vm.startBroadcast(pk);
        else vm.startBroadcast();

        address token = c.token;
        if (token == address(0)) {
            token = address(new BeagleToken(c.tokenRecipient));
            console.log("BeagleToken deployed:", token, "supply to", c.tokenRecipient);
        }
        // Owner is the deployer during setup so forcePrice/params can be applied; transferred below.
        ManualPriceSource priceSource = new ManualPriceSource(c.deployer, c.poster);
        CreditDesk desk = new CreditDesk(IERC20(token), c.nativeBurn, priceSource, c.deployer, c.operator);
        if (c.maxPriceAge != 3600) desk.setMaxPriceAge(c.maxPriceAge);
        if (c.minBurn != 0) desk.setMinBurn(c.minBurn);
        if (c.initialPriceE18 > 0) {
            priceSource.forcePrice(c.initialPriceE18);
            console.log("Initial price forced (E18):", c.initialPriceE18);
        }
        if (c.owner != c.deployer) {
            priceSource.transferOwnership(c.owner);
            desk.transferOwnership(c.owner);
            console.log("Ownership of CreditDesk and ManualPriceSource transferred to", c.owner);
            console.log("  -> pending: the new owner must call acceptOwnership() on both contracts.");
        }
        vm.stopBroadcast();

        console.log("chainId:          ", block.chainid);
        console.log("token:            ", token);
        console.log("nativeBurn:       ", c.nativeBurn);
        console.log("ManualPriceSource:", address(priceSource));
        console.log("CreditDesk:       ", address(desk));
        console.log("owner/operator/poster:", c.owner, c.operator, c.poster);
        console.log("deployBlock:      ", deployBlock);

        _writeDeployment(c, token, desk, priceSource, deployBlock);
    }

    function _config(address deployer) internal view returns (Config memory c) {
        c.deployer = deployer;
        string memory tokenStr = _envString("TOKEN");
        bool deployToken = bytes(tokenStr).length == 0;
        c.token = deployToken ? address(0) : vm.parseAddress(tokenStr);
        c.tokenRecipient = _envAddress("TOKEN_RECIPIENT", deployer);
        string memory nativeBurnStr = _envString("NATIVE_BURN");
        if (bytes(nativeBurnStr).length == 0) {
            if (!deployToken) revert NativeBurnRequired(); // required for an existing token
            c.nativeBurn = true;
        } else {
            c.nativeBurn = vm.parseBool(nativeBurnStr);
        }
        c.owner = _envAddress("OWNER", deployer);
        c.operator = _envAddress("OPERATOR", deployer);
        c.poster = _envAddress("POSTER", deployer);
        c.initialPriceE18 = _envUint("INITIAL_PRICE_E18", 0);
        uint256 maxPriceAge = _envUint("MAX_PRICE_AGE", 3600);
        if (maxPriceAge == 0 || maxPriceAge > type(uint32).max) revert BadMaxPriceAge();
        // forge-lint: disable-next-line(unsafe-typecast)
        c.maxPriceAge = uint32(maxPriceAge); // bounds checked above
        c.minBurn = _envUint("MIN_BURN", 0);
    }

    function _writeDeployment(
        Config memory c,
        address token,
        CreditDesk desk,
        ManualPriceSource priceSource,
        uint256 deployBlock
    ) internal {
        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "token", token);
        vm.serializeString(k, "tokenSymbol", IERC20Metadata(token).symbol());
        vm.serializeUint(k, "tokenDecimals", desk.tokenDecimals());
        vm.serializeBool(k, "nativeBurn", c.nativeBurn);
        vm.serializeAddress(k, "creditDesk", address(desk));
        vm.serializeAddress(k, "priceSource", address(priceSource));
        vm.serializeString(k, "priceSourceKind", "manual");
        vm.serializeUint(k, "deployBlock", deployBlock);
        vm.serializeAddress(k, "owner", c.owner);
        vm.serializeAddress(k, "operator", c.operator);
        string memory json = vm.serializeAddress(k, "poster", c.poster);
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console.log("Wrote", path);
    }

    // Env helpers: an unset OR empty variable yields the default (plain `envOr` reverts on "").
    function _envString(string memory name) internal view returns (string memory) {
        return vm.envOr(name, string(""));
    }

    function _envAddress(string memory name, address dflt) internal view returns (address) {
        string memory s = _envString(name);
        return bytes(s).length == 0 ? dflt : vm.parseAddress(s);
    }

    function _envUint(string memory name, uint256 dflt) internal view returns (uint256) {
        string memory s = _envString(name);
        return bytes(s).length == 0 ? dflt : vm.parseUint(s);
    }
}
