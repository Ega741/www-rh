/**
 * Wallet side of the agent tools (SPEC §6.1, §3.4): the {@link WalletExecutor} interface, a viem
 * implementation that signs with an agent private key, and {@link buildUnsignedSteps} for agents
 * that hold their own wallet and only need calldata.
 *
 * Both purchase paths are two-step: `token.approve(desk, amount)` (skipped by the executor when the
 * allowance already covers it) followed by `desk.burnForCredit(workspace, amount)` or
 * `desk.openBudget(workspace, cap, deadline)`.
 *
 * @module wallet
 */
import { CREDIT_DESK_ABI, ERC20_ABI } from '@beagle/shared/abi';
import { chainById } from '@beagle/shared/chains';
import { formatTokenAmount } from '@beagle/shared/credit';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type TransactionReceipt,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

/** Input of {@link WalletExecutor.buyCompute}. */
export interface BuyComputeParams {
  /** Workspace (wallet address) to credit. */
  workspace: Address;
  /** Raw token units to burn. */
  tokens: bigint;
}

/** Result of {@link WalletExecutor.buyCompute}. */
export interface BuyComputeResult {
  txHash: Hex;
  /** `receiptId` of the `CreditPurchased` event when it could be decoded from the receipt. */
  receiptId?: bigint;
  /** Hash of the `approve` transaction when one was needed. */
  approveTxHash?: Hex;
}

/** Input of {@link WalletExecutor.openBudget}. */
export interface OpenBudgetParams {
  /** Workspace the budget pays for. */
  workspace: Address;
  /** Cap in raw token units (`uint128`). */
  cap: bigint;
  /** Unix seconds; must be in the future and at most 30 days ahead (`MAX_BUDGET_DURATION`). */
  deadline: bigint;
}

/** Result of {@link WalletExecutor.openBudget}. */
export interface OpenBudgetResult {
  txHash: Hex;
  budgetId: bigint;
  approveTxHash?: Hex;
}

/**
 * Executes the two wallet flows with a signing key. `address` (when known) is the payer / budget
 * owner and the default workspace of the MCP tools.
 */
export interface WalletExecutor {
  /** The signing account, if the executor knows it. */
  readonly address?: Address;
  /** `approve` (if short) + `burnForCredit`; resolves after the burn is mined. */
  buyCompute(params: BuyComputeParams): Promise<BuyComputeResult>;
  /** `approve` (if short) + `openBudget`; resolves after the budget is mined. */
  openBudget(params: OpenBudgetParams): Promise<OpenBudgetResult>;
}

/** The two contract addresses the wallet flows need (a subset of `@beagle/shared` `Deployment`). */
export interface WalletDeployment {
  creditDesk: Address;
  token: Address;
}

/** Thrown by the executor and the step builder for invalid input or failed transactions. */
export class WalletError extends Error {
  override readonly name = 'WalletError';
  /** `invalid_address`, `tx_reverted`, `event_missing`, `invalid_amount`, `chain_mismatch`, `rpc_error`. */
  readonly code: string;
  readonly txHash?: Hex;

  constructor(code: string, message: string, options: { txHash?: Hex; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    if (options.txHash !== undefined) this.txHash = options.txHash;
  }
}

function checksum(label: string, value: string): Address {
  if (!isAddress(value, { strict: false })) throw new WalletError('invalid_address', `${label} is not an address: ${JSON.stringify(value)}`);
  return getAddress(value);
}

function assertPositive(label: string, value: bigint): void {
  if (typeof value !== 'bigint' || value <= 0n) throw new WalletError('invalid_amount', `${label} must be a positive bigint (got ${String(value)})`);
}

const UINT128_MAX = (1n << 128n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;

// ---------------------------------------------------------------------------------------------
// Unsigned steps

/** One transaction an external wallet must sign and send, in order. */
export interface UnsignedStep {
  to: Address;
  data: Hex;
  /** Always `'0'`: neither flow sends native value. */
  value: '0';
  /** Human-readable purpose, e.g. `approve 1000 BEAGLE for the CreditDesk`. */
  description: string;
}

/** The unsigned transaction request returned by the wallet tools when no signing key is configured. */
export interface UnsignedTransactionRequest {
  unsigned: true;
  chainId: number;
  steps: UnsignedStep[];
}

/** Common fields of {@link UnsignedStepsInput}. */
interface UnsignedStepsBase {
  chainId: number;
  deployment: WalletDeployment;
  workspace: Address;
  /** Token symbol for the descriptions (default `BEAGLE`). */
  tokenSymbol?: string;
  /** Token decimals for the descriptions (default 18). */
  tokenDecimals?: number;
}

/** Input of {@link buildUnsignedSteps}. */
export type UnsignedStepsInput =
  | (UnsignedStepsBase & { action: 'buyCompute'; tokens: bigint })
  | (UnsignedStepsBase & { action: 'openBudget'; cap: bigint; deadline: bigint });

/**
 * Encodes `approve` + `burnForCredit` or `approve` + `openBudget` as calldata for an external
 * wallet. The approve step is always included (the builder cannot read the allowance); a wallet
 * that already holds a sufficient allowance may skip it.
 */
export function buildUnsignedSteps(input: UnsignedStepsInput): UnsignedTransactionRequest {
  const desk = checksum('deployment.creditDesk', input.deployment.creditDesk);
  const token = checksum('deployment.token', input.deployment.token);
  const workspace = checksum('workspace', input.workspace);
  const symbol = input.tokenSymbol ?? 'BEAGLE';
  const decimals = input.tokenDecimals ?? 18;
  const amount = input.action === 'buyCompute' ? input.tokens : input.cap;
  assertPositive(input.action === 'buyCompute' ? 'tokens' : 'cap', amount);
  const human = `${formatTokenAmount(amount, decimals)} ${symbol}`;

  const approve: UnsignedStep = {
    to: token,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [desk, amount] }),
    value: '0',
    description: `approve ${human} for the CreditDesk ${desk} (skip if your allowance already covers it)`,
  };

