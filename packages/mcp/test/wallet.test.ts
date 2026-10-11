import { CREDIT_DESK_ABI, ERC20_ABI } from '@beagle/shared/abi';
import {
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  keccak256,
  numberToHex,
  parseTransaction,
  toFunctionSelector,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { buildUnsignedSteps, createLazyWalletExecutor, createViemWalletExecutor, errorMessage, WalletError, type WalletExecutor } from '../src/wallet.js';

const UINT256_MAX = (1n << 256n) - 1n;

const DESK = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0' as Address;
const TOKEN = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as Address;
const WORKSPACE = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' as Address;
// anvil account #2
const PRIVATE_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as Hex;
const AGENT = privateKeyToAccount(PRIVATE_KEY).address;

describe('buildUnsignedSteps', () => {
  it('encodes approve + burnForCredit', () => {
    const tokens = 1000n * 10n ** 18n;
    const req = buildUnsignedSteps({ action: 'buyCompute', chainId: 4663, deployment: { creditDesk: DESK, token: TOKEN }, workspace: WORKSPACE, tokens });
    expect(req.unsigned).toBe(true);
    expect(req.chainId).toBe(4663);
    expect(req.steps.length).toBe(2);
    const [approve, burn] = req.steps;
    expect(approve!.to).toBe(TOKEN);
    expect(approve!.value).toBe('0');
    expect(decodeFunctionData({ abi: ERC20_ABI, data: approve!.data })).toEqual({ functionName: 'approve', args: [DESK, tokens] });
    expect(approve!.description).toContain('approve 1000 BEAGLE');
    // the allowance is shared with open budgets: tell the signer to add, not overwrite
    expect(approve!.description).toMatch(/current allowance \+ 1000 BEAGLE/);
    expect(burn!.to).toBe(DESK);
    expect(decodeFunctionData({ abi: CREDIT_DESK_ABI, data: burn!.data })).toEqual({ functionName: 'burnForCredit', args: [getAddress(WORKSPACE), tokens] });
    expect(burn!.description).toContain(getAddress(WORKSPACE));
  });

  it('encodes approve + openBudget with the custom symbol and decimals', () => {
    const cap = 250n * 10n ** 6n;
    const deadline = 1_760_086_400n;
    const req = buildUnsignedSteps({
      action: 'openBudget',
      chainId: 31337,
      deployment: { creditDesk: DESK, token: TOKEN },
      workspace: WORKSPACE,
      cap,
      deadline,
      tokenSymbol: 'USDX',
      tokenDecimals: 6,
    });
    const [approve, open] = req.steps;
    expect(decodeFunctionData({ abi: ERC20_ABI, data: approve!.data })).toEqual({ functionName: 'approve', args: [DESK, cap] });
    expect(approve!.description).toContain('250 USDX');
    expect(decodeFunctionData({ abi: CREDIT_DESK_ABI, data: open!.data })).toEqual({ functionName: 'openBudget', args: [getAddress(WORKSPACE), cap, deadline] });
    expect(open!.description).toContain('2025-10-10T08:53:20.000Z');
  });

  it('rejects bad input', () => {
    const base = { chainId: 1, deployment: { creditDesk: DESK, token: TOKEN }, workspace: WORKSPACE } as const;
    expect(() => buildUnsignedSteps({ ...base, action: 'buyCompute', tokens: 0n })).toThrow(WalletError);
    expect(() => buildUnsignedSteps({ ...base, action: 'buyCompute', tokens: 1n, workspace: '0x123' as Address })).toThrow(/workspace/);
    expect(() => buildUnsignedSteps({ ...base, action: 'openBudget', cap: 1n << 128n, deadline: 1n })).toThrow(/uint128/);
    expect(() => buildUnsignedSteps({ ...base, action: 'openBudget', cap: 1n, deadline: 0n })).toThrow(/deadline/);
  });
});

// ---------------------------------------------------------------------------------------------
// Fake JSON-RPC node for the viem executor

interface SentTx {
  hash: Hex;
  to: Address;
  data: Hex;
}

interface FakeNode {
  transport: ReturnType<typeof custom>;
  sent: SentTx[];
  calls: string[];
  /** `allowance(AGENT, DESK)`: overwritten by `approve`, decremented by `burnForCredit` like a real ERC-20. */
  allowance: bigint;
  /** When set, `burnForCredit` simulations revert with this encoded error. */
  revertBurnWith?: Hex;
  /** Chain id the node reports (default 31337). */
  chainId: number;
  /** Emit an unrelated desk event (`BudgetClosed`) before the expected one in every desk receipt. */
  foreignDeskEventFirst: boolean;
}

const SELECTORS = {
  allowance: toFunctionSelector('allowance(address,address)'),
  approve: toFunctionSelector('approve(address,uint256)'),
  burnForCredit: toFunctionSelector('burnForCredit(address,uint256)'),
  openBudget: toFunctionSelector('openBudget(address,uint128,uint64)'),
} as const;

function selectorOf(data: Hex): string {
  return data.slice(0, 10).toLowerCase();
}

function deskLog(tx: SentTx, topics: ReturnType<typeof encodeEventTopics>, data: Hex, logIndex: number): unknown {
  return { address: DESK, topics, data, blockNumber: '0x11', transactionHash: tx.hash, transactionIndex: '0x0', blockHash: `0x${'33'.repeat(32)}`, logIndex: numberToHex(logIndex), removed: false };
}

function receiptLogs(node: FakeNode, tx: SentTx): unknown[] {
  const sel = selectorOf(tx.data);
  const logs: unknown[] = [];
  if (sel === SELECTORS.burnForCredit || sel === SELECTORS.openBudget) {
    if (node.foreignDeskEventFirst) {
      // another desk event in the same receipt, first: the decoder must skip it rather than mis-read it
      const topics = encodeEventTopics({ abi: CREDIT_DESK_ABI, eventName: 'BudgetClosed', args: { budgetId: 77n } });
      logs.push(deskLog(tx, topics, encodeAbiParameters([{ type: 'uint128' }], [5n]), 0));
    }
  }
  if (sel === SELECTORS.burnForCredit) {
    const { args } = decodeFunctionData({ abi: CREDIT_DESK_ABI, data: tx.data }) as { args: readonly [Address, bigint] };
    const topics = encodeEventTopics({ abi: CREDIT_DESK_ABI, eventName: 'CreditPurchased', args: { receiptId: 11n, workspace: args[0], payer: AGENT } });
    const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [args[1], 5_000_000n, 10n ** 16n]);
    logs.push(deskLog(tx, topics, data, logs.length));
    return logs;
  }
  if (sel === SELECTORS.openBudget) {
    const { args } = decodeFunctionData({ abi: CREDIT_DESK_ABI, data: tx.data }) as { args: readonly [Address, bigint, bigint] };
    const topics = encodeEventTopics({ abi: CREDIT_DESK_ABI, eventName: 'BudgetOpened', args: { budgetId: 9n, owner: AGENT, workspace: args[0] } });
    const data = encodeAbiParameters([{ type: 'uint128' }, { type: 'uint64' }], [args[1], args[2]]);
    logs.push(deskLog(tx, topics, data, logs.length));
    return logs;
  }
  // approve: an unrelated Transfer-like log from the token to make sure foreign logs are skipped
  return [{ address: TOKEN, topics: [keccak256(Buffer.from('Approval(address,address,uint256)'))], data: '0x', blockNumber: '0x11', transactionHash: tx.hash, transactionIndex: '0x0', blockHash: `0x${'33'.repeat(32)}`, logIndex: '0x0', removed: false }];
}

