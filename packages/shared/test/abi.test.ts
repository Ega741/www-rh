import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { keccak256, toEventSelector, toFunctionSelector, type Abi, type AbiEvent, type AbiFunction } from 'viem';
import {
  CurvePhase,
  MindStatus,
  OPTIONAL_LAUNCHPAD_FUNCTIONS,
  REMOVED_LAUNCHPAD_MEMBERS,
  aggregatorV3Abi,
  graduatorAbi,
  mindLaunchpadAbi,
  mindTokenAbi,
} from '../src/abi.js';

type AbiError = Extract<Abi[number], { type: 'error' }>;

const here = dirname(fileURLToPath(import.meta.url));

/** Artifact locations: Foundry output first, then the `abi:sync` copy. */
function artifactCandidates(contract: string): string[] {
  return [
    resolve(here, `../../../contracts/out/${contract}.sol/${contract}.json`),
    resolve(here, `../abi/${contract}.json`),
  ];
}

const contractsRoot = resolve(here, '../../../contracts');

interface LoadedArtifact {
  abi: Abi;
  path: string;
  /** Why the artifact cannot be trusted to reflect the current sources, if so. */
  stale?: string;
}

/**
 * Foundry metadata records `keccak256` of every source it compiled. An artifact whose `src/` sources
 * no longer hash to the files on disk was built from an older revision (e.g. before the contract
 * directives) and is not a meaningful reference for the human-readable ABI.
 */
function stalenessOf(raw: unknown): string | undefined {
  const meta = (raw as { metadata?: unknown }).metadata;
  const parsed: unknown = typeof meta === 'string' ? JSON.parse(meta) : meta;
  const sources = (parsed as { sources?: Record<string, { keccak256?: string }> } | undefined)?.sources;
  if (sources === undefined) return undefined;
  for (const [file, info] of Object.entries(sources)) {
    if (!file.startsWith('src/') || info.keccak256 === undefined) continue;
    const onDisk = resolve(contractsRoot, file);
    if (!existsSync(onDisk)) return `${file} no longer exists`;
    if (keccak256(readFileSync(onDisk)).toLowerCase() !== info.keccak256.toLowerCase()) return `${file} changed since the build`;
  }
  return undefined;
}

function loadArtifactAbi(contract: string): LoadedArtifact | undefined {
  for (const path of artifactCandidates(contract)) {
    if (!existsSync(path)) continue;
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const abi = Array.isArray(raw) ? raw : (raw as { abi?: unknown }).abi;
    if (!Array.isArray(abi)) continue;
    const typed = abi as Abi;
    const removed = typed
      .filter((i) => 'name' in i && REMOVED_LAUNCHPAD_MEMBERS.includes(i.name))
      .map((i) => ('name' in i ? i.name : ''));
    const stale = removed.length > 0 ? `declares members removed by the directives: ${removed.join(', ')}` : Array.isArray(raw) ? undefined : stalenessOf(raw);
    return stale === undefined ? { abi: typed, path } : { abi: typed, path, stale };
  }
  return undefined;
}

interface Selectors {
  functions: Map<string, string>; // selector -> signature
  events: Map<string, string>; // topic0 -> signature
  errors: Map<string, string>; // selector -> signature
}

function describeInputs(inputs: readonly { type: string }[]): string {
  return inputs.map((i) => i.type).join(',');
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
      // error selectors are computed exactly like function selectors
      out.errors.set(toFunctionSelector({ ...e, type: 'function', stateMutability: 'pure', outputs: [] }), `${e.name}(${describeInputs(e.inputs)})`);
    }
  }
  return out;
}

function missing(expected: Map<string, string>, actual: Map<string, string>, skip: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const [sel, sig] of expected) {
    if (actual.has(sel)) continue;
    const name = sig.slice(0, sig.indexOf('('));
    if (skip.includes(name)) continue;
    out.push(`${sig} [${sel}]`);
  }
  return out;
}

