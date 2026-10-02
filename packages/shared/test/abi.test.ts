import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toEventSelector, toFunctionSelector, type Abi, type AbiEvent, type AbiFunction } from 'viem';
import { BURN_ADDRESS, CurvePhase, MindStatus, graduatorAbi, mindLaunchpadAbi, mindTokenAbi } from '../src/abi.js';

type AbiError = Extract<Abi[number], { type: 'error' }>;

const here = dirname(fileURLToPath(import.meta.url));

/** Custom errors declared by `IMindLaunchpad` (SPEC §2.3). */
const LAUNCHPAD_CUSTOM_ERRORS = [
  'NotAMind', 'WrongPhase', 'Slippage', 'Expired', 'ZeroAmount', 'ExceedsTokensSold', 'NotCreator', 'NotOperator',
  'InvalidStatus', 'InvalidName', 'InvalidSymbol', 'MetadataTooLong', 'InvalidModel', 'InsufficientCreationFee',
  'InsufficientMindBalance', 'DrawLimitExceeded', 'InvalidDrawLimit', 'FeeTooHigh', 'ZeroAddress', 'EthTransferFailed',
  'GraduatorNotSet', 'EthReturnMismatch', 'DirectEthNotAccepted',
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
      'isGraduator', 'TOTAL_SUPPLY', 'CURVE_SUPPLY', 'LP_SUPPLY', 'VIRTUAL_ETH', 'VIRTUAL_TOKENS',
      'owner', 'pendingOwner', 'transferOwnership', 'acceptOwnership', 'renounceOwnership', 'paused',
    ]) {
      expect(fns.has(name), `function ${name}`).toBe(true);
    }
    expect(fns.size).toBe(52);
    const events = names(mindLaunchpadAbi, 'event');
    for (const name of [
      'MindCreated', 'Trade', 'CurveCompleted', 'Graduated', 'FeeAccrued', 'MindFunded', 'Harvested', 'ComputeDrawn',
      'MemoryAnchored', 'MindConfigUpdated', 'MindStatusChanged', 'ProtocolFeesWithdrawn', 'OperatorUpdated',
      'TreasuryUpdated', 'ComputeTreasuryUpdated', 'GraduatorUpdated', 'FeeParamsUpdated', 'CreationFeeUpdated',
      'DrawLimitUpdated', 'OwnershipTransferStarted', 'OwnershipTransferred', 'Paused', 'Unpaused',
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
    for (const removed of ['creditMind', 'retireMind', 'withdrawRetiredMind', 'graduateFor', 'RetiredMindWithdrawn', 'PoolPriceSkewed', 'Retired', 'NotGraduator']) {
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
      new Set(['NotLaunchpad', 'AlreadyGraduated', 'NoPosition', 'UnexpectedEthSender', 'UnsupportedFeeTier', 'ZeroAddress', 'EthTransferFailed']),
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
});

for (const [name, abi] of [['MindLaunchpad', launchpadArtifact], ['MindToken', tokenArtifact]] as const) {
  if (abi === undefined) {
    // eslint-disable-next-line no-console
    console.info(`[abi.test] packages/shared/abi/${name}.json not found — equivalence skipped (run \`forge build && pnpm abi:sync\`).`);
  }
}