function createFakeNode(options: { allowance: bigint; revertBurnWith?: Hex; chainId?: number; foreignDeskEventFirst?: boolean }): FakeNode {
  const node: FakeNode = {
    sent: [],
    calls: [],
    allowance: options.allowance,
    chainId: options.chainId ?? 31337,
    foreignDeskEventFirst: options.foreignDeskEventFirst ?? false,
    ...(options.revertBurnWith === undefined ? {} : { revertBurnWith: options.revertBurnWith }),
    transport: custom(
      {
        request: async ({ method, params }: { method: string; params?: unknown }) => {
          node.calls.push(method);
          const p = (params ?? []) as unknown[];
          switch (method) {
            case 'eth_chainId':
              return numberToHex(node.chainId);
            case 'eth_blockNumber':
              return '0x11';
            case 'eth_getBlockByNumber':
              return {
                number: '0x11',
                hash: `0x${'33'.repeat(32)}`,
                parentHash: `0x${'32'.repeat(32)}`,
                timestamp: '0x68e7d400',
                baseFeePerGas: '0x1',
                gasLimit: '0x1c9c380',
                gasUsed: '0x0',
                miner: AGENT,
                transactions: [],
                difficulty: '0x0',
                extraData: '0x',
                logsBloom: `0x${'00'.repeat(256)}`,
                nonce: '0x0000000000000000',
                size: '0x0',
                stateRoot: `0x${'00'.repeat(32)}`,
                receiptsRoot: `0x${'00'.repeat(32)}`,
                transactionsRoot: `0x${'00'.repeat(32)}`,
                sha3Uncles: `0x${'00'.repeat(32)}`,
                uncles: [],
                totalDifficulty: '0x0',
                mixHash: `0x${'00'.repeat(32)}`,
              };
            case 'eth_maxPriorityFeePerGas':
            case 'eth_gasPrice':
              return '0x1';
            case 'eth_getTransactionCount':
              return numberToHex(node.sent.length);
            case 'eth_estimateGas':
              return '0x30d40';
            case 'eth_call': {
              const call = p[0] as { to: Address; data: Hex };
              const sel = selectorOf(call.data);
              if (sel === SELECTORS.allowance) return encodeFunctionResult({ abi: ERC20_ABI, functionName: 'allowance', result: node.allowance });
              if (sel === SELECTORS.burnForCredit) {
                if (node.revertBurnWith !== undefined) {
                  throw { code: 3, message: 'execution reverted', data: node.revertBurnWith };
                }
                return encodeFunctionResult({ abi: CREDIT_DESK_ABI, functionName: 'burnForCredit', result: 11n });
              }
              if (sel === SELECTORS.openBudget) return encodeFunctionResult({ abi: CREDIT_DESK_ABI, functionName: 'openBudget', result: 9n });
              throw new Error(`fake node: unexpected eth_call ${sel}`);
            }
            case 'eth_sendRawTransaction': {
              const raw = p[0] as Hex;
              const tx = parseTransaction(raw);
              const hash = keccak256(raw);
              node.sent.push({ hash, to: getAddress(tx.to!), data: tx.data! });
              if (selectorOf(tx.data!) === SELECTORS.approve) {
                const { args } = decodeFunctionData({ abi: ERC20_ABI, data: tx.data! }) as { args: readonly [Address, bigint] };
                node.allowance = args[1];
              }
              if (selectorOf(tx.data!) === SELECTORS.burnForCredit) {
                // safeTransferFrom inside burnForCredit spends the allowance (OZ `_spendAllowance`), unless it is unlimited
                const { args } = decodeFunctionData({ abi: CREDIT_DESK_ABI, data: tx.data! }) as { args: readonly [Address, bigint] };
                if (node.allowance !== UINT256_MAX) node.allowance -= args[1];
              }
              return hash;
            }
            case 'eth_getTransactionReceipt': {
              const hash = p[0] as Hex;
              const tx = node.sent.find((t) => t.hash === hash);
              if (tx === undefined) return null;
              return {
                transactionHash: hash,
                transactionIndex: '0x0',
                blockHash: `0x${'33'.repeat(32)}`,
                blockNumber: '0x11',
                from: AGENT,
                to: tx.to,
                cumulativeGasUsed: '0x5208',
                gasUsed: '0x5208',
                contractAddress: null,
                logs: receiptLogs(node, tx),
                logsBloom: `0x${'00'.repeat(256)}`,
                status: '0x1',
                effectiveGasPrice: '0x1',
                type: '0x2',
              };
            }
            default:
              throw new Error(`fake node: unhandled method ${method}`);
          }
        },
      },
      { retryCount: 0 },
    ),
  };
  return node;
}

