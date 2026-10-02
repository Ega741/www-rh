import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toEventSelector, toFunctionSelector, type Abi, type AbiEvent, type AbiFunction } from 'viem';
import {
  BURN_ADDRESS,
  CurvePhase,
  MindStatus,
  PonsGraduationPhase,
  graduatorAbi,
  mindAccountAbi,
  mindLaunchpadAbi,
  mindTokenAbi,
  ponsCurveAbi,
  ponsFactoryAbi,
  ponsFeeEscrowAbi,
  ponsMemeHookAbi,
  ponsMindRegistryAbi,
} from '../src/abi.js';

type AbiError = Extract<Abi[number], { type: 'error' }>;

const here = dirname(fileURLToPath(import.meta.url));

/** Custom errors declared by `IMindLaunchpad` (SPEC §2.3). */
const LAUNCHPAD_CUSTOM_ERRORS = [
  'NotAMind', 'WrongPhase', 'Slippage', 'Expired', 'ZeroAmount', 'ExceedsTokensSold', 'NotCreator', 'NotOperator',
  'InvalidStatus', 'InvalidName', 'InvalidSymbol', 'MetadataTooLong', 'InvalidModel', 'InsufficientCreationFee',
  'InsufficientMindBalance', 'DrawLimitExceeded', 'InvalidDrawLimit', 'FeeTooHigh', 'ZeroAddress', 'EthTransferFailed',
  'GraduatorNotSet', 'EthReturnMismatch', 'DirectEthNotAccepted', 'InvalidGraduationGrace', 'InvalidGraduator',
  'RenounceDisabled', 'PoolPriceSkewed',
];

/** ABI copied by `pnpm abi:sync` into `packages/shared/abi/<Name>.json` (SPEC §3.3). */
function loadSyncedAbi(contract: string): Abi | undefined {
  const path = resolve(here, `../abi/${contract}.json`);
  if (!existsSync(path)) return undefined;
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const abi = Array.isArray(raw) ? raw : (raw as { abi?: unknown }).abi;
  return Array.isArray(abi) ? (abi as Abi) : undefined;
}

interface Selectors {
  functions: Map<string, string>; // selector -> signature
  events: Map<string, string>; // topic0 -> signature
  errors: Map<string, string>; // selector -> signature
}

type Param = { type: string; components?: readonly Param[] };

function describeInputs(inputs: readonly Param[]): string {
  return inputs.map((i) => (i.type.startsWith('tuple') && i.components ? `(${describeInputs(i.components)})${i.type.slice(5)}` : i.type)).join(',');
}

function selectorsOf(abi: Abi): Selectors {
  const out: Selectors = { functions: new Map(), events: new Map(), errors: new Map() };
  for (const item of abi) {
    if (item.type === 'function') {
      const f = item as AbiFunction;
      out.functions.set(toFunctionSelector(f), `${f.name}(${describeInputs(f.inputs)})`);
    } else if (item.type === 'event') {
      const e = item as AbiEvent;
      out.events.set(toEventSelector(e), `${e.name}(${describeInputs(e.inputs)})`);
    } else if (item.type === 'error') {
      const e = item as AbiError;
      out.errors.set(toFunctionSelector({ ...e, type: 'function', stateMutability: 'pure', outputs: [] }), `${e.name}(${describeInputs(e.inputs)})`);
    }
  }
  return out;
}

function missing(expected: Map<string, string>, actual: Map<string, string>): string[] {
  return [...expected].filter(([sel]) => !actual.has(sel)).map(([sel, sig]) => `${sig} [${sel}]`);
}

const names = (abi: Abi, type: 'function' | 'event' | 'error'): Set<string> =>
  new Set(abi.filter((i) => i.type === type).map((i) => (i as { name: string }).name));