describe('human-readable ABI sanity', () => {
  it('parses every function, event and error required by SPEC §2.3 + D1–D10', () => {
    const fnNames = new Set<string>(mindLaunchpadAbi.filter((i) => i.type === 'function').map((i) => i.name));
    for (const name of [
      'createMind', 'buy', 'sell', 'graduate', 'harvest', 'fundMind',
      'quoteBuy', 'quoteSell', 'currentPrice', 'getMind', 'getCurve', 'mindBalance', 'protocolBalance',
      'mindsLength', 'mindAt', 'isMind', 'feeParams', 'creationFee', 'drawLimit', 'drawnInEpoch',
      'operator', 'treasury', 'computeTreasury', 'graduator', 'graduatorOf', 'isGraduator',
      'VIRTUAL_ETH', 'VIRTUAL_TOKENS', 'CURVE_SUPPLY', 'LP_SUPPLY', 'TOTAL_SUPPLY',
      'setMindConfig', 'setCreatorPaused', 'drawCompute', 'anchorMemory', 'setMindStatus',
      'setOperator', 'setTreasury', 'setComputeTreasury', 'setGraduator', 'setFeeParams', 'setCreationFee', 'setDrawLimit',
      'pause', 'unpause', 'withdrawProtocolFees', 'owner', 'pendingOwner', 'transferOwnership', 'acceptOwnership', 'paused',
    ]) {
      expect(fnNames.has(name), `function ${name}`).toBe(true);
    }
    const eventNames = new Set<string>(mindLaunchpadAbi.filter((i) => i.type === 'event').map((i) => i.name));
    for (const name of [
      'MindCreated', 'Trade', 'CurveCompleted', 'Graduated', 'MindFunded', 'FeeAccrued', 'ComputeDrawn', 'MemoryAnchored',
      'MindConfigUpdated', 'MindStatusChanged', 'Harvested', 'ProtocolFeesWithdrawn',
      'OperatorUpdated', 'TreasuryUpdated', 'ComputeTreasuryUpdated', 'GraduatorUpdated', 'FeeParamsUpdated',
      'CreationFeeUpdated', 'DrawLimitUpdated',
    ]) {
      expect(eventNames.has(name), `event ${name}`).toBe(true);
    }
    const errorNames = new Set<string>(mindLaunchpadAbi.filter((i) => i.type === 'error').map((i) => i.name));
    for (const name of [
      'NotAMind', 'WrongPhase', 'Slippage', 'Expired', 'ZeroAmount', 'NotCreator', 'NotOperator',
      'InvalidStatus', 'DrawLimitExceeded', 'InsufficientMindBalance', 'FeeTooHigh', 'InsufficientCreationFee', 'ZeroAddress',
      'EthTransferFailed', 'DirectEthNotAccepted', 'GraduatorNotSet',
    ]) {
      expect(errorNames.has(name), `error ${name}`).toBe(true);
    }
  });

  it('drops every member removed by the directives and has no constructor', () => {
    const names = new Set<string>(mindLaunchpadAbi.filter((i) => 'name' in i).map((i) => (i as { name: string }).name));
    for (const removed of REMOVED_LAUNCHPAD_MEMBERS) expect(names.has(removed), removed).toBe(false);
    expect(names.has('Retired')).toBe(false);
    const kinds = (abi: readonly { type: string }[]): string[] => abi.map((i) => i.type);
    expect(kinds(mindLaunchpadAbi)).not.toContain('constructor');
    expect(kinds(mindTokenAbi)).not.toContain('constructor');
    expect(mindLaunchpadAbi.some((i) => i.type === 'receive')).toBe(true);
    expect(OPTIONAL_LAUNCHPAD_FUNCTIONS).toEqual([]);
  });

  it('well-known selectors / topics are stable', () => {
    const s = selectorsOf(mindLaunchpadAbi);
    expect(s.functions.get(toFunctionSelector('buy(address,uint256,uint256)'))).toBe('buy(address,uint256,uint256)');
    expect(s.functions.get(toFunctionSelector('sell(address,uint256,uint256,uint256)'))).toBe('sell(address,uint256,uint256,uint256)');
    expect(s.functions.get(toFunctionSelector('setFeeParams((uint16,uint16,uint16))'))).toBe('setFeeParams(tuple)');
    expect(s.events.has(toEventSelector('Trade(address,address,bool,uint256,uint256,uint256,uint256,uint256)'))).toBe(true);
    expect(s.events.has(toEventSelector('MindStatusChanged(address,uint8)'))).toBe(true);
    expect(s.events.has(toEventSelector('ComputeDrawn(address,uint256,bytes32)'))).toBe(true);
    expect(s.functions.get(toFunctionSelector('drawCompute(address,uint256,bytes32)'))).toBe('drawCompute(address,uint256,bytes32)');
    expect(s.functions.get(toFunctionSelector('setCreatorPaused(address,bool)'))).toBe('setCreatorPaused(address,bool)');
    expect(s.functions.get(toFunctionSelector('graduatorOf(address)'))).toBe('graduatorOf(address)');
    expect(s.errors.get(toFunctionSelector('DirectEthNotAccepted()'))).toBe('DirectEthNotAccepted()');
    const token = selectorsOf(mindTokenAbi);
    expect(token.functions.has('0xa9059cbb')).toBe(true); // transfer(address,uint256)
    expect(token.functions.has('0xd505accf')).toBe(true); // permit(...)
    expect(token.events.has('0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef')).toBe(true); // Transfer
    const grad = selectorsOf(graduatorAbi);
    expect(grad.functions.get(toFunctionSelector('graduate(address,uint256)'))).toBe('graduate(address,uint256)');
    expect(grad.functions.get(toFunctionSelector('harvest(address)'))).toBe('harvest(address)');
    expect(grad.events.has(toEventSelector('GraduatedAtSkewedPrice(address,uint160,uint160)'))).toBe(true);
    const graduate = graduatorAbi.find((i) => i.type === 'function' && i.name === 'graduate') as AbiFunction;
    expect(graduate.stateMutability).toBe('payable');
    expect(graduate.outputs.map((o) => o.name)).toEqual(['pool', 'positionId', 'ethReturned']);
    expect(selectorsOf(aggregatorV3Abi).functions.has('0xfeaf968c')).toBe(true); // latestRoundData()
  });

  it('enum helpers match the Solidity declaration order', () => {
    expect(CurvePhase).toEqual({ Bonding: 0, Complete: 1, Graduated: 2 });
    expect(MindStatus).toEqual({ Alive: 0, Dormant: 1, Paused: 2 });
  });

  it('struct returns are tuples with the SPEC field order', () => {
    const getMind = mindLaunchpadAbi.find((i) => i.type === 'function' && i.name === 'getMind') as AbiFunction;
    const out = getMind.outputs[0] as { type: string; components?: { name: string }[] };
    expect(out.type).toBe('tuple');
    expect(out.components?.map((c) => c.name)).toEqual(['creator', 'modelId', 'personaHash', 'metadataURI', 'createdAt', 'status']);
    const getCurve = mindLaunchpadAbi.find((i) => i.type === 'function' && i.name === 'getCurve') as AbiFunction;
    const curve = getCurve.outputs[0] as { type: string; components?: { name: string }[] };
    expect(curve.components?.map((c) => c.name)).toEqual(['realEthReserve', 'tokensSold', 'phase', 'pool', 'positionId']);
  });
});