describe('createViemWalletExecutor', () => {
  it('approves when the allowance is short, burns, and decodes the CreditPurchased receipt id', async () => {
    const node = createFakeNode({ allowance: 0n });
    const wallet = createViemWalletExecutor({ privateKey: PRIVATE_KEY, chainId: 31337, deployment: { creditDesk: DESK, token: TOKEN }, transport: node.transport, pollingIntervalMs: 1 });
    expect(wallet.address).toBe(AGENT);
    const tokens = 500n * 10n ** 18n;
    const result = await wallet.buyCompute({ workspace: WORKSPACE, tokens });
    expect(node.sent.length).toBe(2);
    expect(node.sent[0]!.to).toBe(TOKEN);
    expect(decodeFunctionData({ abi: ERC20_ABI, data: node.sent[0]!.data })).toEqual({ functionName: 'approve', args: [DESK, tokens] });
    expect(node.sent[1]!.to).toBe(DESK);
    expect(decodeFunctionData({ abi: CREDIT_DESK_ABI, data: node.sent[1]!.data })).toEqual({ functionName: 'burnForCredit', args: [getAddress(WORKSPACE), tokens] });
    // receiptId, usdMicro and priceE18 all come from the CreditPurchased event
    expect(result).toEqual({ txHash: node.sent[1]!.hash, receiptId: 11n, usdMicro: 5_000_000n, priceE18: 10n ** 16n, approveTxHash: node.sent[0]!.hash });
    expect(node.allowance).toBe(0n);
  });

  it('approves on top of an existing allowance so the burn leaves it intact for open budgets', async () => {
    // a budget with cap 500 relies on allowance(agent, desk) == 500; buying 300 must not eat into it
    const node = createFakeNode({ allowance: 500n * 10n ** 18n });
    const wallet = createViemWalletExecutor({ privateKey: PRIVATE_KEY, chainId: 31337, deployment: { creditDesk: DESK, token: TOKEN }, transport: node.transport, pollingIntervalMs: 1 });
    const result = await wallet.buyCompute({ workspace: WORKSPACE, tokens: 300n * 10n ** 18n });
    expect(node.sent.length).toBe(2);
    expect(decodeFunctionData({ abi: ERC20_ABI, data: node.sent[0]!.data })).toEqual({ functionName: 'approve', args: [DESK, 800n * 10n ** 18n] });
    expect(selectorOf(node.sent[1]!.data)).toBe(SELECTORS.burnForCredit);
    expect(result.approveTxHash).toBe(node.sent[0]!.hash);
    expect(node.allowance).toBe(500n * 10n ** 18n);
  });

  it('approves allowance + amount when the burn exceeds the allowance (no overwrite to a smaller total)', async () => {
    const node = createFakeNode({ allowance: 500n * 10n ** 18n });
    const wallet = createViemWalletExecutor({ privateKey: PRIVATE_KEY, chainId: 31337, deployment: { creditDesk: DESK, token: TOKEN }, transport: node.transport, pollingIntervalMs: 1 });
    await wallet.buyCompute({ workspace: WORKSPACE, tokens: 1000n * 10n ** 18n });
    expect(decodeFunctionData({ abi: ERC20_ABI, data: node.sent[0]!.data })).toEqual({ functionName: 'approve', args: [DESK, 1500n * 10n ** 18n] });
    // the budget's 500 are still approved after the 1000 burn (previously: approve(1000) → burn → 0, budget stalled on `allowance`)
    expect(node.allowance).toBe(500n * 10n ** 18n);
  });

  it('skips the approve only when the allowance is effectively unlimited', async () => {
    const node = createFakeNode({ allowance: UINT256_MAX });
    const wallet = createViemWalletExecutor({ privateKey: PRIVATE_KEY, chainId: 31337, deployment: { creditDesk: DESK, token: TOKEN }, transport: node.transport, pollingIntervalMs: 1 });
    const result = await wallet.buyCompute({ workspace: WORKSPACE, tokens: 10n ** 18n });
    expect(node.sent.length).toBe(1);
    expect(selectorOf(node.sent[0]!.data)).toBe(SELECTORS.burnForCredit);
    expect(result.approveTxHash).toBeUndefined();
    expect(result.receiptId).toBe(11n);
  });

  it('opens a budget and returns the BudgetOpened id', async () => {
    const node = createFakeNode({ allowance: 0n });
    const wallet = createViemWalletExecutor({ privateKey: PRIVATE_KEY, chainId: 31337, deployment: { creditDesk: DESK, token: TOKEN }, transport: node.transport, pollingIntervalMs: 1 });
    const cap = 200n * 10n ** 18n;
    const deadline = 1_760_086_400n;
    const result = await wallet.openBudget({ workspace: WORKSPACE, cap, deadline });
    expect(node.sent.length).toBe(2);
    expect(decodeFunctionData({ abi: CREDIT_DESK_ABI, data: node.sent[1]!.data })).toEqual({ functionName: 'openBudget', args: [getAddress(WORKSPACE), cap, deadline] });
    expect(result.budgetId).toBe(9n);
    expect(result.txHash).toBe(node.sent[1]!.hash);
    expect(result.approveTxHash).toBe(node.sent[0]!.hash);
  });

  it('adds a second budget cap on top of the allowance the first one needs', async () => {
    const node = createFakeNode({ allowance: 500n * 10n ** 18n });
    const wallet = createViemWalletExecutor({ privateKey: PRIVATE_KEY, chainId: 31337, deployment: { creditDesk: DESK, token: TOKEN }, transport: node.transport, pollingIntervalMs: 1 });
    await wallet.openBudget({ workspace: WORKSPACE, cap: 500n * 10n ** 18n, deadline: 1_760_086_400n });
    expect(node.sent.length).toBe(2);
    expect(decodeFunctionData({ abi: ERC20_ABI, data: node.sent[0]!.data })).toEqual({ functionName: 'approve', args: [DESK, 1000n * 10n ** 18n] });
    expect(node.allowance).toBe(1000n * 10n ** 18n);
  });

  it('skips an unrelated desk event that precedes the expected one in the receipt', async () => {
    const node = createFakeNode({ allowance: 0n, foreignDeskEventFirst: true });
    const wallet = createViemWalletExecutor({ privateKey: PRIVATE_KEY, chainId: 31337, deployment: { creditDesk: DESK, token: TOKEN }, transport: node.transport, pollingIntervalMs: 1 });
    const opened = await wallet.openBudget({ workspace: WORKSPACE, cap: 1n, deadline: 1_760_086_400n });
    expect(opened.budgetId).toBe(9n); // not the BudgetClosed(77) that comes first
    const bought = await wallet.buyCompute({ workspace: WORKSPACE, tokens: 1n });
    expect(bought.receiptId).toBe(11n);
    expect(bought.usdMicro).toBe(5_000_000n);
  });

  it('refuses to send when the node is on another chain', async () => {
    const node = createFakeNode({ allowance: 0n, chainId: 1 });
    const wallet = createViemWalletExecutor({ privateKey: PRIVATE_KEY, chainId: 31337, deployment: { creditDesk: DESK, token: TOKEN }, transport: node.transport, pollingIntervalMs: 1 });
    const error = await wallet.buyCompute({ workspace: WORKSPACE, tokens: 10n ** 18n }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WalletError);
    expect((error as WalletError).code).toBe('chain_mismatch');
    expect((error as WalletError).message).toMatch(/chain 1 .* chain 31337/);
    expect(node.calls).not.toContain('eth_sendRawTransaction');
    expect(node.sent.length).toBe(0);
    await expect(wallet.openBudget({ workspace: WORKSPACE, cap: 1n, deadline: 1n })).rejects.toMatchObject({ code: 'chain_mismatch' });
    expect(node.sent.length).toBe(0);
  });

  it('verifies the chain id once per executor', async () => {
    const node = createFakeNode({ allowance: 0n });
    const wallet = createViemWalletExecutor({ privateKey: PRIVATE_KEY, chainId: 31337, deployment: { creditDesk: DESK, token: TOKEN }, transport: node.transport, pollingIntervalMs: 1 });
    await wallet.buyCompute({ workspace: WORKSPACE, tokens: 1n });
    await wallet.buyCompute({ workspace: WORKSPACE, tokens: 1n });
    expect(node.calls.filter((m) => m === 'eth_chainId').length).toBe(1);
  });

  it('surfaces contract reverts from the simulation with the custom error name', async () => {
    const node = createFakeNode({
      allowance: UINT256_MAX,
      revertBurnWith: encodeErrorResult({ abi: CREDIT_DESK_ABI, errorName: 'BurnTooSmall', args: [1n, 10n ** 18n] }),
    });
    const wallet = createViemWalletExecutor({ privateKey: PRIVATE_KEY, chainId: 31337, deployment: { creditDesk: DESK, token: TOKEN }, transport: node.transport, pollingIntervalMs: 1 });
    const error = await wallet.buyCompute({ workspace: WORKSPACE, tokens: 1n }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WalletError);
    expect((error as WalletError).code).toBe('simulation_failed');
    expect((error as WalletError).message).toMatch(/BurnTooSmall/);
    expect(node.sent.length).toBe(0);
  });

  it('validates its input before touching the chain', async () => {
    const node = createFakeNode({ allowance: 0n });
    const wallet = createViemWalletExecutor({ privateKey: PRIVATE_KEY, chainId: 31337, deployment: { creditDesk: DESK, token: TOKEN }, transport: node.transport });
    await expect(wallet.buyCompute({ workspace: WORKSPACE, tokens: 0n })).rejects.toMatchObject({ code: 'invalid_amount' });
    await expect(wallet.openBudget({ workspace: '0xnope' as Address, cap: 1n, deadline: 1n })).rejects.toMatchObject({ code: 'invalid_address' });
    expect(node.calls.length).toBe(0);
  });

  it('needs an rpcUrl for chains it does not know', () => {
    expect(() => createViemWalletExecutor({ privateKey: PRIVATE_KEY, chainId: 999_999, deployment: { creditDesk: DESK, token: TOKEN } })).toThrow(/rpcUrl/);
    expect(() => createViemWalletExecutor({ privateKey: PRIVATE_KEY, chainId: 999_999, rpcUrl: 'http://127.0.0.1:1', deployment: { creditDesk: DESK, token: TOKEN } })).not.toThrow();
  });
});