describe('human-readable ABI (SPEC §2.3, §3.3)', () => {
  it('declares every IMindLaunchpad function, event and custom error plus the inherited surface', () => {
    const fns = names(mindLaunchpadAbi, 'function');
    for (const name of [
      'createMind', 'buy', 'sell', 'graduate', 'harvest', 'fundMind', 'setMindConfig', 'setCreatorPaused',
      'drawCompute', 'anchorMemory', 'setMindStatus', 'setOperator', 'setTreasury', 'setComputeTreasury', 'setGraduator',
      'setFeeParams', 'setCreationFee', 'setDrawLimit', 'pause', 'unpause', 'withdrawProtocolFees', 'quoteBuy', 'quoteSell',
      'currentPrice', 'getMind', 'getCurve', 'mindBalance', 'protocolBalance', 'mindsLength', 'mindAt', 'isMind', 'feeParams',
      'creationFee', 'drawLimit', 'drawnInEpoch', 'operator', 'treasury', 'computeTreasury', 'graduator', 'graduatorOf',
      'completedAt', 'graduationGrace', 'setGraduationGrace', 'TOTAL_SUPPLY', 'CURVE_SUPPLY', 'LP_SUPPLY', 'VIRTUAL_ETH', 'VIRTUAL_TOKENS',
      'owner', 'pendingOwner', 'transferOwnership', 'acceptOwnership', 'renounceOwnership', 'paused',
    ]) {
      expect(fns.has(name), `function ${name}`).toBe(true);
    }
    expect(fns.size).toBe(54);
    const events = names(mindLaunchpadAbi, 'event');
    for (const name of [
      'MindCreated', 'Trade', 'CurveCompleted', 'Graduated', 'FeeAccrued', 'MindFunded', 'Harvested', 'ComputeDrawn',
      'MemoryAnchored', 'MindConfigUpdated', 'MindStatusChanged', 'ProtocolFeesWithdrawn', 'OperatorUpdated',
      'TreasuryUpdated', 'ComputeTreasuryUpdated', 'GraduatorUpdated', 'FeeParamsUpdated', 'CreationFeeUpdated',
      'DrawLimitUpdated', 'CurveReopened', 'GraduationGraceUpdated', 'OwnershipTransferStarted', 'OwnershipTransferred', 'Paused', 'Unpaused',
    ]) {
      expect(events.has(name), `event ${name}`).toBe(true);
    }
    const errors = names(mindLaunchpadAbi, 'error');
    for (const name of [
      ...LAUNCHPAD_CUSTOM_ERRORS, 'OwnableUnauthorizedAccount', 'OwnableInvalidOwner', 'EnforcedPause', 'ExpectedPause',
      'ReentrancyGuardReentrantCall', 'SafeERC20FailedOperation', 'SafeCastOverflowedUintDowncast',
    ]) {
      expect(errors.has(name), `error ${name}`).toBe(true);
    }
    for (const removed of ['creditMind', 'retireMind', 'withdrawRetiredMind', 'graduateFor', 'RetiredMindWithdrawn', 'Retired', 'NotGraduator', 'isGraduator']) {
      expect(fns.has(removed) || events.has(removed) || errors.has(removed), removed).toBe(false);
    }
    expect(mindLaunchpadAbi.some((i) => i.type === 'receive')).toBe(true);
    const ctor = mindLaunchpadAbi.find((i) => i.type === 'constructor') as { inputs: readonly { name: string }[] } | undefined;
    expect(ctor?.inputs.map((i) => i.name)).toEqual(['initialOwner', 'treasury', 'computeTreasury', 'operator']);
  });

  it('event parameter names match §2.3 (viem decodes by name)', () => {
    const event = (name: string): AbiEvent => mindLaunchpadAbi.find((i) => i.type === 'event' && i.name === name) as AbiEvent;
    expect(event('OperatorUpdated').inputs.map((i) => i.name)).toEqual(['newOperator']);
    expect(event('TreasuryUpdated').inputs.map((i) => i.name)).toEqual(['newTreasury']);
    expect(event('ComputeTreasuryUpdated').inputs.map((i) => i.name)).toEqual(['newComputeTreasury']);
    expect(event('GraduatorUpdated').inputs.map((i) => i.name)).toEqual(['newGraduator']);
    expect(event('CreationFeeUpdated').inputs.map((i) => i.name)).toEqual(['newCreationFee']);
    expect(event('ComputeDrawn').inputs.map((i) => `${i.name}${i.indexed === true ? '*' : ''}`)).toEqual(['token*', 'amount', 'receiptHash']);
    expect(event('MemoryAnchored').inputs.map((i) => `${i.name}${i.indexed === true ? '*' : ''}`)).toEqual(['token*', 'seq*', 'contentHash', 'uri']);
    expect(event('CurveReopened').inputs.map((i) => `${i.name}${i.indexed === true ? '*' : ''}`)).toEqual(['token*']);
    expect(event('GraduationGraceUpdated').inputs.map((i) => i.name)).toEqual(['graceSeconds']);
  });

  it('well-known selectors / topics are stable', () => {
    const s = selectorsOf(mindLaunchpadAbi);
    expect(s.functions.get(toFunctionSelector('buy(address,uint256,uint256)'))).toBe('buy(address,uint256,uint256)');
    expect(s.functions.get(toFunctionSelector('sell(address,uint256,uint256,uint256)'))).toBe('sell(address,uint256,uint256,uint256)');
    expect(s.functions.get(toFunctionSelector('setFeeParams((uint16,uint16,uint16))'))).toBe('setFeeParams((uint16,uint16,uint16))');
    expect(s.functions.get(toFunctionSelector('drawCompute(address,uint256,bytes32)'))).toBe('drawCompute(address,uint256,bytes32)');
    expect(s.functions.get(toFunctionSelector('setCreatorPaused(address,bool)'))).toBe('setCreatorPaused(address,bool)');
    expect(s.events.has(toEventSelector('Trade(address,address,bool,uint256,uint256,uint256,uint256,uint256)'))).toBe(true);
    expect(s.events.has(toEventSelector('MindStatusChanged(address,uint8)'))).toBe(true);
    expect(s.events.has(toEventSelector('ComputeDrawn(address,uint256,bytes32)'))).toBe(true);
    expect(s.errors.get(toFunctionSelector('EthReturnMismatch()'))).toBe('EthReturnMismatch()');
    const token = selectorsOf(mindTokenAbi);
    expect(token.functions.has('0xa9059cbb')).toBe(true); // transfer(address,uint256)
    expect(token.functions.has('0xd505accf')).toBe(true); // permit(...)
    expect(token.events.has('0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef')).toBe(true); // Transfer
    const grad = selectorsOf(graduatorAbi);
    expect(grad.functions.get(toFunctionSelector('graduate(address,uint256)'))).toBe('graduate(address,uint256)');
    expect(grad.functions.get(toFunctionSelector('harvest(address)'))).toBe('harvest(address)');
    expect(grad.functions.get(toFunctionSelector('launchpad()'))).toBe('launchpad()');
    expect(grad.events.has(toEventSelector('GraduatedAtSkewedPrice(address,uint160,uint160)'))).toBe(true);
    const graduate = graduatorAbi.find((i) => i.type === 'function' && i.name === 'graduate') as AbiFunction;
    expect(graduate.stateMutability).toBe('payable');
    expect(graduate.outputs.map((o) => o.name)).toEqual(['pool', 'positionId', 'ethReturned']);
    const skew = graduatorAbi.find((i) => i.type === 'event') as AbiEvent;
    expect(skew.inputs[0]).toMatchObject({ name: 'token', indexed: true });
    expect(names(graduatorAbi, 'error')).toEqual(
      new Set([
        'NotLaunchpad', 'AlreadyGraduated', 'NoPosition', 'UnexpectedEthSender', 'UnsupportedFeeTier', 'ZeroAddress', 'EthTransferFailed',
        'PoolPriceSkewed', 'UnauthorizedCallback', 'InvalidPriceTolerance',
      ]),
    );
  });

  it('enum helpers match the Solidity declaration order', () => {
    expect(CurvePhase).toEqual({ Bonding: 0, Complete: 1, Graduated: 2 });
    expect(MindStatus).toEqual({ Alive: 0, Dormant: 1, Paused: 2 });
    expect(BURN_ADDRESS).toBe('0x000000000000000000000000000000000000dEaD');
  });

  it('struct returns are tuples with the §2.3 field order', () => {
    const getMind = mindLaunchpadAbi.find((i) => i.type === 'function' && i.name === 'getMind') as AbiFunction;
    const out = getMind.outputs[0] as { type: string; components?: { name: string }[] };
    expect(out.type).toBe('tuple');
    expect(out.components?.map((c) => c.name)).toEqual(['creator', 'modelId', 'personaHash', 'metadataURI', 'createdAt', 'status']);
    const getCurve = mindLaunchpadAbi.find((i) => i.type === 'function' && i.name === 'getCurve') as AbiFunction;
    const curve = getCurve.outputs[0] as { type: string; components?: { name: string }[] };
    expect(curve.components?.map((c) => c.name)).toEqual(['realEthReserve', 'tokensSold', 'phase', 'pool', 'positionId']);
  });
});