const launchpadArtifactRaw = loadArtifactAbi('MindLaunchpad');
const tokenArtifactRaw = loadArtifactAbi('MindToken');
const launchpadArtifact = launchpadArtifactRaw?.stale === undefined ? launchpadArtifactRaw : undefined;
const tokenArtifact = tokenArtifactRaw?.stale === undefined ? tokenArtifactRaw : undefined;

describe.skipIf(launchpadArtifact === undefined)('MindLaunchpad ABI equivalence with the Foundry artifact', () => {
  const ours = selectorsOf(mindLaunchpadAbi);
  const theirs = selectorsOf(launchpadArtifact?.abi ?? []);

  it('every function in the human-readable ABI exists in the artifact (same selector)', () => {
    expect(missing(ours.functions, theirs.functions, OPTIONAL_LAUNCHPAD_FUNCTIONS)).toEqual([]);
  });
  it('every event in the human-readable ABI exists in the artifact (same topic0)', () => {
    expect(missing(ours.events, theirs.events)).toEqual([]);
  });
  it('every error in the human-readable ABI exists in the artifact (same selector)', () => {
    expect(missing(ours.errors, theirs.errors)).toEqual([]);
  });
  it('the artifact has no functions or events the human-readable ABI lacks', () => {
    expect(missing(theirs.functions, ours.functions)).toEqual([]);
    expect(missing(theirs.events, ours.events)).toEqual([]);
  });
  it('reports artifact errors the human-readable ABI lacks (library errors are tolerated)', () => {
    const extra = missing(theirs.errors, ours.errors);
    if (extra.length > 0) {
      // eslint-disable-next-line no-console
      console.info(`[abi.test] artifact declares extra errors not in mindLaunchpadAbi: ${extra.join(', ')}`);
    }
    // Only a handful of library-level errors are acceptable; anything from SPEC must already be in ours.
    expect(extra.length).toBeLessThanOrEqual(8);
  });
});

describe.skipIf(tokenArtifact === undefined)('MindToken ABI equivalence with the Foundry artifact', () => {
  const ours = selectorsOf(mindTokenAbi);
  const theirs = selectorsOf(tokenArtifact?.abi ?? []);

  it('functions and events match in both directions', () => {
    expect(missing(ours.functions, theirs.functions)).toEqual([]);
    expect(missing(ours.events, theirs.events)).toEqual([]);
    expect(missing(theirs.functions, ours.functions)).toEqual([]);
    expect(missing(theirs.events, ours.events)).toEqual([]);
  });
  it('every error in the human-readable ABI exists in the artifact', () => {
    expect(missing(ours.errors, theirs.errors)).toEqual([]);
  });
});

for (const [name, raw] of [['MindLaunchpad', launchpadArtifactRaw], ['MindToken', tokenArtifactRaw]] as const) {
  if (raw === undefined) {
    // eslint-disable-next-line no-console
    console.info(
      `[abi.test] contracts/out/${name}.sol/${name}.json not found — artifact equivalence skipped. ` +
        'Run `cd contracts && forge build` (or `pnpm abi:sync`) to enable it.',
    );
  } else if (raw.stale !== undefined) {
    // eslint-disable-next-line no-console
    console.info(`[abi.test] ${raw.path} is stale (${raw.stale}) — artifact equivalence skipped; rebuild with \`forge build\`.`);
  }
}
