/**
 * Wallet side of the agent tools (SPEC §6.1, §3.4): the {@link WalletExecutor} interface, a viem
 * implementation that signs with an agent private key, and {@link buildUnsignedSteps} for agents
 * that hold their own wallet and only need calldata.
 *
 * Both purchase paths are two-step: `token.approve(desk, …)` followed by `desk.burnForCreditMin(workspace,
 * amount, minUsdMicro)` (or plain `burnForCredit` when no quote is at hand) or `desk.openBudget(workspace, cap,
 * deadline)`. The executor approves **cumulatively** (`allowance + amount`): the same `allowance(owner, desk)`
 * backs every open budget of the wallet (headroom = min(cap − drawn, allowance, balance)) and a burn spends it,
 * so approving exactly `amount` would silently shrink or stall those budgets. Only an effectively unlimited
 * allowance is left alone.
 *
 * **Credit floor.** A burn is final, and a price post can land between the quote shown to the caller and the
 * transaction. Every burn our own clients initiate therefore carries `minUsdMicro` ({@link creditFloor}:
 * `quote − ceil(quote · toleranceBps / 10 000)`, default 100 bps): the desk reverts `SlippageExceeded(usdMicro,
 * minUsdMicro)` instead of crediting less, and a reverted burn costs only gas. `0` disables the floor on chain.
 *
 * @module wallet
 */
