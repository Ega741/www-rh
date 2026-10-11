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
import { buildUnsignedSteps, createViemWalletExecutor, errorMessage, WalletError } from '../src/wallet.js';

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
  allowance: bigint;
  /** When set, `burnForCredit` simulations revert with this encoded error. */
  revertBurnWith?: Hex;
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

function receiptLogs(tx: SentTx): unknown[] {
  const sel = selectorOf(tx.data);
  if (sel === SELECTORS.burnForCredit) {
    const { args } = decodeFunctionData({ abi: CREDIT_DESK_ABI, data: tx.data }) as { args: readonly [Address, bigint] };
    const topics = encodeEventTopics({ abi: CREDIT_DESK_ABI, eventName: 'CreditPurchased', args: { receiptId: 11n, workspace: args[0], payer: AGENT } });
    const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [args[1], 5_000_000n, 10n ** 16n]);
    return [{ address: DESK, topics, data, blockNumber: '0x11', transactionHash: tx.hash, transactionIndex: '0x0', blockHash: `0x${'33'.repeat(32)}`, logIndex: '0x0', removed: false }];
  }
  if (sel === SELECTORS.openBudget) {
    const { args } = decodeFunctionData({ abi: CREDIT_DESK_ABI, data: tx.data }) as { args: readonly [Address, bigint, bigint] };
    const topics = encodeEventTopics({ abi: CREDIT_DESK_ABI, eventName: 'BudgetOpened', args: { budgetId: 9n, owner: AGENT, workspace: args[0] } });
    const data = encodeAbiParameters([{ type: 'uint128' }, { type: 'uint64' }], [args[1], args[2]]);
    return [{ address: DESK, topics, data, blockNumber: '0x11', transactionHash: tx.hash, transactionIndex: '0x0', blockHash: `0x${'33'.repeat(32)}`, logIndex: '0x0', removed: false }];
  }
  // approve: an unrelated Transfer-like log from the token to make sure foreign logs are skipped
  return [{ address: TOKEN, topics: [keccak256(Buffer.from('Approval(address,address,uint256)'))], data: '0x', blockNumber: '0x11', transactionHash: tx.hash, transactionIndex: '0x0', blockHash: `0x${'33'.repeat(32)}`, logIndex: '0x0', removed: false }];
}

function createFakeNode(options: { allowance: bigint; revertBurnWith?: Hex }): FakeNode {
  const node: FakeNode = {
    sent: [],
    calls: [],
    allowance: options.allowance,
    ...(options.revertBurnWith === undefined ? {} : { revertBurnWith: options.revertBurnWith }),
    transport: custom(
      {
        request: async ({ method, params }: { method: string; params?: unknown }) => {
          node.calls.push(method);
          const p = (params ?? []) as unknown[];
          switch (method) {
            case 'eth_chainId':
              return numberToHex(31337);
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
                logs: receiptLogs(tx),
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
    expect(result).toEqual({ txHash: node.sent[1]!.hash, receiptId: 11n, approveTxHash: node.sent[0]!.hash });
  });

  it('skips the approve when the allowance already covers the burn', async () => {
    const node = createFakeNode({ allowance: 10n ** 24n });
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

  it('surfaces contract reverts from the simulation with the custom error name', async () => {
    const node = createFakeNode({
      allowance: 10n ** 24n,
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

describe('errorMessage', () => {
  it('prefers viem short messages and falls back to message / String', () => {
    expect(errorMessage({ shortMessage: 'short', message: 'long' })).toBe('short');
    expect(errorMessage({ shortMessage: 'short', metaMessages: ['Error: BurnTooSmall(uint256 amount, uint256 minBurn)'] })).toBe('short (BurnTooSmall(uint256 amount, uint256 minBurn))');
    expect(errorMessage(new Error('plain'))).toBe('plain');
    expect(errorMessage(42)).toBe('42');
  });
});