const launchpadArtifact = loadSyncedAbi('MindLaunchpad');
const tokenArtifact = loadSyncedAbi('MindToken');
const graduatorArtifact = loadSyncedAbi('IGraduator');

describe.skipIf(launchpadArtifact === undefined)('MindLaunchpad ABI equivalence with abi/MindLaunchpad.json', () => {
  const ours = selectorsOf(mindLaunchpadAbi);
  const theirs = selectorsOf(launchpadArtifact ?? []);

  it('function selectors are set-equal in both directions', () => {
    expect(missing(ours.functions, theirs.functions)).toEqual([]);
    expect(missing(theirs.functions, ours.functions)).toEqual([]);
  });
  it('event topics are set-equal in both directions', () => {
    expect(missing(ours.events, theirs.events)).toEqual([]);
    expect(missing(theirs.events, ours.events)).toEqual([]);
  });
  it('every compiled error is in mindLaunchpadAbi and every IMindLaunchpad custom error is in both', () => {
    expect(missing(theirs.errors, ours.errors)).toEqual([]);
    const compiled = new Set([...theirs.errors.values()].map((s) => s.slice(0, s.indexOf('('))));
    for (const name of LAUNCHPAD_CUSTOM_ERRORS) expect(compiled.has(name), name).toBe(true);
  });
});

