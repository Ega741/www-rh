/**
 * Typed `MindLaunchpad` reads and operator writes (`docs/SPEC.md` §4.1 `chain/launchpad.ts`).
 * Writes are not sent from here directly: they go through the FIFO {@link TxQueue} (`txQueue.ts`),
 * which uses {@link LaunchpadSender} to simulate, send and await each transaction.
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
  feeParams(): Promise<{ tradeFeeBps: number; mindShareBps: number; graduationFeeBps: number }>;
  operator(): Promise<Address>;
  /** Timestamp (unix seconds) of the latest block. */
  latestTimestamp(): Promise<bigint>;
}

/** Operator / permissionless write calls, as `(functionName, args)` pairs. */
export type LaunchpadWrite =
  | { functionName: 'drawCompute'; args: readonly [Address, bigint, Hex] }
  | { functionName: 'anchorMemory'; args: readonly [Address, bigint, Hex, string] }
  | { functionName: 'setMindStatus'; args: readonly [Address, 0 | 1] }
  | { functionName: 'graduate'; args: readonly [Address] }
  | { functionName: 'harvest'; args: readonly [Address] };

/** Simulates + sends transactions and waits for receipts (used by the tx queue). */
export interface LaunchpadSender {
  /** The operator account. */
  readonly account: Address;
  /** Simulates (`eth_call`) then sends the transaction; resolves to its hash. */
  send(write: LaunchpadWrite): Promise<Hex>;
  /** Waits for the receipt (rejects on timeout). */
  waitForReceipt(hash: Hex, timeoutMs: number): Promise<'success' | 'reverted'>;
}

/** Custom error name of a contract revert (e.g. `DrawLimitExceeded`), if `err` is one. */
export function revertName(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (revert instanceof ContractFunctionRevertedError) return revert.data?.errorName ?? revert.reason ?? undefined;
  return undefined;
}

/** viem implementation of {@link LaunchpadReader}. */
export class ViemLaunchpadReader implements LaunchpadReader {
  constructor(
    readonly address: Address,
    private readonly client: RunnerPublicClient,
  ) {}

  async getMind(token: Address): Promise<OnchainMind> {
    const m = await this.client.readContract({ address: this.address, abi: mindLaunchpadAbi, functionName: 'getMind', args: [token] });
    return { creator: m.creator, modelId: m.modelId, personaHash: m.personaHash, metadataURI: m.metadataURI, createdAt: m.createdAt, status: m.status };
  }

  async getCurve(token: Address): Promise<OnchainCurve> {
    const c = await this.client.readContract({ address: this.address, abi: mindLaunchpadAbi, functionName: 'getCurve', args: [token] });
    return { realEthReserve: c.realEthReserve, tokensSold: c.tokensSold, phase: c.phase, pool: c.pool, positionId: c.positionId };
  }

  mindBalance(token: Address): Promise<bigint> {
    return this.client.readContract({ address: this.address, abi: mindLaunchpadAbi, functionName: 'mindBalance', args: [token] });
  }

  async drawLimit(): Promise<{ maxPerEpoch: bigint; epochSeconds: number }> {
    const [maxPerEpoch, epochSeconds] = await this.client.readContract({ address: this.address, abi: mindLaunchpadAbi, functionName: 'drawLimit' });
    return { maxPerEpoch, epochSeconds };
  }

  async drawnInEpoch(token: Address): Promise<{ drawn: bigint; epochStart: bigint }> {
    const [drawn, epochStart] = await this.client.readContract({ address: this.address, abi: mindLaunchpadAbi, functionName: 'drawnInEpoch', args: [token] });
    return { drawn, epochStart };
  }

  async feeParams(): Promise<{ tradeFeeBps: number; mindShareBps: number; graduationFeeBps: number }> {
    const p = await this.client.readContract({ address: this.address, abi: mindLaunchpadAbi, functionName: 'feeParams' });
    return { tradeFeeBps: p.tradeFeeBps, mindShareBps: p.mindShareBps, graduationFeeBps: p.graduationFeeBps };
  }

  operator(): Promise<Address> {
    return this.client.readContract({ address: this.address, abi: mindLaunchpadAbi, functionName: 'operator' });
  }

  async latestTimestamp(): Promise<bigint> {
    return (await this.client.getBlock({ blockTag: 'latest' })).timestamp;
  }
}

/** viem implementation of {@link LaunchpadSender}. */
export class ViemLaunchpadSender implements LaunchpadSender {
  constructor(
    private readonly launchpad: Address,
    private readonly publicClient: RunnerPublicClient,
    private readonly walletClient: RunnerWalletClient,
  ) {}

  get account(): Address {
    return this.walletClient.account.address;
  }

  async send(write: LaunchpadWrite): Promise<Hex> {
    const base = { account: this.walletClient.account, address: this.launchpad, abi: mindLaunchpadAbi } as const;
    switch (write.functionName) {
      case 'drawCompute': {
        const { request } = await this.publicClient.simulateContract({ ...base, functionName: 'drawCompute', args: [...write.args] });
        return this.walletClient.writeContract(request);
      }
      case 'anchorMemory': {
        const { request } = await this.publicClient.simulateContract({ ...base, functionName: 'anchorMemory', args: [...write.args] });
        return this.walletClient.writeContract(request);
      }
      case 'setMindStatus': {
        const { request } = await this.publicClient.simulateContract({ ...base, functionName: 'setMindStatus', args: [...write.args] });
        return this.walletClient.writeContract(request);
      }
      case 'graduate': {
        const { request } = await this.publicClient.simulateContract({ ...base, functionName: 'graduate', args: [...write.args] });
        return this.walletClient.writeContract(request);
      }
      case 'harvest': {
        const { request } = await this.publicClient.simulateContract({ ...base, functionName: 'harvest', args: [...write.args] });
        return this.walletClient.writeContract(request);
      }
    }
  }

  async waitForReceipt(hash: Hex, timeoutMs: number): Promise<'success' | 'reverted'> {
    return (await this.publicClient.waitForTransactionReceipt({ hash, timeout: timeoutMs })).status;
  }
}
