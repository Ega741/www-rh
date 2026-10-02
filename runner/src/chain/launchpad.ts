/**
 * Typed `MindLaunchpad` reads and operator writes (`docs/SPEC.md` §4.1 `chain/launchpad.ts`).
 * Writes are not sent from here directly: they go through the FIFO {@link TxQueue} (`txQueue.ts`),
 * which uses {@link LaunchpadSender} to simulate, send and await each transaction.
 *
 * @module chain/launchpad
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeFunctionData,
  keccak256,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
} from 'viem';
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
  /** `mindBalance(token)` at `latest`, or at `blockNumber` (drift check against the indexed state). */
  mindBalance(token: Address, blockNumber?: bigint): Promise<bigint>;
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

/** A transaction signed locally; nothing has been broadcast yet. */
export interface SignedTx {
  hash: Hex;
  nonce: number;
  raw: Hex;
}

/**
 * Simulates, signs and broadcasts operator transactions (used by the tx queue). Signing and
 * broadcasting are separate steps so the transaction hash and nonce are known — and persisted —
 * before anything leaves the process: a failure after that point can always be resolved by hash.
 */
export interface LaunchpadSender {
  /** The operator account. */
  readonly account: Address;
  /** Simulates (`eth_call`), prepares (nonce, gas, fees) and signs locally. Throws on revert or RPC failure; nothing is broadcast. */
  sign(write: LaunchpadWrite): Promise<SignedTx>;
  /** `eth_sendRawTransaction`; re-sending identical bytes can never create a second transaction. */
  broadcast(raw: Hex): Promise<Hex>;
  /** Waits for the receipt of `hash` (rejects on timeout, transport errors, or when another transaction took its nonce). */
  waitForReceipt(hash: Hex, timeoutMs: number): Promise<'success' | 'reverted'>;
}

/** Read-only chain access of the draw-receipt reconciler. */
export interface DrawChainView {
  /** The operator account. */
  readonly account: Address;
  /** `eth_getTransactionReceipt`; `null` while the transaction is not mined (or unknown to the node). */
  transactionReceipt(hash: Hex): Promise<{ status: 'success' | 'reverted'; blockNumber: bigint } | null>;
  /** Nonce of a transaction the node knows (`eth_getTransactionByHash`), else `null`. */
  transactionNonce(hash: Hex): Promise<number | null>;
  /** Operator transaction count at `latest` (= mined nonces) or `pending`. */
  nonce(blockTag: 'latest' | 'pending'): Promise<number>;
  /** `eth_blockNumber`. */
  blockNumber(): Promise<bigint>;
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

  mindBalance(token: Address, blockNumber?: bigint): Promise<bigint> {
    return this.client.readContract({
      address: this.address,
      abi: mindLaunchpadAbi,
      functionName: 'mindBalance',
      args: [token],
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    });
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

  /** Simulates `write` (decoded custom-error reverts) and returns its calldata. */
  async #simulateAndEncode(write: LaunchpadWrite): Promise<Hex> {
    const base = { account: this.walletClient.account, address: this.launchpad, abi: mindLaunchpadAbi } as const;
    switch (write.functionName) {
      case 'drawCompute':
        await this.publicClient.simulateContract({ ...base, functionName: 'drawCompute', args: [...write.args] });
        return encodeFunctionData({ abi: mindLaunchpadAbi, functionName: 'drawCompute', args: [...write.args] });
      case 'anchorMemory':
        await this.publicClient.simulateContract({ ...base, functionName: 'anchorMemory', args: [...write.args] });
        return encodeFunctionData({ abi: mindLaunchpadAbi, functionName: 'anchorMemory', args: [...write.args] });
      case 'setMindStatus':
        await this.publicClient.simulateContract({ ...base, functionName: 'setMindStatus', args: [...write.args] });
        return encodeFunctionData({ abi: mindLaunchpadAbi, functionName: 'setMindStatus', args: [...write.args] });
      case 'graduate':
        await this.publicClient.simulateContract({ ...base, functionName: 'graduate', args: [...write.args] });
        return encodeFunctionData({ abi: mindLaunchpadAbi, functionName: 'graduate', args: [...write.args] });
      case 'harvest':
        await this.publicClient.simulateContract({ ...base, functionName: 'harvest', args: [...write.args] });
        return encodeFunctionData({ abi: mindLaunchpadAbi, functionName: 'harvest', args: [...write.args] });
    }
  }

  async sign(write: LaunchpadWrite): Promise<SignedTx> {
    const data = await this.#simulateAndEncode(write);
    const request = await this.walletClient.prepareTransactionRequest({ account: this.walletClient.account, chain: this.walletClient.chain, to: this.launchpad, data });
    const raw = await this.walletClient.signTransaction(request);
    return { hash: keccak256(raw), nonce: request.nonce, raw };
  }

  broadcast(raw: Hex): Promise<Hex> {
    return this.walletClient.sendRawTransaction({ serializedTransaction: raw });
  }

  async waitForReceipt(hash: Hex, timeoutMs: number): Promise<'success' | 'reverted'> {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: timeoutMs });
    // viem resolves with the replacement's receipt when another transaction took the nonce
    if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) throw new Error(`transaction ${hash} was replaced by ${receipt.transactionHash}`);
    return receipt.status;
  }
}

/** viem implementation of {@link DrawChainView}. */
export class ViemDrawChainView implements DrawChainView {
  constructor(
    private readonly publicClient: RunnerPublicClient,
    readonly account: Address,
  ) {}

  async transactionReceipt(hash: Hex): Promise<{ status: 'success' | 'reverted'; blockNumber: bigint } | null> {
    try {
      const r = await this.publicClient.getTransactionReceipt({ hash });
      return { status: r.status, blockNumber: r.blockNumber };
    } catch (err) {
      if (err instanceof BaseError && err.walk((e) => e instanceof TransactionReceiptNotFoundError) !== null) return null;
      throw err;
    }
  }

  async transactionNonce(hash: Hex): Promise<number | null> {
    try {
      return (await this.publicClient.getTransaction({ hash })).nonce;
    } catch (err) {
      if (err instanceof BaseError && err.walk((e) => e instanceof TransactionNotFoundError) !== null) return null;
      throw err;
    }
  }

  nonce(blockTag: 'latest' | 'pending'): Promise<number> {
    return this.publicClient.getTransactionCount({ address: this.account, blockTag });
  }

  blockNumber(): Promise<bigint> {
    return this.publicClient.getBlockNumber({ cacheTime: 0 });
  }
}
