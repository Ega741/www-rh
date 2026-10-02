/**
 * Pons-mode test helpers: log encoding for the registry / Pons ABIs and a fake {@link PonsReader}.
 * No network.
 */
import { encodeAbiParameters, encodeEventTopics, keccak256, toHex, type Abi, type AbiEvent, type Address, type Hex } from 'viem';
import { modelIdToHash, personaHash, type LaunchConfigResponse } from '@www-rh/shared';
import type { OnchainMind } from '../src/chain/launchpad.js';
import type { OnchainPonsMind, PonsCurveParams, PonsCurveState, PonsLaunchedToken, PonsReader, PonsTokenInfo, ResolvedPonsContracts } from '../src/chain/pons.js';
import type { RawLog } from '../src/indexer/source.js';
import { CREATOR, PERSONA } from './helpers.js';

export const REGISTRY = '0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0' as Address;
export const FACTORY = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e' as Address;
export const ESCROW = '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e' as Address;
export const HOOK = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044' as Address;
export const PTOKEN = '0x4444444444444444444444444444444444444444' as Address;
export const PCURVE = '0x5555555555555555555555555555555555555555' as Address;
export const PACCOUNT = '0x6666666666666666666666666666666666666666' as Address;
export const ATOKEN = '0x7777777777777777777777777777777777777777' as Address;
export const ACURVE = '0x8888888888888888888888888888888888888888' as Address;
export const AACCOUNT = '0x9999999999999999999999999999999999999999' as Address;
export const BUYER = '0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0' as Address;
export const E = 10n ** 18n;
// mainnet launch config 0
export const SUPPLY = 10n ** 27n;
export const PHANTOM = 1_680_000_000_000_000_000n;
export const THRESHOLD = 4_200_000_000_000_000_000n;
export const RESERVED = (SUPPLY * PHANTOM) / (PHANTOM + THRESHOLD);

/** Encodes `eventName` of `abi` emitted by `address` as a raw log. */
export function encodePonsLog(abi: Abi, eventName: string, args: Record<string, unknown>, at: { address: Address; block: bigint; logIndex: number; tx?: Hex; timestamp?: bigint }): RawLog {
  const event = abi.find((i) => i.type === 'event' && i.name === eventName) as AbiEvent | undefined;
  if (event === undefined) throw new Error(`no event ${eventName}`);
  const indexed: Record<string, unknown> = {};
  for (const input of event.inputs) if (input.indexed === true && input.name !== undefined) indexed[input.name] = args[input.name];
  const topics = encodeEventTopics({ abi: [event], eventName, args: indexed } as Parameters<typeof encodeEventTopics>[0]) as Hex[];
  const dataInputs = event.inputs.filter((i) => i.indexed !== true);
  const log: RawLog = {
    address: at.address,
    topics,
    data: encodeAbiParameters(dataInputs, dataInputs.map((i) => args[i.name as string])),
    blockNumber: at.block,
    transactionHash: at.tx ?? keccak256(toHex(`tx-${at.block}-${at.logIndex}`)),
    logIndex: at.logIndex,
  };
  if (at.timestamp !== undefined) log.blockTimestamp = at.timestamp;
  return log;
}

/** `MindCreated` args of a Pons mind. */
export function mindCreatedArgs(token: Address, model = 'claude-opus-5-5'): Record<string, unknown> {
  return { token, creator: CREATOR, name: 'Pons Mind', symbol: 'PMND', metadataURI: 'runner://metadata/' + 'cd'.repeat(32), modelId: modelIdToHash(model), personaHash: personaHash(PERSONA) };
}

/** In-memory {@link PonsReader}. */
export class FakePonsReader implements PonsReader {
  readonly registry = REGISTRY;
  /** End-of-block curve states, keyed `${curve}@${block}` (lowercase curve); missing = the read fails. */
  states = new Map<string, PonsCurveState>();
  launched = new Map<string, PonsLaunchedToken>();
  minds = new Map<string, OnchainPonsMind>();
  claimables = new Map<string, bigint>();
  mindInfo = new Map<string, OnchainMind>();
  calls: string[] = [];
  launchConfigReads = 0;
  failLaunchConfig = false;

  async contracts(): Promise<ResolvedPonsContracts> {
    return { factory: FACTORY, feeEscrow: ESCROW, memeHook: HOOK };
  }

  async launchedToken(token: Address): Promise<PonsLaunchedToken> {
    this.calls.push(`launchedToken ${token.toLowerCase()}`);
    const l = this.launched.get(token.toLowerCase());
    if (l === undefined) throw new Error('TokenNotFound');
    return l;
  }

  async ponsMind(token: Address): Promise<OnchainPonsMind> {
    const m = this.minds.get(token.toLowerCase());
    if (m === undefined) throw new Error('not registered');
    return m;
  }

  async claimable(token: Address): Promise<bigint> {
    return this.claimables.get(token.toLowerCase()) ?? 0n;
  }

  async curveState(curve: Address, blockNumber?: bigint): Promise<PonsCurveState> {
    this.calls.push(`curveState ${curve.toLowerCase()}@${blockNumber}`);
    const s = this.states.get(`${curve.toLowerCase()}@${blockNumber}`);
    if (s === undefined) throw new Error('missing trie node (historical state unavailable)');
    return s;
  }

  async curveParams(): Promise<PonsCurveParams> {
    return { feeBps: 100n, creatorTaxBps: 0n, graduationThreshold: THRESHOLD };
  }

  async tokenInfo(token: Address): Promise<PonsTokenInfo> {
    return { name: token.toLowerCase() === ATOKEN ? 'Adopted Coin' : 'Pons Mind', symbol: token.toLowerCase() === ATOKEN ? 'ADPT' : 'PMND', totalSupply: SUPPLY };
  }

  async getMind(token: Address): Promise<OnchainMind> {
    const m = this.mindInfo.get(token.toLowerCase());
    if (m === undefined) throw new Error('not a mind');
    return m;
  }

  async launchConfig(): Promise<LaunchConfigResponse> {
    this.launchConfigReads++;
    if (this.failLaunchConfig) throw new Error('factory unreachable');
    return {
      launchFee: '500000000000000',
      configs: [{ id: 0, supply: SUPPLY.toString(), curveFeeBps: 100, phantomQuote: PHANTOM.toString(), graduationThreshold: THRESHOLD.toString(), enabled: true }],
      maxCreatorTaxBps: 1000,
      snipeTaxSeconds: 15,
    };
  }
}

/** A launch record as `getLaunchedToken` returns it. */
export function launchedToken(curve: Address, over: Partial<PonsLaunchedToken> = {}): PonsLaunchedToken {
  return {
    exists: true, curve, deployer: REGISTRY, creatorFeeRecipient: PACCOUNT, pairToken: '0x0000000000000000000000000000000000000000', creatorTaxBps: 0,
    buybackEnabled: false, phase: 0, graduationThreshold: THRESHOLD, sweptQuote: 0n, sweptTokens: 0n, sweptAt: 0n, ...over,
  };
}
