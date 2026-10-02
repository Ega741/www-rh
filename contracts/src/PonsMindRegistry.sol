// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {IPonsMindRegistry} from "./interfaces/IPonsMindRegistry.sol";
import {IPonsV2BondingCurve} from "./interfaces/pons/IPonsV2BondingCurve.sol";
import {IPonsV2FeeEscrow} from "./interfaces/pons/IPonsV2FeeEscrow.sol";
import {IPonsV2LaunchFactory} from "./interfaces/pons/IPonsV2LaunchFactory.sol";
import {IPonsV2MemeHook} from "./interfaces/pons/IPonsV2MemeHook.sol";
import {MindAccount} from "./MindAccount.sol";
import {MindCore} from "./MindCore.sol";

/// @title PonsMindRegistry
/// @notice Pons mode of "worldwideweb on Robinhood Chain" (SPEC §9.2, adoption and lifecycle per §9.7): minds layered
///         on Pons V2 launches instead of the in-house bonding curve. Each mind's {MindAccount} clone is the launch's
///         creator fee recipient, so the creator fee share and creator tax Pons credits on every fee sweep accrue to it
///         in the Pons fee escrow; {harvest} sweeps (best effort) and claims them into the {MindCore} vault, from which
///         the operator draws compute exactly as on the launchpad.
/// @dev Accounting invariant: `address(this).balance == Σ mindBalance + protocolBalance` (barring forced ETH). ETH
///      enters through {launchMind} (launch fee and initial buy are forwarded to Pons and any surplus is refunded in the
///      same call; the creation fee stays as protocol balance), {fundMind}, and {receive} while a return window is
///      open: the Pons curve's buy refund during {launchMind} (forwarded to the creator in the same transaction) and
///      the mind account's claim during {harvest}/{leave} (must equal the amount the account reports, else
///      `EthReturnMismatch()`). Adoptions are bound to their preparer: every (token, preparer) pair has its own account
///      and pending config, and the mind is registered (or taken over) only once that account is the creator fee
///      recipient, so a stale preparation can never capture someone else's hand-off. Native quote only; buyback
///      launches are neither created nor adopted. Pons' own contracts are outside this audit.
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

    /// @dev A {prepareAdoption} waiting for its account to become the launch's creator fee recipient.
    struct PendingAdoption {
        address account;
        bytes32 modelId;
        bytes32 personaHash;
        string metadataURI;
    }

    uint16 private _mindFeeBps;
    mapping(address token => PonsMind) private _ponsMinds;
    /// @dev Current mind account -> token (cleared when a takeover replaces the account).
    mapping(address account => address token) private _tokenOf;
    mapping(address token => bytes32 poolId) private _poolIds;
    mapping(address token => mapping(address preparer => PendingAdoption)) private _pendingAdoptions;
    mapping(address token => bool) private _left;
    /// @dev Every account this registry ever deployed (launch and adoption accounts, active or not).
    mapping(address account => bool) private _isAccount;

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
        uint256 surplus = _surplus(launchFee + quoteIn + _creationFee);

        account = _deployAccount(keccak256(abi.encode(msg.sender, p.salt)));
        (token, curve) = _launch(p, account, launchFee);
        _registerLaunch(p, token, curve, account, modelId, personaHash, metadataURI);
        if (quoteIn > 0) surplus += _initialBuy(curve, quoteIn, minTokensOut);
        if (surplus > 0) _sendEth(msg.sender, surplus);
    }

    /// @inheritdoc IPonsMindRegistry
    function prepareAdoption(address token, bytes32 modelId, bytes32 personaHash, string calldata metadataURI)
        external
        whenNotPaused
        nonReentrant
        returns (address account)
    {
        _checkConfig(modelId, metadataURI);
        IPonsV2LaunchFactory.LaunchedToken memory launch = factory.getLaunchedToken(token);
        if (!launch.exists || launch.pairToken != address(0)) revert NotPonsLaunch();
        if (launch.buybackEnabled) revert BuybackEnabledLaunch();

        PendingAdoption storage pending = _pendingAdoptions[token][msg.sender];
        account = pending.account;
        if (account == address(0)) {
            account = _adoptionAccount(token, msg.sender);
            pending.account = account;
        }
        pending.modelId = modelId;
        pending.personaHash = personaHash;
        pending.metadataURI = metadataURI;
        emit AdoptionPrepared(token, account, msg.sender);
    }

    /// @inheritdoc IPonsMindRegistry
    /// @dev Does not re-check `buybackEnabled`: once the hand-off happened, refusing activation would strand the fee
    ///      stream in an account no mind refers to.
    function activateAdoption(address token, address preparer) external nonReentrant {
        PendingAdoption storage pending = _pendingAdoptions[token][preparer];
        address account = pending.account;
        IPonsV2LaunchFactory.LaunchedToken memory launch = factory.getLaunchedToken(token);
        if (account == address(0) || launch.creatorFeeRecipient != account) revert AdoptionNotReady();

        MindInfo memory info = MindInfo({
            creator: preparer,
            modelId: pending.modelId,
            personaHash: pending.personaHash,
            metadataURI: pending.metadataURI,
            createdAt: uint64(block.timestamp),
            status: MindStatus.Alive
        });
        delete _pendingAdoptions[token][preparer];

        if (_mindInfo[token].creator == address(0)) {
            _registerAdoption(token, launch.curve, account, info);
        } else {
            _takeOver(token, account, info);
        }
    }

    /// @inheritdoc IPonsMindRegistry
    function leave(address token, address newRecipient) external nonReentrant onlyCreator(token) {
        if (newRecipient == address(0) || newRecipient == address(this) || _isAccount[newRecipient]) {
            revert InvalidRecipient();
        }
        address account = _ponsMinds[token].account;
        _harvest(token, account);
        MindAccount(payable(account)).transferFeeRecipient(factory, token, newRecipient);

        _left[token] = true;
        MindInfo storage info = _mindInfo[token];
        if (info.status != MindStatus.Dormant) {
            info.status = MindStatus.Dormant;
            emit MindStatusChanged(token, MindStatus.Dormant);
        }
        emit MindLeft(token, newRecipient);
    }

    /// @inheritdoc IPonsMindRegistry
    function recoverAccountTokens(address token, address erc20) external nonReentrant onlyCreator(token) {
        MindAccount(payable(_ponsMinds[token].account)).sweepTokens(erc20, msg.sender);
    }

    // ---------------------------------------------------------------------------------------------
    // Permissionless
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IPonsMindRegistry
    /// @dev Sweep attempts (each in try/catch, failures only reflected in {SweepAttempted}): while the curve trades,
    ///      first through the account (Pons' curve authorizes its current creator fee recipient), then, for minds
    ///      launched here, directly (in case the curve authorizes the launch deployer); once the pool is created,
    ///      through the account as the pool's creator, on {poolIdOf} if the operator set it, else on {derivedPoolId}.
    ///      The claim then runs in a return window opened for the account only, and the counted wei must equal what
    ///      the account reports.
    function harvest(address token) external nonReentrant onlyMind(token) {
        _harvest(token, _ponsMinds[token].account);
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
    function derivedPoolId(address token) external view returns (bytes32) {
        IPonsV2LaunchFactory.LaunchedToken memory launch = factory.getLaunchedToken(token);
        if (!launch.exists || launch.pairToken != address(0)) return bytes32(0);
        return _poolId(token, launch);
    }

    /// @inheritdoc IPonsMindRegistry
    function hasLeft(address token) external view returns (bool) {
        return _left[token];
    }

    /// @inheritdoc IPonsMindRegistry
    function pendingAdoption(address token, address preparer)
        external
        view
        returns (address account, bytes32 modelId, bytes32 personaHash, string memory metadataURI)
    {
        PendingAdoption storage pending = _pendingAdoptions[token][preparer];
        return (pending.account, pending.modelId, pending.personaHash, pending.metadataURI);
    }

    /// @inheritdoc IPonsMindRegistry
    function predictAccount(address creator, bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(accountImplementation, keccak256(abi.encode(creator, salt)));
    }

    /// @inheritdoc IPonsMindRegistry
    function predictAdoptionAccount(address token, address preparer) external view returns (address) {
        return Clones.predictDeterministicAddress(accountImplementation, keccak256(abi.encode(token, preparer)));
    }

    /// @inheritdoc IPonsMindRegistry
    function claimable(address token) external view returns (uint256) {
        address account = _ponsMinds[token].account;
        return account == address(0) ? 0 : feeEscrow.balanceOf(account) + account.balance;
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
    // Internals: MindCore hook
    // ---------------------------------------------------------------------------------------------

    /// @dev A mind whose creator left cannot be Alive until a takeover clears the flag (SPEC §9.7).
    function _canBeAlive(address token) internal view override returns (bool) {
        return !_left[token];
    }

    // ---------------------------------------------------------------------------------------------
    // Internals: launch
    // ---------------------------------------------------------------------------------------------

    /// @dev Reverts {WrongValue} unless `msg.value >= required`; returns the excess to refund.
    function _surplus(uint256 required) private view returns (uint256) {
        if (msg.value < required) revert WrongValue();
        return msg.value - required;
    }

    /// @dev Clones the account implementation at `salt` (reverting {AccountExists} if that address is taken) and
    ///      binds it to this registry.
    function _deployAccount(bytes32 salt) private returns (address account) {
        address implementation = accountImplementation;
        if (Clones.predictDeterministicAddress(implementation, salt).code.length != 0) revert AccountExists();
        account = Clones.cloneDeterministic(implementation, salt);
        MindAccount(payable(account)).initialize(address(this));
        _isAccount[account] = true;
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
    ///      opened for the curve only). Returns the refund, which {launchMind} forwards to the caller.
    function _initialBuy(address curve, uint256 quoteIn, uint256 minTokensOut) private returns (uint256 refund) {
        _openReturn(curve);
        IPonsV2BondingCurve(curve).buy{value: quoteIn}(quoteIn, minTokensOut, msg.sender);
        refund = _takeReturned();
    }

    // ---------------------------------------------------------------------------------------------
    // Internals: adoption
    // ---------------------------------------------------------------------------------------------

    /// @dev The account of (`token`, `preparer`): deployed on first use, reused afterwards (a preparer may prepare
    ///      again after its earlier adoption of the token was left or taken over).
    function _adoptionAccount(address token, address preparer) private returns (address account) {
        bytes32 salt = keccak256(abi.encode(token, preparer));
        account = Clones.predictDeterministicAddress(accountImplementation, salt);
        if (!_isAccount[account]) account = _deployAccount(salt);
    }

    /// @dev First activation: registers the mind (status Alive) and emits {MindCreated} (name/symbol read from the
    ///      ERC-20) followed by {MindAdopted}.
    function _registerAdoption(address token, address curve, address account, MindInfo memory info) private {
        _tokenOf[account] = token;
        _ponsMinds[token] =
            PonsMind({curve: curve, account: account, launchConfigId: 0, launchedHere: false, adopted: true});
        _addMind(token, info);
        emit MindCreated(
            token,
            info.creator,
            _tokenString(token, IERC20Metadata.name.selector),
            _tokenString(token, IERC20Metadata.symbol.selector),
            info.metadataURI,
            info.modelId,
            info.personaHash
        );
        emit MindAdopted(token, account, info.creator);
    }

    /// @dev Activation for an existing mind: allowed only when its current account is no longer the creator fee
    ///      recipient (the recipient is `account`), or when it is the same account again after the creator left.
    ///      Whatever the previous account can still claim (fees credited while it was the recipient but not harvested
    ///      yet, e.g. when Pons moved the recipient) is claimed into the vault first, since the account is no longer
    ///      reachable afterwards. Replaces creator, config and account (keeps `createdAt`, `curve`, `launchedHere`,
    ///      `launchConfigId`, the vault and the pool id override), clears the left flag and sets the status to Alive.
    function _takeOver(address token, address account, MindInfo memory info) private {
        PonsMind storage m = _ponsMinds[token];
        address previous = m.account;
        if (previous == account && !_left[token]) revert AlreadyAdopted();
        if (previous != account) {
            if (feeEscrow.balanceOf(previous) + previous.balance != 0) _claim(token, previous);
            delete _tokenOf[previous];
            _tokenOf[account] = token;
            m.account = account;
        }
        m.adopted = true;
        delete _left[token];

        MindInfo storage stored = _mindInfo[token];
        stored.creator = info.creator;
        stored.modelId = info.modelId;
        stored.personaHash = info.personaHash;
        stored.metadataURI = info.metadataURI;
        emit MindConfigUpdated(token, info.modelId, info.personaHash, info.metadataURI);
        if (stored.status != MindStatus.Alive) {
            stored.status = MindStatus.Alive;
            emit MindStatusChanged(token, MindStatus.Alive);
        }
        emit MindAdopted(token, account, info.creator);
    }

    /// @dev `name()` / `symbol()` of `token` (empty if the call fails; a Pons launch token always implements both).
    function _tokenString(address token, bytes4 selector) private view returns (string memory value) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(selector));
        if (ok && data.length >= 64) value = abi.decode(data, (string));
    }

    // ---------------------------------------------------------------------------------------------
    // Internals: harvest
    // ---------------------------------------------------------------------------------------------

    /// @dev Body of {harvest} (also run by {leave} before the hand-off): best-effort sweeps, then {_claim}.
    function _harvest(address token, address account) private {
        PonsMind storage m = _ponsMinds[token];
        (bool curveSwept, bool poolSwept) = _trySweep(token, m.curve, account, m.launchedHere);
        emit SweepAttempted(token, curveSwept, poolSwept);
        _claim(token, account);
    }

    /// @dev Claims through `account` in a return window opened for it only (the counted wei must equal what the
    ///      account reports), then splits the proceeds between the protocol (`mindFeeBps`) and the vault of `token`.
    function _claim(address token, address account) private {
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

    /// @dev Best-effort fee sweeps into the escrow (see {harvest}); never reverts on a failed sweep.
    function _trySweep(address token, address curve, address account, bool launchedHere)
        private
        returns (bool curveSwept, bool poolSwept)
    {
        IPonsV2LaunchFactory.LaunchedToken memory launch = factory.getLaunchedToken(token);
        if (launch.phase == IPonsV2LaunchFactory.GraduationPhase.NotGraduated) {
            try MindAccount(payable(account)).sweepCurve(IPonsV2BondingCurve(curve), 0) {
                curveSwept = true;
            } catch {}
            if (!curveSwept && launchedHere) {
                try IPonsV2BondingCurve(curve).sweepFees(0) {
                    curveSwept = true;
                } catch {}
            }
        } else if (launch.phase == IPonsV2LaunchFactory.GraduationPhase.PoolCreated) {
            bytes32 poolId = _poolIds[token];
            if (poolId == bytes32(0)) poolId = _poolId(token, launch);
            try MindAccount(payable(account)).sweepPool(memeHook, poolId, 0, 0) {
                poolSwept = true;
            } catch {}
        }
    }

    /// @dev Uniswap v4 `PoolId` (`keccak256(abi.encode(PoolKey))`) of the native-quote pool Pons creates for `token`.
    function _poolId(address token, IPonsV2LaunchFactory.LaunchedToken memory launch) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                IPonsV2MemeHook.PoolKey({
                    currency0: address(0),
                    currency1: token,
                    fee: launch.poolFee,
                    tickSpacing: launch.tickSpacing,
                    hooks: address(memeHook)
                })
            )
        );
    }
}
