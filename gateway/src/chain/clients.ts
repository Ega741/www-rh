/**
 * Chain access (SPEC §5.4): the `ChainReader` / `ChainWriter` interfaces every worker depends on
 * (so tests can inject fakes), their viem implementations over `http(RPC_URL)`, the deployment
 * resolution (`resolveDeployment` + `CREDIT_DESK_ADDRESS`), and the small transaction queue (one tx
 * at a time, pending nonce, EIP-1559 fees, one retry on `nonce too low`).
 *
 * @module chain/clients
 */
import { CREDIT_DESK_ABI, CREDIT_DESK_EVENT_ITEMS, ERC20_ABI, MANUAL_PRICE_SOURCE_ABI, isCreditDeskEventName, type CreditDeskEventName } from '@beagle/shared/abi';
import { resolveDeployment, type ResolvedDeployment } from '@beagle/shared/addresses';
import { chainById, explorerBaseUrl } from '@beagle/shared/chains';
import {
  BaseError,
  BlockNotFoundError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  TransactionReceiptNotFoundError,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';

/** A decoded `CreditDesk` event log. */
export interface DeskLog {
  eventName: CreditDeskEventName;
  args: Record<string, unknown>;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: number;
}

/** Block header fields the indexer needs. */
export interface BlockInfo {
  number: bigint;
  hash: Hex;
  /** Unix seconds. */
  timestamp: bigint;
}

/** On-chain price failure. */
export class PriceError extends Error {
  override readonly name = 'PriceError';
  constructor(
    readonly code: 'stale' | 'unavailable' | 'rpc',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Receipt facts the drawer's reconciliation needs. */
export interface ReceiptInfo {
  status: 'success' | 'reverted';
  blockNumber: bigint;
}

/** Read-only chain access used by the indexer, the headroom refresher, the drawer and the price service. */
export interface ChainReader {
  getBlockNumber(): Promise<bigint>;
  /** The header of `number`, or `undefined` only when the node has no such block (transport errors throw). */
  getBlock(number: bigint): Promise<BlockInfo | undefined>;
  getLogs(fromBlock: bigint, toBlock: bigint): Promise<DeskLog[]>;
  /** The receipt of `hash`, or `undefined` when the transaction is not (yet) mined (transport errors throw). */
  getTransactionReceipt(hash: Hex): Promise<ReceiptInfo | undefined>;
  /** `desk.quote(amount)`; throws {@link PriceError} on `PriceStale` / `PriceUnavailable`. */
  quote(amount: bigint): Promise<{ usdMicro: bigint; priceE18: bigint; updatedAt: number }>;
  /** `priceSource.latestPrice()` (zeros before the first post). */
  latestPrice(): Promise<{ priceE18: bigint; updatedAt: number }>;
  /** `desk.maxPriceAge()` in seconds. */
  maxPriceAge(): Promise<number>;
  allowance(owner: Address): Promise<bigint>;
  balanceOf(owner: Address): Promise<bigint>;
  /** `ManualPriceSource` bounds (poster). */
  priceSourceBounds(): Promise<{ maxStepBps: number; minInterval: number }>;
}

/** Operator-signed writes. */
export interface ChainWriter {
  readonly address: Address;
  draw(budgetId: bigint, tokens: bigint, receiptHash: Hex): Promise<Hex>;
  postPrice(priceE18: bigint): Promise<Hex>;
  waitForReceipt(hash: Hex, timeoutMs: number): Promise<{ status: 'success' | 'reverted'; blockNumber: bigint }>;
}

/** Everything chain-related the services need. */
export interface ChainContext {
  chainId: number;
  chain: Chain;
  deployment: ResolvedDeployment;
  creditDesk: Address;
  token: { address: Address; symbol: string; decimals: number; nativeBurn: boolean } | undefined;
  priceSource: Address | undefined;
  explorer: string | undefined;
  /** Block the indexer starts at when the DB is empty. */
  startBlock: number;
  reader: ChainReader;
  writer: ChainWriter | undefined;
  publicClient: PublicClient | undefined;
}

/** Thrown when the config names a chain the gateway cannot serve. */
export class ChainConfigError extends Error {
  override readonly name = 'ChainConfigError';
}

/** Resolves the chain definition (known chains, or a generic one for other ids). */
export function chainFor(chainId: number, rpcUrl: string | undefined): Chain {
  const known = chainById(chainId);
  const base =
    known ??
    defineChain({
      id: chainId,
      name: `chain-${chainId}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: rpcUrl === undefined ? [] : [rpcUrl] } },
    });
  return rpcUrl === undefined ? base : { ...base, rpcUrls: { ...base.rpcUrls, default: { ...base.rpcUrls.default, http: [rpcUrl] } } };
}

/** Walks a viem error for a custom revert and returns its name. */
export function revertName(e: unknown): string | undefined {
  if (!(e instanceof BaseError)) return undefined;
  const reverted = e.walk((err) => err instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError) return reverted.data?.errorName ?? reverted.reason;
  return undefined;
}

function toPriceError(e: unknown): PriceError {
  const name = revertName(e);
  if (name === 'PriceStale') return new PriceError('stale', 'on-chain price is stale', { cause: e });
  if (name === 'PriceUnavailable') return new PriceError('unavailable', 'on-chain price is unavailable', { cause: e });
  return new PriceError('rpc', `price read failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
}

/** Serializes operator transactions: pending nonce, EIP-1559 fees, one retry on `nonce too low`. */
export class TxQueue {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly publicClient: PublicClient,
    private readonly account: PrivateKeyAccount,
    private readonly logger: Logger,
  ) {}

  /** Runs `send` with a fresh nonce and fee estimate, one job at a time. */
  enqueue(send: (tx: { nonce: number; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }) => Promise<Hex>): Promise<Hex> {
    const job = this.tail.then(
      () => this.run(send),
      () => this.run(send),
    );
    this.tail = job.catch(() => undefined);
    return job;
  }

  private async run(send: (tx: { nonce: number; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }) => Promise<Hex>): Promise<Hex> {
    const attempt = async (): Promise<Hex> => {
      const nonce = await this.publicClient.getTransactionCount({ address: this.account.address, blockTag: 'pending' });
      let fees: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint } = {};
      try {
        const est = await this.publicClient.estimateFeesPerGas();
        if (est.maxFeePerGas !== undefined && est.maxPriorityFeePerGas !== undefined) fees = { maxFeePerGas: est.maxFeePerGas, maxPriorityFeePerGas: est.maxPriorityFeePerGas };
      } catch (e) {
        this.logger.debug('estimateFeesPerGas failed; letting the node price the tx', { error: e });
      }
      return send({ nonce, ...fees });
    };
    try {
      return await attempt();
    } catch (e) {
      if (e instanceof Error && /nonce too low|already known|replacement transaction underpriced/i.test(e.message)) {
        this.logger.warn('tx nonce conflict; retrying once', { error: e.message });
        return attempt();
      }
      throw e;
    }
  }
}

/** viem-backed {@link ChainReader}. */
export function createViemReader(publicClient: PublicClient, creditDesk: Address, token: Address | undefined, priceSource: Address | undefined): ChainReader {
  return {
    getBlockNumber: () => publicClient.getBlockNumber({ cacheTime: 0 }),
    async getBlock(number) {
      try {
        const b = await publicClient.getBlock({ blockNumber: number });
        return { number: b.number, hash: b.hash, timestamp: b.timestamp };
      } catch (e) {
        // Only "no such block" is an answer; a transport failure must not look like a missing block
        // (the indexer's reorg guard would otherwise rewind on every RPC hiccup).
        if (e instanceof BaseError && e.walk((err) => err instanceof BlockNotFoundError) instanceof BlockNotFoundError) return undefined;
        throw e;
      }
    },
    async getTransactionReceipt(hash) {
      try {
        const r = await publicClient.getTransactionReceipt({ hash });
        return { status: r.status, blockNumber: r.blockNumber };
      } catch (e) {
        if (e instanceof BaseError && e.walk((err) => err instanceof TransactionReceiptNotFoundError) instanceof TransactionReceiptNotFoundError) return undefined;
        throw e;
      }
    },
    async getLogs(fromBlock, toBlock) {
      const logs = await publicClient.getLogs({ address: creditDesk, events: CREDIT_DESK_EVENT_ITEMS, fromBlock, toBlock, strict: true });
      const out: DeskLog[] = [];
      for (const log of logs) {
        if (log.blockNumber === null || log.blockHash === null || log.transactionHash === null || log.logIndex === null) continue;
        const name = String(log.eventName);
        if (!isCreditDeskEventName(name)) continue;
        out.push({ eventName: name, args: log.args as Record<string, unknown>, blockNumber: log.blockNumber, blockHash: log.blockHash, transactionHash: log.transactionHash, logIndex: log.logIndex });
      }
      return out;
    },
    async quote(amount) {
      try {
        const [usdMicro, priceE18, updatedAt] = await publicClient.readContract({ address: creditDesk, abi: CREDIT_DESK_ABI, functionName: 'quote', args: [amount] });
        return { usdMicro, priceE18, updatedAt: Number(updatedAt) };
      } catch (e) {
        throw toPriceError(e);
      }
    },
    async latestPrice() {
      const source = priceSource ?? (await publicClient.readContract({ address: creditDesk, abi: CREDIT_DESK_ABI, functionName: 'priceSource' }));
      if (source === undefined || /^0x0{40}$/.test(source)) return { priceE18: 0n, updatedAt: 0 };
      try {
        const [priceE18, updatedAt] = await publicClient.readContract({ address: source, abi: MANUAL_PRICE_SOURCE_ABI, functionName: 'latestPrice' });
        return { priceE18, updatedAt: Number(updatedAt) };
      } catch (e) {
        throw toPriceError(e);
      }
    },
    async maxPriceAge() {
      return Number(await publicClient.readContract({ address: creditDesk, abi: CREDIT_DESK_ABI, functionName: 'maxPriceAge' }));
    },
    async allowance(owner) {
      if (token === undefined) throw new ChainConfigError('token address unknown');
      return publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [owner, creditDesk] });
    },
    async balanceOf(owner) {
      if (token === undefined) throw new ChainConfigError('token address unknown');
      return publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] });
    },
    async priceSourceBounds() {
      const source = priceSource ?? (await publicClient.readContract({ address: creditDesk, abi: CREDIT_DESK_ABI, functionName: 'priceSource' }));
      const [maxStepBps, minInterval] = await Promise.all([
        publicClient.readContract({ address: source, abi: MANUAL_PRICE_SOURCE_ABI, functionName: 'maxStepBps' }),
        publicClient.readContract({ address: source, abi: MANUAL_PRICE_SOURCE_ABI, functionName: 'minInterval' }),
      ]);
      return { maxStepBps: Number(maxStepBps), minInterval: Number(minInterval) };
    },
  };
}

