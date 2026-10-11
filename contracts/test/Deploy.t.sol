// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BeagleToken} from "../src/BeagleToken.sol";
import {CreditDesk} from "../src/CreditDesk.sol";
import {ManualPriceSource} from "../src/ManualPriceSource.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {Deploy} from "../script/Deploy.s.sol";

/// @dev Runs `script/Deploy.s.sol` inside the test EVM (SPEC §3.5). `vm.setEnv` is process-global and forge runs
///      tests in parallel, so every environment-dependent case lives in ONE test function; the chain id is pinned
///      to a scratch value so the script never touches `deployments/31337.json`, and every file it writes is
///      removed again.
contract DeployScriptTest is Test {
    uint256 internal constant CHAIN = 424_242;
    uint256 internal constant DEPLOYER_PK = 0xDE9107;
    address internal deployer = vm.addr(DEPLOYER_PK);
    address internal multisig = makeAddr("multisig");
    address internal operator = makeAddr("operator");
    address internal poster = makeAddr("poster");
    string internal path;

    function setUp() public {
        vm.chainId(CHAIN);
        vm.warp(1_700_000_000);
        vm.deal(deployer, 100 ether);
        path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(CHAIN), ".json");
        if (vm.exists(path)) vm.removeFile(path);
    }

    function test_deployScript_allEnvCases() public {
        _caseDefaultsAndDryRun();
        _caseOwnerHandoverAndParams();
        _caseExistingToken();
        _caseBadEnv();
        _clearEnv();
    }

    // ─── Cases ────────────────────────────────────────────────────────────────────────────────────────

    /// Deployer = owner = operator = poster, token deployed by the script, bootstrap price forced.
    function _caseDefaultsAndDryRun() internal {
        _resetEnv();
        vm.setEnv("INITIAL_PRICE_E18", "10000000000000000");

        // Not broadcasting and no WRITE_DEPLOYMENT: a dry run must leave the deployment file alone.
        new Deploy().run();
        assertFalse(vm.exists(path), "dry run wrote the deployment file");

        vm.setEnv("WRITE_DEPLOYMENT", "true");
        new Deploy().run();
        string memory json = _readAndRemove();
        _assertKeys(json);
        CreditDesk desk = CreditDesk(vm.parseJsonAddress(json, ".creditDesk"));
        ManualPriceSource src = ManualPriceSource(vm.parseJsonAddress(json, ".priceSource"));
        BeagleToken token = BeagleToken(vm.parseJsonAddress(json, ".token"));
        assertEq(vm.parseJsonUint(json, ".chainId"), CHAIN);
        assertEq(vm.parseJsonString(json, ".tokenSymbol"), "BEAGLE");
        assertEq(vm.parseJsonUint(json, ".tokenDecimals"), 18);
        assertTrue(vm.parseJsonBool(json, ".nativeBurn"));
        assertEq(vm.parseJsonString(json, ".priceSourceKind"), "manual");
        assertEq(vm.parseJsonUint(json, ".deployBlock"), block.number);
        assertEq(vm.parseJsonAddress(json, ".owner"), deployer);
        assertEq(vm.parseJsonAddress(json, ".pendingOwner"), address(0));
        assertEq(vm.parseJsonAddress(json, ".operator"), deployer);
        assertEq(vm.parseJsonAddress(json, ".poster"), deployer);

        assertEq(token.balanceOf(deployer), token.TOTAL_SUPPLY());
        assertEq(address(desk.token()), address(token));
        assertTrue(desk.nativeBurn());
        assertEq(address(desk.priceSource()), address(src));
        assertEq(desk.owner(), deployer);
        assertEq(desk.pendingOwner(), address(0));
        assertEq(desk.operator(), deployer);
        assertEq(desk.maxPriceAge(), 3600);
        assertEq(desk.minBurn(), 0);
        assertEq(src.owner(), deployer);
        assertEq(src.poster(), deployer);
        (uint256 p, uint256 t) = src.latestPrice();
        assertEq(p, 1e16);
        assertEq(t, block.timestamp);
        (uint256 usd,,) = desk.quote(1000e18);
        assertEq(usd, 10_000_000);
    }

    /// OWNER ≠ deployer: two-step transfer on BOTH contracts; operator/poster/params applied; no bootstrap price.
    function _caseOwnerHandoverAndParams() internal {
        _resetEnv();
        vm.setEnv("WRITE_DEPLOYMENT", "true");
        vm.setEnv("OWNER", vm.toString(multisig));
        vm.setEnv("OPERATOR", vm.toString(operator));
        vm.setEnv("POSTER", vm.toString(poster));
        vm.setEnv("TOKEN_RECIPIENT", vm.toString(multisig));
        vm.setEnv("MAX_PRICE_AGE", "7200");
        vm.setEnv("MIN_BURN", "5000000000000000000");
        vm.setEnv("INITIAL_PRICE_E18", "0");
        new Deploy().run();
        string memory json = _readAndRemove();
        CreditDesk desk = CreditDesk(vm.parseJsonAddress(json, ".creditDesk"));
        ManualPriceSource src = ManualPriceSource(vm.parseJsonAddress(json, ".priceSource"));
        BeagleToken token = BeagleToken(vm.parseJsonAddress(json, ".token"));

        assertEq(token.balanceOf(multisig), token.TOTAL_SUPPLY());
        assertEq(desk.owner(), deployer, "desk owner before acceptance");
        assertEq(desk.pendingOwner(), multisig, "desk pending owner");
        assertEq(src.owner(), deployer, "source owner before acceptance");
        assertEq(src.pendingOwner(), multisig, "source pending owner");
        assertEq(desk.operator(), operator);
        assertEq(src.poster(), poster);
        assertEq(desk.maxPriceAge(), 7200);
        assertEq(desk.minBurn(), 5e18);
        (uint256 p,) = src.latestPrice();
        assertEq(p, 0);
        // The JSON records the on-chain owner at deploy time plus the pending one, not the intended owner.
        assertEq(vm.parseJsonAddress(json, ".owner"), deployer);
        assertEq(vm.parseJsonAddress(json, ".pendingOwner"), multisig);
        assertEq(vm.parseJsonAddress(json, ".operator"), operator);
        assertEq(vm.parseJsonAddress(json, ".poster"), poster);

        vm.startPrank(multisig);
        desk.acceptOwnership();
        src.acceptOwnership();
        vm.stopPrank();
        assertEq(desk.owner(), multisig);
        assertEq(src.owner(), multisig);
    }

    /// Existing TOKEN: NATIVE_BURN is required; `true` is verified against the token unless NATIVE_BURN_UNCHECKED.
    function _caseExistingToken() internal {
        MockERC20 plain = new MockERC20("Plain", "PLN", 6);
        BeagleToken burnable = new BeagleToken(address(this));
        Deploy d = new Deploy();

        _resetEnv();
        vm.setEnv("TOKEN", vm.toString(address(plain)));
        vm.expectRevert(Deploy.NativeBurnRequired.selector);
        d.run();

        vm.setEnv("NATIVE_BURN", "true"); // the token has no burn(uint256)
        vm.expectRevert(Deploy.TokenNotBurnable.selector);
        d.run();
        assertFalse(vm.exists(path), "a refused deploy must not write the deployment file");

        vm.setEnv("NATIVE_BURN_UNCHECKED", "true");
        vm.setEnv("WRITE_DEPLOYMENT", "true");
        d.run();
        string memory json = _readAndRemove();
        assertTrue(CreditDesk(vm.parseJsonAddress(json, ".creditDesk")).nativeBurn());

        vm.setEnv("NATIVE_BURN_UNCHECKED", "");
        vm.setEnv("NATIVE_BURN", "false"); // dead-address mode: any ERC-20 works
        d.run();
        json = _readAndRemove();
        CreditDesk desk = CreditDesk(vm.parseJsonAddress(json, ".creditDesk"));
        assertFalse(desk.nativeBurn());
        assertEq(address(desk.token()), address(plain));
        assertEq(desk.tokenDecimals(), 6);
        assertEq(vm.parseJsonAddress(json, ".token"), address(plain));
        assertEq(vm.parseJsonString(json, ".tokenSymbol"), "PLN");
        assertEq(vm.parseJsonUint(json, ".tokenDecimals"), 6);
        assertFalse(vm.parseJsonBool(json, ".nativeBurn"));

        vm.setEnv("TOKEN", vm.toString(address(burnable)));
        vm.setEnv("NATIVE_BURN", "true"); // a burnable token passes the probe
        d.run();
        json = _readAndRemove();
        desk = CreditDesk(vm.parseJsonAddress(json, ".creditDesk"));
        assertTrue(desk.nativeBurn());
        assertEq(address(desk.token()), address(burnable));
        assertEq(vm.parseJsonString(json, ".tokenSymbol"), "BEAGLE");
    }

    function _caseBadEnv() internal {
        _resetEnv();
        Deploy d = new Deploy();
        vm.setEnv("MAX_PRICE_AGE", "0");
        vm.expectRevert(Deploy.BadMaxPriceAge.selector);
        d.run();
        vm.setEnv("MAX_PRICE_AGE", "4294967296"); // > uint32
        vm.expectRevert(Deploy.BadMaxPriceAge.selector);
        d.run();
        assertFalse(vm.exists(path));
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────────────────────────────

    function _envNames() internal pure returns (string[11] memory) {
        return [
            "TOKEN",
            "TOKEN_RECIPIENT",
            "NATIVE_BURN",
            "NATIVE_BURN_UNCHECKED",
            "OWNER",
            "OPERATOR",
            "POSTER",
            "INITIAL_PRICE_E18",
            "MAX_PRICE_AGE",
            "MIN_BURN",
            "WRITE_DEPLOYMENT"
        ];
    }

    /// @dev Every script variable empty (= default) and the deployer key set.
    function _resetEnv() internal {
        string[11] memory names = _envNames();
        for (uint256 i = 0; i < names.length; i++) {
            vm.setEnv(names[i], "");
        }
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(DEPLOYER_PK));
    }

    function _clearEnv() internal {
        _resetEnv();
        vm.setEnv("DEPLOYER_PRIVATE_KEY", "");
    }

    function _readAndRemove() internal returns (string memory json) {
        assertTrue(vm.exists(path), "deployment file not written");
        json = vm.readFile(path);
        vm.removeFile(path);
    }

    /// @dev SPEC §3.5 key set plus `pendingOwner`.
    function _assertKeys(string memory json) internal view {
        string[13] memory expected = [
            "chainId",
            "token",
            "tokenSymbol",
            "tokenDecimals",
            "nativeBurn",
            "creditDesk",
            "priceSource",
            "priceSourceKind",
            "deployBlock",
            "owner",
            "pendingOwner",
            "operator",
            "poster"
        ];
        for (uint256 i = 0; i < expected.length; i++) {
            assertTrue(vm.keyExistsJson(json, string.concat(".", expected[i])), string.concat("missing ", expected[i]));
        }
        assertEq(vm.parseJsonKeys(json, ".").length, expected.length, "unexpected extra key");
    }
}