describe.skipIf(tokenArtifact === undefined)('MindToken ABI equivalence with abi/MindToken.json', () => {
  it('functions and events are set-equal; compiled errors are covered', () => {
    const ours = selectorsOf(mindTokenAbi);
    const theirs = selectorsOf(tokenArtifact ?? []);
    expect(missing(ours.functions, theirs.functions)).toEqual([]);
    expect(missing(theirs.functions, ours.functions)).toEqual([]);
    expect(missing(ours.events, theirs.events)).toEqual([]);
    expect(missing(theirs.events, ours.events)).toEqual([]);
    expect(missing(theirs.errors, ours.errors)).toEqual([]);
  });
});

describe.skipIf(graduatorArtifact === undefined)('IGraduator ABI equivalence with abi/IGraduator.json', () => {
  it('functions are set-equal', () => {
    const ours = selectorsOf(graduatorAbi);
    const theirs = selectorsOf(graduatorArtifact ?? []);
    expect(missing(ours.functions, theirs.functions)).toEqual([]);
    expect(missing(theirs.functions, ours.functions)).toEqual([]);
  });
  it('every extra event / error comes from a compiled graduator implementation', () => {
    const impl = new Map<string, string>();
    for (const name of ['UniswapV3Graduator', 'MockGraduator']) {
      const s = selectorsOf(loadSyncedAbi(name) ?? []);
      for (const [k, v] of [...s.events, ...s.errors]) impl.set(k, v);
    }
    const ours = selectorsOf(graduatorAbi);
    const theirs = selectorsOf(graduatorArtifact ?? []);
    for (const [k, v] of [...ours.events, ...ours.errors]) expect(theirs.events.has(k) || theirs.errors.has(k) || impl.has(k), v).toBe(true);
  });
});

// ===================================================================================== Pons mode (§9)

const sorted = (abi: Abi, type: 'function' | 'event' | 'error'): string[] => [...names(abi, type)].sort();