  if (input.action === 'buyCompute') {
    const burn: UnsignedStep = {
      to: desk,
      data: encodeFunctionData({ abi: CREDIT_DESK_ABI, functionName: 'burnForCredit', args: [workspace, amount] }),
      value: '0',
      description: `burnForCredit: burn ${human} and credit workspace ${workspace} with its USD value`,
    };
    return { unsigned: true, chainId: input.chainId, steps: [approve, burn] };
  }

  if (amount > UINT128_MAX) throw new WalletError('invalid_amount', 'cap exceeds uint128');
  if (input.deadline <= 0n || input.deadline > UINT64_MAX) throw new WalletError('invalid_amount', 'deadline must fit uint64 and be > 0');
  const open: UnsignedStep = {
    to: desk,
    data: encodeFunctionData({ abi: CREDIT_DESK_ABI, functionName: 'openBudget', args: [workspace, amount, input.deadline] }),
    value: '0',
    description: `openBudget: let the operator draw up to ${human} for workspace ${workspace} until ${new Date(Number(input.deadline) * 1000).toISOString()}`,
  };
  return { unsigned: true, chainId: input.chainId, steps: [approve, open] };
}

// ---------------------------------------------------------------------------------------------
// viem executor

/** Options of {@link createViemWalletExecutor}. */
export interface ViemWalletExecutorOptions {
  /** `0x`-prefixed 32-byte private key of the agent wallet. */
  privateKey: Hex;
  /** JSON-RPC URL; defaults to the chain's first public RPC from `@beagle/shared/chains`. */
  rpcUrl?: string;
  chainId: number;
  deployment: WalletDeployment;
  /** Custom viem transport (tests); overrides `rpcUrl`. */
  transport?: Transport;
  /** Receipt wait timeout in ms (default 120 000). */
  receiptTimeoutMs?: number;
  /** Receipt polling interval in ms (default 1 000). */
  pollingIntervalMs?: number;
}

function resolveChain(chainId: number, rpcUrl: string | undefined): Chain {
  const known = chainById(chainId);
  if (known !== undefined) {
    if (rpcUrl === undefined) return known;
    return { ...known, rpcUrls: { ...known.rpcUrls, default: { http: [rpcUrl] } } };
  }
  if (rpcUrl === undefined) throw new WalletError('rpc_error', `chain ${chainId} is not in @beagle/shared/chains; pass rpcUrl`);
  return defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

function decodeDeskEvent<N extends 'CreditPurchased' | 'BudgetOpened'>(
  receipt: TransactionReceipt,
  desk: Address,
  eventName: N,
): { args: Record<string, unknown> } | undefined {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== desk.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: CREDIT_DESK_ABI, data: log.data, topics: log.topics, eventName });
      return { args: decoded.args as Record<string, unknown> };
    } catch {
      // not the event we want; keep scanning
    }
  }
  return undefined;
}

/**
 * A {@link WalletExecutor} signing with `privateKey` through viem. Each write is simulated first
 * (so contract errors such as `BurnTooSmall` surface as readable messages), sent, and awaited.
 */
