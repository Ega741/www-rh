/**
 * Typed reads of the Pons V2 contracts and of `PonsMindRegistry` (`docs/SPEC.md` §9.1, §9.2, §9.4).
 * MindCore reads (`getMind`, `mindBalance`, draw limits, `operator`) share their selectors with
 * `MindLaunchpad` and go through {@link ViemLaunchpadReader} pointed at the registry; this module
 * only covers the Pons-specific surface.
 *
 * Pons addresses come from `PONS_*` / the `@www-rh/shared` constants (4663), or are read once from
 * the registry (`factory()`, `feeEscrow()`, `memeHook()`) when neither is configured.
 *
 * @module chain/pons
 */
import { erc20Abi, type Address, type Hex } from 'viem';
import { ponsCurveAbi, ponsFactoryAbi, ponsMindRegistryAbi, type LaunchConfigResponse } from '@www-rh/shared';
import type { PonsContracts } from '../config.js';
import type { RunnerPublicClient } from './clients.js';
import type { OnchainMind } from './launchpad.js';

/** Resolved Pons V2 addresses. */
export interface ResolvedPonsContracts {
  factory: Address;
  feeEscrow: Address;
  memeHook: Address;
}

/** `factory.getLaunchedToken(token)` (the subset the runner uses). */
export interface PonsLaunchedToken {
  exists: boolean;
  curve: Address;
  deployer: Address;
  creatorFeeRecipient: Address;
  pairToken: Address;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  /** `GraduationPhase`: 0 NotGraduated, 1 Swept, 2 PoolCreated, 3 Rescued. */
  phase: number;
  graduationThreshold: bigint;
  sweptQuote: bigint;
  sweptTokens: bigint;
  /** Unix seconds (0 before the sweep). */
  sweptAt: bigint;
}

/** `registry.ponsMind(token)`. */
export interface OnchainPonsMind {
  curve: Address;
  account: Address;
  launchConfigId: bigint;
  launchedHere: boolean;
  adopted: boolean;
}

/** Curve reserves at one block (`getReserves()` + `realQuoteReserve()`). */
export interface PonsCurveState {
  quoteReserve: bigint;
  tokenReserve: bigint;
  realQuoteReserve: bigint;
}

/** Immutable curve parameters. */
export interface PonsCurveParams {
  feeBps: bigint;
  creatorTaxBps: bigint;
  graduationThreshold: bigint;
}

/** ERC-20 facts of a launch token. */
export interface PonsTokenInfo {
  name: string;
  symbol: string;
  totalSupply: bigint;
}

/** Read-only Pons access used by the indexer, the scheduler and the API. */
export interface PonsReader {
  readonly registry: Address;
  contracts(): Promise<ResolvedPonsContracts>;
  launchedToken(token: Address): Promise<PonsLaunchedToken>;
  ponsMind(token: Address): Promise<OnchainPonsMind>;
  /** `registry.claimable(token)` = `feeEscrow.balanceOf(accountOf(token))`. */
  claimable(token: Address): Promise<bigint>;
  /** Reserves at `blockNumber` (end-of-block state), or at `latest`. */
  curveState(curve: Address, blockNumber?: bigint): Promise<PonsCurveState>;
  curveParams(curve: Address): Promise<PonsCurveParams>;
  tokenInfo(token: Address): Promise<PonsTokenInfo>;
  /** `registry.getMind(token)`. */
  getMind(token: Address): Promise<OnchainMind>;
  /** `GET /api/launch-config` body (factory reads). */
  launchConfig(): Promise<LaunchConfigResponse>;
}

/** viem implementation of {@link PonsReader}. */
export class ViemPonsReader implements PonsReader {
  #contracts: Promise<ResolvedPonsContracts> | null = null;

  constructor(
    readonly registry: Address,
    private readonly client: RunnerPublicClient,
    private readonly configured: PonsContracts,
  ) {}