describe('Pons V2 ABIs carry exactly the §9.1 members (verified mainnet signatures)', () => {
  it('factory / curve / escrow / hook member sets', () => {
    expect(sorted(ponsFactoryAbi, 'function')).toEqual(
      [
        'canLaunch', 'createGraduatedPool', 'getLaunchConfig', 'getLaunchedToken', 'launchConfigCount', 'launchEnabled', 'launchFee', 'launchToken',
        'maxCreatorTaxBps', 'previewLaunchEconomics', 'snipeTaxSeconds', 'transferCreatorFeeRecipient', 'whitelistedLaunchers',
      ].sort(),
    );
    expect(sorted(ponsFactoryAbi, 'event')).toEqual(['CreatorFeeRecipientUpdated', 'LaunchSwept', 'PoolGraduated', 'TokenLaunched']);
    expect(sorted(ponsCurveAbi, 'function')).toEqual(
      ['buy', 'creatorTaxBps', 'feeBps', 'getReserves', 'graduated', 'graduationThreshold', 'readyToGraduate', 'realQuoteReserve', 'sell', 'sellableTokens', 'sweepFees'].sort(),
    );
    expect(sorted(ponsCurveAbi, 'event')).toEqual(['CurveBuy', 'CurveBuyRefunded', 'CurveCompleted', 'CurveSell', 'FeesSwept']);
    expect(sorted(ponsFeeEscrowAbi, 'function')).toEqual(['balanceOf', 'claim', 'credit']);
    expect(sorted(ponsFeeEscrowAbi, 'event')).toEqual(['Claimed', 'Credited']);
    expect(sorted(ponsMemeHookAbi, 'function')).toEqual(['sweepPoolFees']);
    expect(sorted(ponsMemeHookAbi, 'event')).toEqual(['PoolFeesSwept', 'PoolRegistered']);
    for (const abi of [ponsFactoryAbi, ponsCurveAbi, ponsFeeEscrowAbi, ponsMemeHookAbi]) expect(names(abi, 'error').size).toBe(0);
  });

  it('selectors and topics equal the verified mainnet contracts', () => {
    const f = selectorsOf(ponsFactoryAbi);
    expect(f.functions.get('0xa72101af')).toBe('launchToken((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address,address[])');
    expect(f.functions.has(toFunctionSelector('createGraduatedPool(address)'))).toBe(true);
    expect(f.functions.has(toFunctionSelector('transferCreatorFeeRecipient(address,address)'))).toBe(true);
    // topic0s observed on chain (V2 factory logs)
    expect(f.events.has('0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607')).toBe(true); // TokenLaunched
    expect(f.events.has('0xcdb72f157fd3666758a6ce201387ffb52038c7562e4fff352828da1096c4b6b4')).toBe(true); // LaunchSwept
    expect(f.events.has('0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259')).toBe(true); // PoolGraduated
    const c = selectorsOf(ponsCurveAbi);
    expect(c.functions.get('0x59a87bc1')).toBe('buy(uint256,uint256,address)');
    expect(c.functions.get('0xd04c6983')).toBe('sell(uint256,uint256,address)');
    expect(c.functions.get('0x0902f1ac')).toBe('getReserves()');
    expect(c.events.get(toEventSelector('CurveBuy(address,address,uint256,uint256,uint256,uint256)'))).toBeDefined();
    expect(c.events.get(toEventSelector('CurveCompleted(address,uint256,uint256)'))).toBeDefined();
    const e = selectorsOf(ponsFeeEscrowAbi);
    expect(e.functions.get('0x4e71d92d')).toBe('claim()');
    expect(e.events.has(toEventSelector('Credited(address,address,uint256)'))).toBe(true);
    const h = selectorsOf(ponsMemeHookAbi);
    expect(h.functions.get('0x3d61055e')).toBe('sweepPoolFees(bytes32,uint256,uint256)');
    expect(h.events.has(toEventSelector('PoolRegistered(bytes32,address,address,address)'))).toBe(true);
    expect(h.events.has(toEventSelector('PoolFeesSwept(bytes32,uint256,uint256,uint256,uint256)'))).toBe(true);
  });

  it('decoded names: indexed event params and struct outputs', () => {
    const ev = (abi: Abi, name: string): string[] =>
      (abi.find((i) => i.type === 'event' && i.name === name) as AbiEvent).inputs.map((i) => `${i.name}${i.indexed === true ? '*' : ''}`);
    expect(ev(ponsCurveAbi, 'CurveBuy')).toEqual(['buyer*', 'recipient*', 'quoteIn', 'tokensOut', 'fee', 'tax']);
    expect(ev(ponsCurveAbi, 'CurveSell')).toEqual(['seller*', 'recipient*', 'tokensIn', 'quoteOut', 'fee', 'tax']);
    expect(ev(ponsFactoryAbi, 'LaunchSwept')).toEqual(['token*', 'quoteOut', 'tokenOut']);
    expect(ev(ponsFeeEscrowAbi, 'Claimed')).toEqual(['recipient*', 'amount']);
    expect(ev(ponsMemeHookAbi, 'PoolRegistered')).toEqual(['poolId*', 'memecoin', 'quoteToken', 'creator']);
    const launched = (ponsFactoryAbi.find((i) => i.type === 'function' && i.name === 'getLaunchedToken') as AbiFunction).outputs[0] as { components: readonly { name: string }[] };
    expect(launched.components.map((c) => c.name)).toEqual([
      'token', 'curve', 'deployer', 'creatorFeeRecipient', 'pairToken', 'graduationThreshold', 'poolFee', 'tickSpacing', 'creatorTaxBps', 'buybackEnabled', 'phase',
      'sweptQuote', 'sweptTokens', 'sweptAt', 'exists',
    ]);
    expect(PonsGraduationPhase).toEqual({ NotGraduated: 0, Swept: 1, PoolCreated: 2, Rescued: 3 });
  });
});