/** viem-backed {@link ChainWriter} using a {@link TxQueue}. */
export function createViemWriter(publicClient: PublicClient, walletClient: WalletClient, account: PrivateKeyAccount, creditDesk: Address, priceSource: Address | undefined, chain: Chain, logger: Logger): ChainWriter {
  const queue = new TxQueue(publicClient, account, logger);
  return {
    address: account.address,
    draw(budgetId, tokens, receiptHash) {
      return queue.enqueue(async (tx) => {
        const args = [budgetId, tokens, receiptHash] as const;
        await publicClient.simulateContract({ address: creditDesk, abi: CREDIT_DESK_ABI, functionName: 'draw', args, account, chain });
        return walletClient.writeContract({ address: creditDesk, abi: CREDIT_DESK_ABI, functionName: 'draw', args, account, chain, ...tx });
      });
    },
    postPrice(priceE18) {
      return queue.enqueue(async (tx) => {
        if (priceSource === undefined) throw new ChainConfigError('price source address unknown');
        await publicClient.simulateContract({ address: priceSource, abi: MANUAL_PRICE_SOURCE_ABI, functionName: 'post', args: [priceE18], account, chain });
        return walletClient.writeContract({ address: priceSource, abi: MANUAL_PRICE_SOURCE_ABI, functionName: 'post', args: [priceE18], account, chain, ...tx });
      });
    },
    async waitForReceipt(hash, timeoutMs) {
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: timeoutMs, pollingInterval: 500 });
      return { status: receipt.status, blockNumber: receipt.blockNumber };
    },
  };
}

