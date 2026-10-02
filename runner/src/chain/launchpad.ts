/**
 * Typed read/write helpers for `MindLaunchpad` (SPEC §4.1 `chain/launchpad.ts`). Writes are
 * simulated first (so reverts such as `DrawLimitExceeded` surface without spending gas) and never
 * sent in `DRY_RUN`.
 *
 * @module chain/launchpad
 */
import { BaseError, ContractFunctionRevertedError, type Address, type Hex } from 'viem';
import { mindLaunchpadAbi } from '@www-rh/shared';
import type { RunnerPublicClient, RunnerWalletClient } from './clients.js';

/** `MindInfo` as returned by `getMind`. */
export interface OnchainMind {
  creator: Address;
  modelId: Hex;
  personaHash: Hex;
  metadataURI: string;
  createdAt: bigint;
  status: number;
}

/** `CurveState` as returned by `getCurve`. */
export interface OnchainCurve {
  realEthReserve: bigint;
  tokensSold: bigint;
  phase: number;
  pool: Address;
  positionId: bigint;
}

/** Read-only launchpad access. */
export interface LaunchpadReader {
  readonly address: Address;
  getMind(token: Address): Promise<OnchainMind>;
  getCurve(token: Address): Promise<OnchainCurve>;
  mindBalance(token: Address): Promise<bigint>;
  drawLimit(): Promise<{ maxPerEpoch: bigint; epochSeconds: number }>;
  drawnInEpoch(token: Address): Promise<{ drawn: bigint; epochStart: bigint }>;
  graduatorOf(token: Address): Promise<Address>;
  operator(): Promise<Address>;
  /** Timestamp of the latest block (seconds). */
  latestTimestamp(): Promise<bigint>;
}

/** Result of a write: skipped in dry-run mode, or submitted with its hash. */
export type TxOutcome = { kind: 'dry_run' } | { kind: 'submitted'; hash: Hex };

/** Operator / permissionless writes. */
export interface LaunchpadWriter {
  readonly dryRun: boolean;
  drawCompute(token: Address, amount: bigint, receiptHash: Hex): Promise<TxOutcome>;
  anchorMemory(token: Address, seq: bigint, contentHash: Hex, uri: string): Promise<TxOutcome>;
  setMindStatus(token: Address, status: 0 | 1): Promise<TxOutcome>;
  graduate(token: Address): Promise<TxOutcome>;
  harvest(token: Address): Promise<TxOutcome>;
  /** Waits for the receipt of a submitted transaction. */
  waitForReceipt(hash: Hex): Promise<'success' | 'reverted'>;
}

/** Launchpad gateway = reader + writer. */
export type LaunchpadGateway = LaunchpadReader & LaunchpadWriter;

/** Custom error name of a contract revert (e.g. `DrawLimitExceeded`), if `err` is one. */
export function revertName(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (revert instanceof ContractFunctionRevertedError) return revert.data?.errorName ?? revert.reason ?? undefined;
  return undefined;
}

type WriteName = 'drawCompute' | 'anchorMemory' | 'setMindStatus' | 'graduate' | 'harvest';

/** viem implementation of {@link LaunchpadGateway}. */
export class ViemLaunchpad implements LaunchpadGateway {
  constructor(
    readonly address: Address,
    private readonly publicClient: RunnerPublicClient,
    private readonly walletClient: RunnerWalletClient | null,
    readonly dryRun: boolean,
  ) {}

  async getMind(token: Address): Promise<OnchainMind> {
    const m = await this.publicClient.readContract({ address: this.address, abi: mindLaunchpadAbi, functionName: 'getMind', args: [token] });
    return { creator: m.creator, modelId: m.modelId, personaHash: m.personaHash, metadataURI: m.metadataURI, createdAt: m.createdAt, status: m.status };
  }

  async getCurve(token: Address): Promise<OnchainCurve> {
    const c = await this.publicClient.readContract({ address: this.address, abi: mindLaunchpadAbi, functionName: 'getCurve', args: [token] });
    return { realEthReserve: c.realEthReserve, tokensSold: c.tokensSold, phase: c.phase, pool: c.pool, positionId: c.positionId };
  }

  mindBalance(token: Address): Promise<bigint> {
    return this.publicClient.readContract({ address: this.address, abi: mindLaunchpadAbi, functionName: 'mindBalance', args: [token] });
  }

  async drawLimit(): Promise<{ maxPerEpoch: bigint; epochSeconds: number }> {
    const [maxPerEpoch, epochSeconds] = await this.publicClient.readContract({ address: this.address, abi: mindLaunchpadAbi, functionName: 'drawLimit' });
    return { maxPerEpoch, epochSeconds };
  }

  async drawnInEpoch(token: Address): Promise<{ drawn: bigint; epochStart: bigint }> {
    const [drawn, epochStart] = await this.publicClient.readContract({ address: this.address, abi: mindLaunchpadAbi, functionName: 'drawnInEpoch', args: [token] });
    return { drawn, epochStart };
  }

  graduatorOf(token: Address): Promise<Address> {
    return this.publicClient.readContract({ address: this.address, abi: mindLaunchpadAbi, functionName: 'graduatorOf', args: [token] });
  }

  operator(): Promise<Address> {
    return this.publicClient.readContract({ address: this.address, abi: mindLaunchpadAbi, functionName: 'operator' });
  }

  async latestTimestamp(): Promise<bigint> {
    const block = await this.publicClient.getBlock({ blockTag: 'latest' });
    return block.timestamp;
  }

  drawCompute(token: Address, amount: bigint, receiptHash: Hex): Promise<TxOutcome> {
    return this.#write('drawCompute', [token, amount, receiptHash]);
  }

  anchorMemory(token: Address, seq: bigint, contentHash: Hex, uri: string): Promise<TxOutcome> {
    return this.#write('anchorMemory', [token, seq, contentHash, uri]);
  }

  setMindStatus(token: Address, status: 0 | 1): Promise<TxOutcome> {
    return this.#write('setMindStatus', [token, status]);
  }

  graduate(token: Address): Promise<TxOutcome> {
    return this.#write('graduate', [token]);
  }

  harvest(token: Address): Promise<TxOutcome> {
    return this.#write('harvest', [token]);
  }

  async waitForReceipt(hash: Hex): Promise<'success' | 'reverted'> {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    return receipt.status;
  }

  async #write(functionName: WriteName, args: readonly unknown[]): Promise<TxOutcome> {
    if (this.dryRun || this.walletClient === null) return { kind: 'dry_run' };
    const wallet = this.walletClient;
    // The ABI is a const tuple; viem infers per-function arg types from `functionName`.
    const { request } = await this.publicClient.simulateContract({
      account: wallet.account,
      address: this.address,
      abi: mindLaunchpadAbi,
      functionName,
      args,
    } as Parameters<RunnerPublicClient['simulateContract']>[0]);
    const hash = await wallet.writeContract(request as Parameters<RunnerWalletClient['writeContract']>[0]);
    return { kind: 'submitted', hash };
  }
}