describe('createLazyWalletExecutor', () => {
  it('knows its address up front, retries a failed build on the next call and caches a successful one', async () => {
    let builds = 0;
    let gatewayUp = false;
    const inner: WalletExecutor = {
      address: AGENT,
      buyCompute: async ({ tokens }) => ({ txHash: `0x${'aa'.repeat(32)}`, receiptId: tokens }),
      openBudget: async () => ({ txHash: `0x${'bb'.repeat(32)}`, budgetId: 1n }),
    };
    const wallet = createLazyWalletExecutor({
      address: AGENT,
      build: async () => {
        builds += 1;
        if (!gatewayUp) throw new Error('request to GET /api/config failed: fetch failed');
        return inner;
      },
    });
    expect(wallet.address).toBe(AGENT);
    expect(builds).toBe(0);

    const error = await wallet.buyCompute({ workspace: WORKSPACE, tokens: 1n }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WalletError);
    expect((error as WalletError).code).toBe('wallet_unavailable');
    expect((error as WalletError).message).toMatch(/fetch failed/);
    expect((error as WalletError).message).toMatch(/not attempted/);
    expect(builds).toBe(1);

    gatewayUp = true;
    expect(await wallet.buyCompute({ workspace: WORKSPACE, tokens: 2n })).toEqual({ txHash: `0x${'aa'.repeat(32)}`, receiptId: 2n });
    expect(await wallet.openBudget({ workspace: WORKSPACE, cap: 1n, deadline: 1n })).toMatchObject({ budgetId: 1n });
    expect(builds).toBe(2);
  });
});

describe('errorMessage', () => {
  it('prefers viem short messages and falls back to message / String', () => {
    expect(errorMessage({ shortMessage: 'short', message: 'long' })).toBe('short');
    expect(errorMessage({ shortMessage: 'short', metaMessages: ['Error: BurnTooSmall(uint256 amount, uint256 minBurn)'] })).toBe('short (BurnTooSmall(uint256 amount, uint256 minBurn))');
    expect(errorMessage(new Error('plain'))).toBe('plain');
    expect(errorMessage(42)).toBe('42');
  });
});
