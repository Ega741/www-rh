// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {IPonsMindRegistry} from "./interfaces/IPonsMindRegistry.sol";
import {IPonsV2BondingCurve} from "./interfaces/pons/IPonsV2BondingCurve.sol";
import {IPonsV2FeeEscrow} from "./interfaces/pons/IPonsV2FeeEscrow.sol";
import {IPonsV2LaunchFactory} from "./interfaces/pons/IPonsV2LaunchFactory.sol";
import {IPonsV2MemeHook} from "./interfaces/pons/IPonsV2MemeHook.sol";
import {MindAccount} from "./MindAccount.sol";
import {MindCore} from "./MindCore.sol";

/// @title PonsMindRegistry
/// @notice Pons mode of "worldwideweb on Robinhood Chain" (SPEC §9): minds layered on Pons V2 launches instead of
///         the in-house bonding curve. Each mind's {MindAccount} clone is the launch's creator fee recipient, so the
///         creator fee share and creator tax Pons credits on every fee sweep accrue to it in the Pons fee escrow;
///         {harvest} sweeps (best effort) and claims them into the {MindCore} vault, from which the operator draws
///         compute exactly as on the launchpad.
/// @dev Accounting invariant: `address(this).balance == Σ mindBalance + protocolBalance` (barring forced ETH). ETH
///      enters through {launchMind} (launch fee and initial buy are forwarded to Pons in the same call; the creation
///      fee stays as protocol balance), {fundMind}, and {receive} while a return window is open: the Pons curve's buy
///      refund during {launchMind} (forwarded to the creator in the same transaction) and the mind account's claim
///      during {harvest} (must equal the amount the account reports, else `EthReturnMismatch()`). Native quote only;
///      `buybackEnabled` is always false for minds launched here. Pons' own contracts are outside this audit.
contract PonsMindRegistry is IPonsMindRegistry, MindCore {
    // ---------------------------------------------------------------------------------------------
    // Constants / immutables
    // ---------------------------------------------------------------------------------------------

    uint16 internal constant MAX_MIND_FEE_BPS = 1000;

    /// @inheritdoc IPonsMindRegistry
    IPonsV2LaunchFactory public immutable factory;
    /// @inheritdoc IPonsMindRegistry
    IPonsV2FeeEscrow public immutable feeEscrow;
    /// @inheritdoc IPonsMindRegistry
    IPonsV2MemeHook public immutable memeHook;
    /// @inheritdoc IPonsMindRegistry
    address public immutable accountImplementation;

    // ---------------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------------

    uint16 private _mindFeeBps;
    mapping(address token => PonsMind) private _ponsMinds;
    mapping(address account => address token) private _tokenOf;
    mapping(address token => bytes32 poolId) private _poolIds;

    // ---------------------------------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------------------------------

    /// @param initialOwner     Initial owner (Ownable2Step).
    /// @param treasury_        Protocol treasury (may withdraw protocol fees, like the owner).
    /// @param computeTreasury_ Recipient of every {drawCompute}.
    /// @param operator_        Runner hot wallet (draws, anchors, status, {setPoolId}).
    /// @param factory_         Pons V2 launch factory.
    /// @param feeEscrow_       Pons V2 fee escrow.
    /// @param memeHook_        Pons V2 meme hook.
    /// @dev Deploys the {MindAccount} implementation. Events: TreasuryUpdated, ComputeTreasuryUpdated,
    ///      OperatorUpdated, DrawLimitUpdated, MindFeeUpdated(0).
    constructor(
        address initialOwner,
        address treasury_,
        address computeTreasury_,
        address operator_,
        address factory_,
        address feeEscrow_,
        address memeHook_
    ) MindCore(initialOwner, treasury_, computeTreasury_, operator_) {
        if (factory_ == address(0) || feeEscrow_ == address(0) || memeHook_ == address(0)) {
            revert ZeroAddress();
        }
        factory = IPonsV2LaunchFactory(factory_);
        feeEscrow = IPonsV2FeeEscrow(feeEscrow_);
        memeHook = IPonsV2MemeHook(memeHook_);
        accountImplementation = address(new MindAccount());
        _initDrawLimit();
        emit MindFeeUpdated(0);
    }

    // ---------------------------------------------------------------------------------------------
    // Creator
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IPonsMindRegistry
    function launchMind(
        LaunchParams calldata p,
        uint256 quoteIn,
        uint256 minTokensOut,
        bytes32 modelId,
        bytes32 personaHash,
        string calldata metadataURI
    ) external payable whenNotPaused nonReentrant returns (address token, address curve, address account) {
        _checkNameSymbol(p.name, p.symbol);
        _checkConfig(modelId, metadataURI);
        uint256 launchFee = factory.launchFee();
        if (msg.value != launchFee + quoteIn + _creationFee) revert WrongValue();

        account = _deployAccount(keccak256(abi.encode(msg.sender, p.salt)));
        (token, curve) = _launch(p, account, launchFee);
        _registerLaunch(p, token, curve, account, modelId, personaHash, metadataURI);
        if (quoteIn > 0) _initialBuy(curve, quoteIn, minTokensOut);
    }

    /// @inheritdoc IPonsMindRegistry
    /// @dev Only the launch's current creator fee recipient may prepare, so nobody can occupy a token's single
    ///      adoption slot (the account salt is the token) ahead of the party whose hand-off activates it. A pending
    ///      preparation can be replaced by whoever is the recipient now (e.g. after the role changed hands): creator
    ///      and config are overwritten, the account is reused and the status is reset to Dormant.
    function prepareAdoption(address token, bytes32 modelId, bytes32 personaHash, string calldata metadataURI)
        external
        whenNotPaused
        nonReentrant
        returns (address account)
    {
        _checkConfig(modelId, metadataURI);
        IPonsV2LaunchFactory.LaunchedToken memory launch = factory.getLaunchedToken(token);
        if (!launch.exists || launch.pairToken != address(0)) revert NotPonsLaunch();
        if (msg.sender != launch.creatorFeeRecipient) revert NotRecipientOrDeployer();

        PonsMind storage m = _ponsMinds[token];
        account = m.account;
        if (account != address(0)) {
            if (m.launchedHere) revert AccountExists();
            if (m.adopted) revert AlreadyAdopted();
            _replacePreparation(token, modelId, personaHash, metadataURI);
            emit AdoptionPrepared(token, account, msg.sender);
            return account;
        }

        account = _deployAccount(keccak256(abi.encode(token)));
        _tokenOf[account] = token;
        _ponsMinds[token] =
            PonsMind({curve: launch.curve, account: account, launchConfigId: 0, launchedHere: false, adopted: false});
        _addMind(
            token,
            MindInfo({
                creator: msg.sender,
                modelId: modelId,
                personaHash: personaHash,
                metadataURI: metadataURI,
                createdAt: uint64(block.timestamp),
                status: MindStatus.Dormant
            })
        );
        emit AdoptionPrepared(token, account, msg.sender);
    }

    /// @inheritdoc IPonsMindRegistry
    function activateAdoption(address token) external nonReentrant onlyMind(token) {
        PonsMind storage m = _ponsMinds[token];
        if (m.launchedHere || m.adopted) revert AlreadyAdopted();
        address account = m.account;
        if (factory.getLaunchedToken(token).creatorFeeRecipient != account) revert AdoptionNotReady();
        m.adopted = true;
        MindInfo storage info = _mindInfo[token];
        if (info.status == MindStatus.Dormant) {
            info.status = MindStatus.Alive;
            emit MindStatusChanged(token, MindStatus.Alive);
        }
        emit MindAdopted(token, account);
    }

    /// @inheritdoc IPonsMindRegistry
    function leave(address token, address newRecipient) external nonReentrant onlyCreator(token) {
        MindInfo storage info = _mindInfo[token];
        if (info.status != MindStatus.Dormant) {
            info.status = MindStatus.Dormant;
            emit MindStatusChanged(token, MindStatus.Dormant);
        }
        MindAccount(payable(_ponsMinds[token].account)).transferFeeRecipient(factory, token, newRecipient);
        emit MindLeft(token, newRecipient);
    }

    // ---------------------------------------------------------------------------------------------
    // Permissionless
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IPonsMindRegistry
    /// @dev Sweep attempts (each in try/catch, failures only reflected in {SweepAttempted}): while the curve trades,
    ///      first through the account (Pons' curve authorizes its current creator fee recipient), then, for minds
    ///      launched here, directly (in case the curve authorizes the launch deployer); once the pool is created and
    ///      its id recorded, through the account as the pool's creator. The claim then runs in a return window opened
    ///      for the account only, and the counted wei must equal what the account reports.
    function harvest(address token) external nonReentrant onlyMind(token) {
        PonsMind storage m = _ponsMinds[token];
        address account = m.account;
        (bool curveSwept, bool poolSwept) = _trySweep(token, m.curve, account, m.launchedHere);
        emit SweepAttempted(token, curveSwept, poolSwept);

        _openReturn(account);
        uint256 ethOut = MindAccount(payable(account)).claim(feeEscrow);
        _closeReturn(ethOut);

        uint256 mindFee = ethOut * _mindFeeBps / BPS;
        uint256 credited = ethOut - mindFee;
        if (mindFee > 0) {
            _protocolBalance += mindFee;
            emit FeeAccrued(token, 0, mindFee);
        }
        if (credited > 0) {
            _mindBalances[token] += credited;
            emit MindFunded(token, account, credited);
        }
        emit Harvested(token, credited, 0);
    }

    /// @inheritdoc IPonsMindRegistry
    function createGraduatedPool(address token) external nonReentrant onlyMind(token) {
        factory.createGraduatedPool(token);
    }

    // ---------------------------------------------------------------------------------------------
    // Operator / owner
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IPonsMindRegistry
    function setPoolId(address token, bytes32 poolId) external onlyOperator onlyMind(token) {
        _poolIds[token] = poolId;
        emit PoolIdSet(token, poolId);
    }

    /// @inheritdoc IPonsMindRegistry
    function setMindFeeBps(uint16 bps) external onlyOwner {
        if (bps > MAX_MIND_FEE_BPS) revert FeeTooHigh();
        _mindFeeBps = bps;
        emit MindFeeUpdated(bps);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IPonsMindRegistry
    function ponsMind(address token) external view returns (PonsMind memory) {
        return _ponsMinds[token];
    }

    /// @inheritdoc IPonsMindRegistry
    function accountOf(address token) external view returns (address) {
        return _ponsMinds[token].account;
    }

    /// @inheritdoc IPonsMindRegistry
    function tokenOf(address account) external view returns (address) {
        return _tokenOf[account];
    }

    /// @inheritdoc IPonsMindRegistry
    function poolIdOf(address token) external view returns (bytes32) {
        return _poolIds[token];
    }

    /// @inheritdoc IPonsMindRegistry
    function predictAccount(address creator, bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(accountImplementation, keccak256(abi.encode(creator, salt)));
    }

    /// @inheritdoc IPonsMindRegistry
    function predictAdoptionAccount(address token) external view returns (address) {
        return Clones.predictDeterministicAddress(accountImplementation, keccak256(abi.encode(token)));
    }

    /// @inheritdoc IPonsMindRegistry
    function claimable(address token) external view returns (uint256) {
        address account = _ponsMinds[token].account;
        return account == address(0) ? 0 : feeEscrow.balanceOf(account);
    }

    /// @inheritdoc IPonsMindRegistry
    function launchQuote(uint256 launchConfigId, uint256 quoteIn)
        external
        view
        returns (uint256 launchFee, uint256 total, bytes32 economics)
    {
        launchFee = factory.launchFee();
        total = launchFee + quoteIn + _creationFee;
        economics = factory.previewLaunchEconomics(launchConfigId, address(0));
    }

    /// @inheritdoc IPonsMindRegistry
    function mindFeeBps() external view returns (uint16) {
        return _mindFeeBps;
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    /// @dev Clones the account implementation at `salt` (reverting {AccountExists} if that address is taken) and
    ///      binds it to this registry.
    function _deployAccount(bytes32 salt) private returns (address account) {
        address implementation = accountImplementation;
        if (Clones.predictDeterministicAddress(implementation, salt).code.length != 0) revert AccountExists();
        account = Clones.cloneDeterministic(implementation, salt);
        MindAccount(payable(account)).initialize(address(this));
    }

    /// @dev Re-preparation of a pending adoption by the current recipient: overwrites the creator and config (keeps
    ///      `createdAt`) and resets the status to Dormant.
    function _replacePreparation(address token, bytes32 modelId, bytes32 personaHash, string calldata metadataURI)
        private
    {
        MindInfo storage info = _mindInfo[token];
        info.creator = msg.sender;
        info.modelId = modelId;
        info.personaHash = personaHash;
        info.metadataURI = metadataURI;
        if (info.status != MindStatus.Dormant) {
            info.status = MindStatus.Dormant;
            emit MindStatusChanged(token, MindStatus.Dormant);
        }
    }

    /// @dev `factory.launchToken` with the mind account as creator fee recipient, native quote, buyback disabled and
    ///      the caller as the only extra snipe-tax exemption (Pons exempts the registry and the account itself).
    function _launch(LaunchParams calldata p, address account, uint256 launchFee)
        private
        returns (address token, address curve)
    {
        address[] memory exemptions = new address[](1);
        exemptions[0] = msg.sender;
        (token, curve) = factory.launchToken{value: launchFee}(
            IPonsV2LaunchFactory.TokenParams({
                name: p.name,
                symbol: p.symbol,
                logo: p.logo,
                description: p.description,
                socials: p.socials,
                creatorFeeRecipient: account,
                creatorTaxBps: p.creatorTaxBps,
                buybackEnabled: false,
                expectedEconomics: p.expectedEconomics,
                salt: p.salt
            }),
            p.launchConfigId,
            address(0),
            exemptions
        );
        if (token == address(0) || curve == address(0) || _mindInfo[token].creator != address(0)) {
            revert LaunchFailed();
        }
    }

    /// @dev Effects of {launchMind}: records the account, the Pons record and the mind (status Alive), emits
    ///      {MindCreated} and {MindLaunched}, and books the creation fee as protocol balance.
    function _registerLaunch(
        LaunchParams calldata p,
        address token,
        address curve,
        address account,
        bytes32 modelId,
        bytes32 personaHash,
        string calldata metadataURI
    ) private {
        _tokenOf[account] = token;
        _ponsMinds[token] = PonsMind({
            curve: curve, account: account, launchConfigId: p.launchConfigId, launchedHere: true, adopted: false
        });
        MindInfo memory info = MindInfo({
            creator: msg.sender,
            modelId: modelId,
            personaHash: personaHash,
            metadataURI: metadataURI,
            createdAt: uint64(block.timestamp),
            status: MindStatus.Alive
        });
        _addMind(token, info);
        _emitLaunched(p, token, curve, account, info);

        uint256 fee = _creationFee;
        if (fee > 0) {
            _protocolBalance += fee;
            emit FeeAccrued(token, 0, fee);
        }
    }

    /// @dev Emits {MindCreated} then {MindLaunched} for a mind registered by {launchMind}.
    function _emitLaunched(LaunchParams calldata p, address token, address curve, address account, MindInfo memory info)
        private
    {
        emit MindCreated(token, info.creator, p.name, p.symbol, info.metadataURI, info.modelId, info.personaHash);
        emit MindLaunched(token, curve, account, info.creator, p.launchConfigId);
    }

    /// @dev Initial buy for the caller; the curve refunds unspent quote to this contract (counted in a return window
    ///      opened for the curve only), which is forwarded to the caller in the same transaction.
    function _initialBuy(address curve, uint256 quoteIn, uint256 minTokensOut) private {
        _openReturn(curve);
        IPonsV2BondingCurve(curve).buy{value: quoteIn}(quoteIn, minTokensOut, msg.sender);
        uint256 refund = _takeReturned();
        if (refund > 0) _sendEth(msg.sender, refund);
    }

    /// @dev Best-effort fee sweeps into the escrow (see {harvest}); never reverts on a failed sweep.
    function _trySweep(address token, address curve, address account, bool launchedHere)
        private
        returns (bool curveSwept, bool poolSwept)
    {
        IPonsV2LaunchFactory.GraduationPhase phase = factory.getLaunchedToken(token).phase;
        if (phase == IPonsV2LaunchFactory.GraduationPhase.NotGraduated) {
            try MindAccount(payable(account)).sweepCurve(IPonsV2BondingCurve(curve), 0) {
                curveSwept = true;
            } catch {}
            if (!curveSwept && launchedHere) {
                try IPonsV2BondingCurve(curve).sweepFees(0) {
                    curveSwept = true;
                } catch {}
            }
        } else if (phase == IPonsV2LaunchFactory.GraduationPhase.PoolCreated) {
            bytes32 poolId = _poolIds[token];
            if (poolId != bytes32(0)) {
                try MindAccount(payable(account)).sweepPool(memeHook, poolId, 0, 0) {
                    poolSwept = true;
                } catch {}
            }
        }
    }
}