import { CREDIT_DESK_ABI, ERC20_ABI } from '@beagle/shared/abi';
import { chainById } from '@beagle/shared/chains';
import { BPS_DENOMINATOR, ceilDiv, formatTokenAmount, formatUsdMicro } from '@beagle/shared/credit';
import {
  ChainMismatchError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
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
  type WriteContractParameters,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

/** Input of {@link WalletExecutor.buyCompute}. */
export interface BuyComputeParams {
  /** Workspace (wallet address) to credit. */
  workspace: Address;
  /** Raw token units to burn. */
  tokens: bigint;
  /**
   * Credit floor in µUSD (see {@link creditFloor}). When set the executor calls `burnForCreditMin`, which
   * reverts `SlippageExceeded` (surfaced as `WalletError('slippage_exceeded')`, nothing burned) if the desk's
   * quote at inclusion is below it; `0` keeps the call but disables the floor. Omitted → plain `burnForCredit`.
   */
  minUsdMicro?: bigint;
}

/** Default slippage tolerance of the credit floor, in basis points (1 %). */
export const DEFAULT_TOLERANCE_BPS = 100;
/** Largest tolerance a caller may pick (50 %): beyond that the floor stops meaning anything. */
export const MAX_TOLERANCE_BPS = 5000;

/**
 * The credit floor for a burn quoted at `quotedUsdMicro`:
 * `quotedUsdMicro − ceil(quotedUsdMicro · toleranceBps / 10 000)` (the tolerance is rounded *up*, so the
 * floor is never stricter than the stated percentage). `toleranceBps` is an integer in
 * `[0, MAX_TOLERANCE_BPS]`, default {@link DEFAULT_TOLERANCE_BPS}; `0` means "exactly the quote".
 */
export function creditFloor(quotedUsdMicro: bigint, toleranceBps: number = DEFAULT_TOLERANCE_BPS): bigint {
  if (typeof quotedUsdMicro !== 'bigint' || quotedUsdMicro < 0n) {
    throw new WalletError('invalid_amount', `quotedUsdMicro must be a non-negative bigint (got ${String(quotedUsdMicro)})`);
  }
  if (!Number.isInteger(toleranceBps) || toleranceBps < 0 || toleranceBps > MAX_TOLERANCE_BPS) {
    throw new WalletError('invalid_tolerance', `toleranceBps must be an integer in [0, ${MAX_TOLERANCE_BPS}] (got ${String(toleranceBps)})`);
  }
  return quotedUsdMicro - ceilDiv(quotedUsdMicro * BigInt(toleranceBps), BPS_DENOMINATOR);
}

/** Result of {@link WalletExecutor.buyCompute}. */
export interface BuyComputeResult {
  txHash: Hex;
  /** `receiptId` of the `CreditPurchased` event when it could be decoded from the receipt. */
  receiptId?: bigint;
  /**
   * `usdMicro` emitted by `CreditPurchased`: the exact credit the gateway will book (SPEC §0, §9).
   * Present when the event could be decoded.
   */
  usdMicro?: bigint;
  /** `priceE18` the contract read for this burn, from the same event. */
  priceE18?: bigint;
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
  /** `approve` (if short) + `burnForCreditMin` (`burnForCredit` without `minUsdMicro`); resolves after the burn is mined. */
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
  /**
   * `invalid_address`, `invalid_amount`, `invalid_tolerance`, `chain_mismatch`, `rpc_error`,
   * `simulation_failed`, `slippage_exceeded` (the desk's quote fell below the credit floor; nothing burned),
   * `tx_failed`, `tx_reverted`, `event_missing`, `wallet_unavailable` (a lazy executor could not be set up).
   */
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

const UINT256_MAX = (1n << 256n) - 1n;
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
  | (UnsignedStepsBase & {
      action: 'buyCompute';
      tokens: bigint;
      /** Credit floor in µUSD (see {@link creditFloor}); with it the burn step is `burnForCreditMin`, without it plain `burnForCredit`. */
      minUsdMicro?: bigint;
    })
  | (UnsignedStepsBase & { action: 'openBudget'; cap: bigint; deadline: bigint });

function assertUint256(label: string, value: bigint): void {
  if (typeof value !== 'bigint' || value < 0n || value > UINT256_MAX) throw new WalletError('invalid_amount', `${label} must be a bigint that fits uint256 (got ${String(value)})`);
}

/**
 * Encodes `approve` + `burnForCreditMin` (or `burnForCredit` when no `minUsdMicro` is given, i.e. no
 * quote was available) or `approve` + `openBudget` as calldata for an external wallet. The approve step
 * is always included (the builder cannot read the allowance) and approves exactly `amount`; a wallet with
 * open budgets should approve `current allowance + amount` instead, because the budgets' headroom is
 * bounded by that same allowance and a burn spends it.
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
    description: `approve ${human} for the CreditDesk ${desk} (if this wallet has open budgets, approve your current allowance + ${human} instead: budgets draw from the same allowance and a burn spends it)`,
  };

  if (input.action === 'buyCompute') {
    const credit = `burn ${human} and credit workspace ${workspace} with its USD value at the price the contract reads when mined`;
    let burn: UnsignedStep;
    if (input.minUsdMicro === undefined) {
      burn = {
        to: desk,
        data: encodeFunctionData({ abi: CREDIT_DESK_ABI, functionName: 'burnForCredit', args: [workspace, amount] }),
        value: '0',
        description: `burnForCredit: ${credit} (no credit floor: the burn is final at whatever that price is)`,
      };
    } else {
      assertUint256('minUsdMicro', input.minUsdMicro);
      burn = {
        to: desk,
        data: encodeFunctionData({ abi: CREDIT_DESK_ABI, functionName: 'burnForCreditMin', args: [workspace, amount, input.minUsdMicro] }),
        value: '0',
        description:
          `burnForCreditMin: ${credit}, with a credit floor of ${formatUsdMicro(input.minUsdMicro)} (${input.minUsdMicro.toString()} µUSD): ` +
          'if a price change lands first and the burn would credit less, the transaction reverts with SlippageExceeded and costs only gas (nothing is burned); re-quote and send a new one',
      };
    }
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
      // `eventName` only narrows viem's types; the decoder picks the event by topic, so compare the name.
      const decoded = decodeEventLog({ abi: CREDIT_DESK_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName !== eventName) continue;
      return { args: decoded.args as Record<string, unknown> };
    } catch {
      // not a desk event we know; keep scanning
    }
  }
  return undefined;
}

/** Options of {@link createLazyWalletExecutor}. */
export interface LazyWalletExecutorOptions {
  /** The signing address, known up front (e.g. from `privateKeyToAccount`) without any network call. */
  address: Address;
  /**
   * Builds the real executor; called on the first wallet operation and again on every later
   * operation until one build succeeds. Its failures surface as `WalletError('wallet_unavailable')`.
   */
  build: () => Promise<WalletExecutor>;
}

/**
 * A {@link WalletExecutor} that defers building the real one until a wallet tool is called, so a
 * stdio server can connect its transport before the gateway is reachable and recover from a
 * gateway that is down at startup. `address` is available immediately for workspace defaulting.
 */
export function createLazyWalletExecutor(options: LazyWalletExecutorOptions): WalletExecutor {
  const address = checksum('address', options.address);
  let inner: WalletExecutor | undefined;
  async function resolve(): Promise<WalletExecutor> {
    if (inner !== undefined) return inner;
    try {
      inner = await options.build();
    } catch (error) {
      throw new WalletError(
        'wallet_unavailable',
        `the agent wallet could not be set up (${errorMessage(error)}); the purchase was not attempted. Retry once the gateway is reachable, or sign the unsigned steps yourself.`,
        { cause: error },
      );
    }
    return inner;
  }
  return {
    address,
    buyCompute: async (params) => (await resolve()).buyCompute(params),
    openBudget: async (params) => (await resolve()).openBudget(params),
  };
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

  /**
   * viem signs with `chain.id` without asking the node, so a node on another chain (a wrong
   * `BEAGLE_RPC_URL`) would only surface as an opaque rejection of the raw transaction. Check once,
   * before the first transaction, and remember a match.
   */
  let chainVerified = false;
  async function assertChain(): Promise<void> {
    if (chainVerified) return;
    let actual: number;
    try {
      actual = await publicClient.getChainId();
    } catch (error) {
      throw new WalletError('rpc_error', `reading the chain id failed: ${errorMessage(error)}`, { cause: error });
    }
    if (actual !== options.chainId) {
      throw new WalletError('chain_mismatch', `the RPC node is on chain ${actual} but the gateway's CreditDesk is on chain ${options.chainId}; check BEAGLE_RPC_URL`);
    }
    chainVerified = true;
  }

  /**
   * Waits for `hash` and returns the receipt. A reverted transaction throws `tx_reverted`, unless
   * `diagnoseRevert` (which may replay the call at the receipt's block to learn the reason) returns a
   * more specific error; its own failures are ignored.
   */
  async function waitMined(hash: Hex, label: string, diagnoseRevert?: (receipt: TransactionReceipt) => Promise<WalletError | undefined>): Promise<TransactionReceipt> {
    let receipt: TransactionReceipt;
    try {
      receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: receiptTimeout, pollingInterval });
    } catch (error) {
      throw new WalletError('rpc_error', `${label}: waiting for receipt ${hash} failed: ${errorMessage(error)}`, { txHash: hash, cause: error });
    }
    if (receipt.status !== 'success') {
      const diagnosed = diagnoseRevert === undefined ? undefined : await diagnoseRevert(receipt).catch(() => undefined);
      throw diagnosed ?? new WalletError('tx_reverted', `${label} reverted (tx ${hash})`, { txHash: hash });
    }
    return receipt;
  }

  /**
   * Approves `allowance + amount` so the pre-existing allowance (which every open budget of this
   * wallet draws from) survives the burn / stays available next to the new budget's cap. Skipped
   * only when the allowance is effectively unlimited (the sum would not fit `uint256`).
   */
  async function ensureAllowance(amount: bigint): Promise<Hex | undefined> {
    let allowance: bigint;
    try {
      allowance = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, desk] });
    } catch (error) {
      throw new WalletError('rpc_error', `reading allowance failed: ${errorMessage(error)}`, { cause: error });
    }
    const target = allowance + amount;
    if (target > UINT256_MAX) return undefined;
    const hash = await send(() =>
      walletClient.writeContract({ address: token, abi: ERC20_ABI, functionName: 'approve', args: [desk, target] }),
      'approve',
    );
    await waitMined(hash, 'approve');
    return hash;
  }

  async function send(write: () => Promise<Hex>, label: string): Promise<Hex> {
    try {
      return await write();
    } catch (error) {
      if (error instanceof ChainMismatchError || (error instanceof Error && error.name === 'ChainMismatchError')) {
        throw new WalletError('chain_mismatch', `${label}: ${errorMessage(error)}`, { cause: error });
      }
      throw new WalletError('tx_failed', `${label} failed: ${errorMessage(error)}`, { cause: error });
    }
  }

  return {
    address: account.address,

    async buyCompute({ workspace, tokens, minUsdMicro }) {
      const ws = checksum('workspace', workspace);
      assertPositive('tokens', tokens);
      if (minUsdMicro !== undefined) assertUint256('minUsdMicro', minUsdMicro);
      await assertChain();
      const approveTxHash = await ensureAllowance(tokens);
      // Plain `burnForCredit` only when the caller has no quote to protect; our own tools always pass a floor.
      // (Two literal calls rather than one with a spread union: viem's overloads need the exact arg tuple.)
      const label = minUsdMicro === undefined ? 'burnForCredit' : 'burnForCreditMin';
      const simulateBurn = async (blockNumber?: bigint): Promise<{ request: WriteContractParameters }> => {
        const at = blockNumber === undefined ? {} : { blockNumber };
        if (minUsdMicro === undefined) {
          const { request } = await publicClient.simulateContract({ account, address: desk, abi: CREDIT_DESK_ABI, functionName: 'burnForCredit', args: [ws, tokens], ...at });
          return { request };
        }
        const { request } = await publicClient.simulateContract({ account, address: desk, abi: CREDIT_DESK_ABI, functionName: 'burnForCreditMin', args: [ws, tokens, minUsdMicro], ...at });
        return { request };
      };
      const { request } = await simulate(() => simulateBurn(), label, { onSlippage: (s) => slippageError(s, label) });
      const txHash = await send(() => walletClient.writeContract(request), label);
      const receipt = await waitMined(txHash, label, async (reverted) => {
        if (minUsdMicro === undefined) return undefined;
        // The simulation passed, the mined transaction did not: replay it against the state of its block
        // to tell a price move (SlippageExceeded) from anything else. Either way only gas was spent.
        try {
          await simulateBurn(reverted.blockNumber);
        } catch (error) {
          const slippage = decodeSlippage(error);
          if (slippage !== undefined) return slippageError(slippage, label, txHash);
        }
        return new WalletError(
          'tx_reverted',
          `${label} reverted (tx ${txHash}); the simulation had passed, so most likely the desk's quote fell below the credit floor of ${minUsdMicro.toString()} µUSD between simulation and inclusion. Only gas was spent, nothing was burned: re-quote and retry, or allow a wider tolerance.`,
          { txHash },
        );
      });
      const event = decodeDeskEvent(receipt, desk, 'CreditPurchased');
      const receiptId = event?.args['receiptId'];
      const usdMicro = event?.args['usdMicro'];
      const priceE18 = event?.args['priceE18'];
      return {
        txHash,
        ...(typeof receiptId === 'bigint' ? { receiptId } : {}),
        ...(typeof usdMicro === 'bigint' ? { usdMicro } : {}),
        ...(typeof priceE18 === 'bigint' ? { priceE18 } : {}),
        ...(approveTxHash === undefined ? {} : { approveTxHash }),
      };
    },

    async openBudget({ workspace, cap, deadline }) {
      const ws = checksum('workspace', workspace);
      assertPositive('cap', cap);
      if (cap > UINT128_MAX) throw new WalletError('invalid_amount', 'cap exceeds uint128');
      if (deadline <= 0n || deadline > UINT64_MAX) throw new WalletError('invalid_amount', 'deadline must fit uint64 and be > 0');
      await assertChain();
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

async function simulate<T>(run: () => Promise<T>, label: string, hooks: { onSlippage?: (s: Slippage) => WalletError } = {}): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (hooks.onSlippage !== undefined) {
      const slippage = decodeSlippage(error);
      if (slippage !== undefined) throw hooks.onSlippage(slippage);
    }
    throw new WalletError('simulation_failed', `${label} would revert: ${errorMessage(error)}`, { cause: error });
  }
}