/** MindLaunchpad-only members (§9.2: they do not exist on the registry). */
const CURVE_ONLY = [
  'createMind', 'buy', 'sell', 'graduate', 'quoteBuy', 'quoteSell', 'currentPrice', 'getCurve', 'completedAt', 'graduationGrace', 'setGraduationGrace',
  'graduator', 'graduatorOf', 'setGraduator', 'feeParams', 'setFeeParams', 'TOTAL_SUPPLY', 'CURVE_SUPPLY', 'LP_SUPPLY', 'VIRTUAL_ETH', 'VIRTUAL_TOKENS',
  'Trade', 'CurveCompleted', 'CurveReopened', 'Graduated', 'GraduatorUpdated', 'FeeParamsUpdated', 'GraduationGraceUpdated',
  'WrongPhase', 'Slippage', 'Expired', 'ExceedsTokensSold', 'GraduatorNotSet', 'InvalidGraduationGrace', 'InvalidGraduator', 'PoolPriceSkewed',
];

describe('PonsMindRegistry / MindAccount ABIs (§9.2)', () => {
  it('registry = MindCore surface + Pons integration, without MindLaunchpad-only members', () => {
    const fns = names(ponsMindRegistryAbi, 'function');
    for (const name of [
      'launchMind', 'prepareAdoption', 'activateAdoption', 'leave', 'harvest', 'createGraduatedPool', 'setPoolId', 'ponsMind', 'accountOf', 'tokenOf',
      'predictAccount', 'predictAdoptionAccount', 'claimable', 'poolIdOf', 'launchQuote', 'factory', 'feeEscrow', 'memeHook', 'accountImplementation', 'mindFeeBps', 'setMindFeeBps',
      'fundMind', 'drawCompute', 'anchorMemory', 'setMindStatus', 'setMindConfig', 'setCreatorPaused', 'getMind', 'mindBalance', 'protocolBalance', 'mindsLength',
      'mindAt', 'isMind', 'creationFee', 'setCreationFee', 'drawLimit', 'setDrawLimit', 'drawnInEpoch', 'operator', 'treasury', 'computeTreasury', 'setOperator',
      'setTreasury', 'setComputeTreasury', 'pause', 'unpause', 'paused', 'withdrawProtocolFees', 'owner', 'pendingOwner', 'transferOwnership', 'acceptOwnership',
      'renounceOwnership',
    ]) {
      expect(fns.has(name), `function ${name}`).toBe(true);
    }
    const events = names(ponsMindRegistryAbi, 'event');
    for (const name of ['MindLaunched', 'AdoptionPrepared', 'MindAdopted', 'MindLeft', 'SweepAttempted', 'PoolIdSet', 'MindFeeUpdated', 'MindCreated', 'FeeAccrued', 'MindFunded', 'Harvested', 'ComputeDrawn', 'MemoryAnchored', 'MindConfigUpdated', 'MindStatusChanged']) {
      expect(events.has(name), `event ${name}`).toBe(true);
    }
    const errors = names(ponsMindRegistryAbi, 'error');
    for (const name of ['AccountExists', 'NotPonsLaunch', 'NotRecipientOrDeployer', 'AdoptionNotReady', 'AlreadyAdopted', 'WrongValue', 'LaunchFailed', 'NotAMind', 'EthReturnMismatch', 'DirectEthNotAccepted']) {
      expect(errors.has(name), `error ${name}`).toBe(true);
    }
    for (const name of CURVE_ONLY) expect(fns.has(name) || events.has(name) || errors.has(name), name).toBe(false);
    const ctor = ponsMindRegistryAbi.find((i) => i.type === 'constructor') as { inputs: readonly { name: string }[] };
    expect(ctor.inputs.map((i) => i.name)).toEqual(['initialOwner', 'treasury', 'computeTreasury', 'operator', 'factory', 'feeEscrow', 'memeHook']);
    const launch = ponsMindRegistryAbi.find((i) => i.type === 'function' && i.name === 'launchMind') as AbiFunction;
    expect(launch.stateMutability).toBe('payable');
    expect(launch.outputs.map((o) => o.name)).toEqual(['token', 'curve', 'account']);
    const pons = (ponsMindRegistryAbi.find((i) => i.type === 'function' && i.name === 'ponsMind') as AbiFunction).outputs[0] as { components: readonly { name: string }[] };
    expect(pons.components.map((c) => c.name)).toEqual(['curve', 'account', 'launchConfigId', 'launchedHere', 'adopted']);
  });

  it('every MindCore member has the same selector / topic as on MindLaunchpad (the runner reuses one code path)', () => {
    const reg = selectorsOf(ponsMindRegistryAbi);
    const lp = selectorsOf(mindLaunchpadAbi);
    for (const sig of ['drawCompute(address,uint256,bytes32)', 'anchorMemory(address,uint64,bytes32,string)', 'setMindStatus(address,uint8)', 'harvest(address)', 'mindBalance(address)', 'getMind(address)', 'operator()']) {
      const s = toFunctionSelector(sig);
      expect(reg.functions.get(s), sig).toBe(lp.functions.get(s));
    }
    for (const [topic, sig] of lp.events) if (names(ponsMindRegistryAbi, 'event').has(sig.slice(0, sig.indexOf('(')))) expect(reg.events.get(topic), sig).toBe(sig);
  });

  it('MindAccount has the §9.2 functions plus sweepCurve', () => {
    expect(sorted(mindAccountAbi, 'function')).toEqual(['claim', 'initialize', 'registry', 'sweepCurve', 'sweepPool', 'transferFeeRecipient']);
    expect(mindAccountAbi.some((i) => i.type === 'receive')).toBe(true);
  });
});