export function createViemWalletExecutor(options: ViemWalletExecutorOptions): WalletExecutor {
  const account: PrivateKeyAccount = privateKeyToAccount(options.privateKey);
  const chain = resolveChain(options.chainId, options.rpcUrl);
  const transport = options.transport ?? http(options.rpcUrl ?? chain.rpcUrls.default.http[0]);
  const desk = checksum('deployment.creditDesk', options.deployment.creditDesk);
  const token = checksum('deployment.token', options.deployment.token);
  const pollingInterval = options.pollingIntervalMs ?? 1_000;
  const publicClient: PublicClient = createPublicClient({ chain, transport, pollingInterval });
  const walletClient: WalletClient<Transport, Chain, PrivateKeyAccount> = createWalletClient({ account, chain, transport });
  const receiptTimeout = options.receiptTimeoutMs ?? 120_000;

  async function waitMined(hash: Hex, label: string): Promise<TransactionReceipt> {
    let receipt: TransactionReceipt;
    try {
      receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: receiptTimeout, pollingInterval });
    } catch (error) {
      throw new WalletError('rpc_error', `${label}: waiting for receipt ${hash} failed: ${errorMessage(error)}`, { txHash: hash, cause: error });
    }
    if (receipt.status !== 'success') throw new WalletError('tx_reverted', `${label} reverted (tx ${hash})`, { txHash: hash });
    return receipt;
  }

  async function ensureAllowance(amount: bigint): Promise<Hex | undefined> {
    let allowance: bigint;
    try {
      allowance = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, desk] });
    } catch (error) {
      throw new WalletError('rpc_error', `reading allowance failed: ${errorMessage(error)}`, { cause: error });
    }
    if (allowance >= amount) return undefined;
    const hash = await send(() =>
      walletClient.writeContract({ address: token, abi: ERC20_ABI, functionName: 'approve', args: [desk, amount] }),
      'approve',
    );
    await waitMined(hash, 'approve');
    return hash;
  }

  async function send(write: () => Promise<Hex>, label: string): Promise<Hex> {
    try {
      return await write();
    } catch (error) {
      throw new WalletError('tx_failed', `${label} failed: ${errorMessage(error)}`, { cause: error });
    }
  }

  return {
    address: account.address,

    async buyCompute({ workspace, tokens }) {
      const ws = checksum('workspace', workspace);
      assertPositive('tokens', tokens);
      const approveTxHash = await ensureAllowance(tokens);
      const { request } = await simulate(
        () => publicClient.simulateContract({ account, address: desk, abi: CREDIT_DESK_ABI, functionName: 'burnForCredit', args: [ws, tokens] }),
        'burnForCredit',
      );
      const txHash = await send(() => walletClient.writeContract(request), 'burnForCredit');
      const receipt = await waitMined(txHash, 'burnForCredit');
      const event = decodeDeskEvent(receipt, desk, 'CreditPurchased');
      const receiptId = event?.args['receiptId'];
      return {
        txHash,
        ...(typeof receiptId === 'bigint' ? { receiptId } : {}),
        ...(approveTxHash === undefined ? {} : { approveTxHash }),
      };
    },

    async openBudget({ workspace, cap, deadline }) {
      const ws = checksum('workspace', workspace);
      assertPositive('cap', cap);
      if (cap > UINT128_MAX) throw new WalletError('invalid_amount', 'cap exceeds uint128');
      if (deadline <= 0n || deadline > UINT64_MAX) throw new WalletError('invalid_amount', 'deadline must fit uint64 and be > 0');
      const approveTxHash = await ensureAllowance(cap);
      const { request } = await simulate(
        () => publicClient.simulateContract({ account, address: desk, abi: CREDIT_DESK_ABI, functionName: 'openBudget', args: [ws, cap, deadline] }),
        'openBudget',
      );
      const txHash = await send(() => walletClient.writeContract(request), 'openBudget');
      const receipt = await waitMined(txHash, 'openBudget');
      const event = decodeDeskEvent(receipt, desk, 'BudgetOpened');
      const budgetId = event?.args['budgetId'];
      if (typeof budgetId !== 'bigint') {
        throw new WalletError('event_missing', `openBudget mined (tx ${txHash}) but no BudgetOpened event was found in the receipt`, { txHash });
      }
      return { txHash, budgetId, ...(approveTxHash === undefined ? {} : { approveTxHash }) };
    },
  };
}

async function simulate<T>(run: () => Promise<T>, label: string): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new WalletError('simulation_failed', `${label} would revert: ${errorMessage(error)}`, { cause: error });
  }
}

/** The most specific message viem offers (`shortMessage` of a `BaseError`), else `message`. */
export function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const e = error as { shortMessage?: unknown; message?: unknown; metaMessages?: unknown };
    const short = typeof e.shortMessage === 'string' ? e.shortMessage : undefined;
    const meta = Array.isArray(e.metaMessages) ? e.metaMessages.filter((m): m is string => typeof m === 'string') : [];
    const custom = meta.find((m) => /^Error: /.test(m));
    if (short !== undefined) return custom === undefined ? short : `${short} (${custom.replace(/^Error: /, '')})`;
    if (typeof e.message === 'string') return e.message;
  }
  return String(error);
}