/**
 * Builds the {@link ChainContext} from the config, or `undefined` when `RPC_URL` is unset. Throws
 * {@link ChainConfigError} when the desk address is unknown for the chain.
 */
export function createChainContext(config: Config, logger: Logger): ChainContext | undefined {
  const { chainId, rpcUrl } = config.chain;
  const deployment = resolveDeployment(chainId, { creditDesk: config.chain.creditDeskAddress, priceSource: config.poster.priceSourceAddress });
  if (rpcUrl === undefined) {
    logger.warn('RPC_URL is unset: chain workers, price and quotes are disabled');
    return undefined;
  }
  if (deployment.creditDesk === undefined) throw new ChainConfigError(`no CreditDesk deployment known for chain ${chainId}; set CREDIT_DESK_ADDRESS`);
  const chain = chainFor(chainId, rpcUrl);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl), batch: { multicall: false } });
  const token =
    deployment.token === undefined
      ? undefined
      : { address: deployment.token, symbol: deployment.tokenSymbol ?? 'TOKEN', decimals: deployment.tokenDecimals ?? 18, nativeBurn: deployment.nativeBurn ?? false };
  const reader = createViemReader(publicClient, deployment.creditDesk, deployment.token, deployment.priceSource);
  let writer: ChainWriter | undefined;
  if (config.operator.privateKey !== undefined) {
    const account = privateKeyToAccount(config.operator.privateKey);
    const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
    writer = createViemWriter(publicClient, walletClient, account, deployment.creditDesk, deployment.priceSource, chain, logger);
  }
  return {
    chainId,
    chain,
    deployment,
    creditDesk: deployment.creditDesk,
    token,
    priceSource: deployment.priceSource,
    explorer: explorerBaseUrl(chain),
    startBlock: config.chain.startBlock ?? deployment.deployBlock ?? 0,
    reader,
    writer,
    publicClient,
  };
}