const registryArtifact = loadSyncedAbi('PonsMindRegistry');
const accountArtifact = loadSyncedAbi('MindAccount');

describe.skipIf(registryArtifact === undefined)('PonsMindRegistry ABI equivalence with abi/PonsMindRegistry.json', () => {
  const ours = selectorsOf(ponsMindRegistryAbi);
  const theirs = selectorsOf(registryArtifact ?? []);
  it('functions and events are set-equal; every compiled error is declared', () => {
    expect(missing(ours.functions, theirs.functions)).toEqual([]);
    expect(missing(theirs.functions, ours.functions)).toEqual([]);
    expect(missing(ours.events, theirs.events)).toEqual([]);
    expect(missing(theirs.events, ours.events)).toEqual([]);
    expect(missing(theirs.errors, ours.errors)).toEqual([]);
  });
});

describe.skipIf(accountArtifact === undefined)('MindAccount ABI equivalence with abi/MindAccount.json', () => {
  it('functions and events are set-equal; every compiled error is declared', () => {
    const ours = selectorsOf(mindAccountAbi);
    const theirs = selectorsOf(accountArtifact ?? []);
    expect(missing(ours.functions, theirs.functions)).toEqual([]);
    expect(missing(theirs.functions, ours.functions)).toEqual([]);
    expect(missing(theirs.events, ours.events)).toEqual([]);
    expect(missing(theirs.errors, ours.errors)).toEqual([]);
  });
});

for (const [name, abi] of [['MindLaunchpad', launchpadArtifact], ['MindToken', tokenArtifact], ['PonsMindRegistry', registryArtifact], ['MindAccount', accountArtifact]] as const) {
  if (abi === undefined) {
    // eslint-disable-next-line no-console
    console.info(`[abi.test] packages/shared/abi/${name}.json not found — equivalence skipped (run \`forge build && pnpm abi:sync\`).`);
  }
}