  contracts(): Promise<ResolvedPonsContracts> {
    const c = this.configured;
    if (c.factory !== null && c.feeEscrow !== null && c.memeHook !== null) return Promise.resolve({ factory: c.factory, feeEscrow: c.feeEscrow, memeHook: c.memeHook });
    this.#contracts ??= (async () => {
      const read = (functionName: 'factory' | 'feeEscrow' | 'memeHook') => this.client.readContract({ address: this.registry, abi: ponsMindRegistryAbi, functionName });
      const [factory, feeEscrow, memeHook] = await Promise.all([c.factory ?? read('factory'), c.feeEscrow ?? read('feeEscrow'), c.memeHook ?? read('memeHook')]);
      return { factory, feeEscrow, memeHook };
    })().catch((err: unknown) => {
      this.#contracts = null; // retried on the next call
      throw err;
    });
    return this.#contracts;
  }

  async launchedToken(token: Address): Promise<PonsLaunchedToken> {
    const { factory } = await this.contracts();
    const t = await this.client.readContract({ address: factory, abi: ponsFactoryAbi, functionName: 'getLaunchedToken', args: [token] });
    return {
      exists: t.exists,
      curve: t.curve,
      deployer: t.deployer,
      creatorFeeRecipient: t.creatorFeeRecipient,
      pairToken: t.pairToken,
      creatorTaxBps: t.creatorTaxBps,
      buybackEnabled: t.buybackEnabled,
      phase: t.phase,
      graduationThreshold: t.graduationThreshold,
      sweptQuote: t.sweptQuote,
      sweptTokens: t.sweptTokens,
      sweptAt: t.sweptAt,
    };
  }

  async ponsMind(token: Address): Promise<OnchainPonsMind> {
    const m = await this.client.readContract({ address: this.registry, abi: ponsMindRegistryAbi, functionName: 'ponsMind', args: [token] });
    return { curve: m.curve, account: m.account, launchConfigId: m.launchConfigId, launchedHere: m.launchedHere, adopted: m.adopted };
  }

  claimable(token: Address): Promise<bigint> {
    return this.client.readContract({ address: this.registry, abi: ponsMindRegistryAbi, functionName: 'claimable', args: [token] });
  }

  async curveState(curve: Address, blockNumber?: bigint): Promise<PonsCurveState> {
    const at = blockNumber !== undefined ? { blockNumber } : {};
    const [[quoteReserve, tokenReserve], realQuoteReserve] = await Promise.all([
      this.client.readContract({ address: curve, abi: ponsCurveAbi, functionName: 'getReserves', ...at }),
      this.client.readContract({ address: curve, abi: ponsCurveAbi, functionName: 'realQuoteReserve', ...at }),
    ]);
    return { quoteReserve, tokenReserve, realQuoteReserve };
  }

  async curveParams(curve: Address): Promise<PonsCurveParams> {
    const [feeBps, creatorTaxBps, graduationThreshold] = await Promise.all([
      this.client.readContract({ address: curve, abi: ponsCurveAbi, functionName: 'feeBps' }),
      this.client.readContract({ address: curve, abi: ponsCurveAbi, functionName: 'creatorTaxBps' }),
      this.client.readContract({ address: curve, abi: ponsCurveAbi, functionName: 'graduationThreshold' }),
    ]);
    return { feeBps, creatorTaxBps, graduationThreshold };
  }

  async tokenInfo(token: Address): Promise<PonsTokenInfo> {
    const [name, symbol, totalSupply] = await Promise.all([
      this.client.readContract({ address: token, abi: erc20Abi, functionName: 'name' }),
      this.client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
      this.client.readContract({ address: token, abi: erc20Abi, functionName: 'totalSupply' }),
    ]);
    return { name, symbol, totalSupply };
  }

  async getMind(token: Address): Promise<OnchainMind> {
    const m = await this.client.readContract({ address: this.registry, abi: ponsMindRegistryAbi, functionName: 'getMind', args: [token] });
    return { creator: m.creator, modelId: m.modelId, personaHash: m.personaHash, metadataURI: m.metadataURI, createdAt: m.createdAt, status: m.status };
  }

  async launchConfig(): Promise<LaunchConfigResponse> {
    const { factory } = await this.contracts();
    const read = <F extends 'launchFee' | 'launchConfigCount' | 'maxCreatorTaxBps' | 'snipeTaxSeconds'>(functionName: F) =>
      this.client.readContract({ address: factory, abi: ponsFactoryAbi, functionName });
    const [launchFee, count, maxCreatorTaxBps, snipeTaxSeconds] = await Promise.all([read('launchFee'), read('launchConfigCount'), read('maxCreatorTaxBps'), read('snipeTaxSeconds')]);
    const ids = Array.from({ length: Math.min(Number(count), 64) }, (_, i) => i);
    const configs = await Promise.all(ids.map((id) => this.client.readContract({ address: factory, abi: ponsFactoryAbi, functionName: 'getLaunchConfig', args: [BigInt(id)] })));
    return {
      launchFee: launchFee.toString(10),
      configs: configs.map((c, id) => ({
        id,
        supply: c.supply.toString(10),
        curveFeeBps: Number(c.curveFeeBps),
        phantomQuote: c.phantomQuote.toString(10),
        graduationThreshold: c.graduationThreshold.toString(10),
        enabled: c.enabled,
      })),
      maxCreatorTaxBps: Number(maxCreatorTaxBps),
      snipeTaxSeconds: Number(snipeTaxSeconds),
    };
  }
}

/** Read-through cache of the launch config (`GET /api/launch-config`, 60 s, §9.4). */
export class LaunchConfigCache {
  #value: { body: LaunchConfigResponse; at: number } | null = null;
  #inFlight: Promise<LaunchConfigResponse> | null = null;

  constructor(
    private readonly read: () => Promise<LaunchConfigResponse>,
    private readonly now: () => number = Date.now,
    readonly ttlMs = 60_000,
  ) {}

  /** The cached body while fresh; otherwise one shared read (a failed read is not cached). */
  get(): Promise<LaunchConfigResponse> {
    const v = this.#value;
    if (v !== null && this.now() - v.at < this.ttlMs) return Promise.resolve(v.body);
    this.#inFlight ??= this.read().then(
      (body) => {
        this.#value = { body, at: this.now() };
        this.#inFlight = null;
        return body;
      },
      (err: unknown) => {
        this.#inFlight = null;
        throw err;
      },
    );
    return this.#inFlight;
  }
}

/** A `bytes32` topic for an address (indexed `address` parameters). */
export function addressTopic(address: string): Hex {
  return `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}` as Hex;
}
