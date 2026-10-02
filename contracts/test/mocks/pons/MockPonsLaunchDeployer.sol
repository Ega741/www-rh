// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPonsV2LaunchFactory} from "../../../src/interfaces/pons/IPonsV2LaunchFactory.sol";
import {MockPonsCurve} from "./MockPonsCurve.sol";
import {MockPonsToken} from "./MockPonsToken.sol";

/// @notice Model of `PonsV2LaunchDeployer`: CREATE2-deploys a launch's curve and token for the factory (split out, as
///         on Pons, to keep the factory under EIP-170) with the salt namespaced per launching account
///         (`keccak256(abi.encode(originalDeployer, salt))`); reusing a salt on identical terms reverts. Enforces the
///         Pons metadata caps.
contract MockPonsLaunchDeployer {
    uint256 private constant MAX_NAME_LENGTH = 64;
    uint256 private constant MAX_SYMBOL_LENGTH = 16;
    uint256 private constant MAX_LOGO_LENGTH = 512;
    uint256 private constant MAX_DESCRIPTION_LENGTH = 2048;
    uint256 private constant MAX_SOCIAL_LENGTH = 256;

    address public immutable factory;

    error NotFactory();
    error MetadataTooLong();

    constructor(address factory_) {
        factory = factory_;
    }

    function deployLaunch(
        IPonsV2LaunchFactory.TokenParams calldata params,
        MockPonsCurve.Config calldata curveConfig,
        address originalDeployer,
        uint256 supply
    ) external returns (address token, address curve) {
        if (msg.sender != factory) revert NotFactory();
        _requireMetadataWithinLimits(params);
        bytes32 salt = keccak256(abi.encode(originalDeployer, params.salt));
        curve = address(new MockPonsCurve{salt: salt}(curveConfig));
        token = address(new MockPonsToken{salt: salt}(params, originalDeployer, curve, factory, supply));
    }

    function _requireMetadataWithinLimits(IPonsV2LaunchFactory.TokenParams calldata p) private pure {
        if (
            bytes(p.name).length > MAX_NAME_LENGTH || bytes(p.symbol).length > MAX_SYMBOL_LENGTH
                || bytes(p.logo).length > MAX_LOGO_LENGTH || bytes(p.description).length > MAX_DESCRIPTION_LENGTH
        ) revert MetadataTooLong();
        if (
            bytes(p.socials.twitter).length > MAX_SOCIAL_LENGTH || bytes(p.socials.telegram).length > MAX_SOCIAL_LENGTH
                || bytes(p.socials.discord).length > MAX_SOCIAL_LENGTH
                || bytes(p.socials.website).length > MAX_SOCIAL_LENGTH
                || bytes(p.socials.farcaster).length > MAX_SOCIAL_LENGTH
        ) revert MetadataTooLong();
    }
}