/** The two numbers of the desk's `SlippageExceeded(uint256 usdMicro, uint256 minUsdMicro)`. */
export interface Slippage {
  /** What the desk would credit now. */
  usdMicro: bigint;
  /** The floor the caller asked for. */
  minUsdMicro: bigint;
}

/**
 * Finds a `SlippageExceeded` revert in a viem error: either already decoded by viem
 * (`ContractFunctionRevertedError.data`) or as raw revert bytes (`data: 0x…`) anywhere down the `cause` chain.
 */
export function decodeSlippage(error: unknown): Slippage | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && typeof current === 'object' && current !== null; depth += 1) {
    const data = (current as { data?: unknown }).data;
    let decoded: { errorName?: unknown; args?: unknown } | undefined;
    if (typeof data === 'object' && data !== null) decoded = data as { errorName?: unknown; args?: unknown };
    else if (typeof data === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(data)) {
      try {
        decoded = decodeErrorResult({ abi: CREDIT_DESK_ABI, data: data as Hex });
      } catch {
        // not a desk error
      }
    }
    if (decoded?.errorName === 'SlippageExceeded' && Array.isArray(decoded.args)) {
      const [usdMicro, minUsdMicro] = decoded.args as unknown[];
      if (typeof usdMicro === 'bigint' && typeof minUsdMicro === 'bigint') return { usdMicro, minUsdMicro };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function slippageError(slippage: Slippage, label: string, txHash?: Hex): WalletError {
  const { usdMicro, minUsdMicro } = slippage;
  const where = txHash === undefined ? `${label} would revert with SlippageExceeded` : `${label} reverted with SlippageExceeded (tx ${txHash}, only gas was spent)`;
  return new WalletError(
    'slippage_exceeded',
    `${where}: the desk now quotes ${usdMicro.toString()} µUSD (${formatUsdMicro(usdMicro)}) for this burn, below the credit floor of ${minUsdMicro.toString()} µUSD (${formatUsdMicro(minUsdMicro)}); the price moved since the quote. Nothing was burned: re-quote and retry, or allow a wider tolerance.`,
    txHash === undefined ? {} : { txHash },
  );
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
