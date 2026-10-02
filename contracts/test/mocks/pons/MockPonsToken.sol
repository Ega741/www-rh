// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {IPonsV2LaunchFactory} from "../../../src/interfaces/pons/IPonsV2LaunchFactory.sol";

/// @notice Model of `PonsV2LauncherToken`: fixed-supply ERC20 whose whole supply is minted to the launch's bonding
///         curve, with the launch metadata stored on the token.
contract MockPonsToken is ERC20 {
    address public immutable deployer;
    address public immutable curve;
    address public immutable factory;
    string public logo;
    string public description;
    IPonsV2LaunchFactory.Socials private _socials;

    constructor(
        IPonsV2LaunchFactory.TokenParams memory params,
        address deployer_,
        address curve_,
        address factory_,
        uint256 supply
    ) ERC20(params.name, params.symbol) {
        deployer = deployer_;
        curve = curve_;
        factory = factory_;
        logo = params.logo;
        description = params.description;
        _socials = params.socials;
        _mint(curve_, supply);
    }

    function socials() external view returns (IPonsV2LaunchFactory.Socials memory) {
        return _socials;
    }
}
