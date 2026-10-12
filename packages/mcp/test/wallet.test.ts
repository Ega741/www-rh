import { MEMO_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@beagle/shared/addresses';
import { encodePurchaseMemo, parseMemo } from '@beagle/shared/memo';
import {
  decodeInstruction,
  getAssociatedTokenAddressSync,
  isApproveCheckedInstruction,
  isBurnCheckedInstruction,
  isRevokeInstruction,
  TokenInstruction,
} from '@solana/spl-token';
import { Keypair, PublicKey, SendTransactionError, Transaction, TransactionExpiredBlockheightExceededError, type TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import {
  buildUnsignedTransactions,
  createKeypairWalletExecutor,
  createLazyWalletExecutor,
  describeTokenAccount,
  GENESIS_HASHES,
  keypairFromSecret,
  MIN_FEE_LAMPORTS,
  parseSecretKey,
  prepareUnsignedTransactions,
  resolveTokenAccount,
  U64_MAX,
  WalletError,
  type WalletDeployment,
  type WalletExecutor,
} from '../src/wallet.js';
import {
  AGENT,
  AGENT_KEYPAIR,
  BLOCKHASH,
  createFakeConnection,
  LAST_VALID_BLOCK_HEIGHT,
  MINT,
  OPERATOR,
  OTHER_WORKSPACE,
  PAYER,
  type FakeConnection,
  type FakeTokenAccount,
} from './fake-connection.js';

const DEPLOYMENT: WalletDeployment = { cluster: 'localnet', mint: MINT, decimals: 6, tokenProgram: TOKEN_PROGRAM_ID, operator: OPERATOR, symbol: 'BEAGLE' };
const ata = (owner: string): string => getAssociatedTokenAddressSync(new PublicKey(MINT), new PublicKey(owner), true, new PublicKey(TOKEN_PROGRAM_ID)).toBase58();
const AGENT_ATA = ata(AGENT);
const SECOND_ACCOUNT = Keypair.fromSeed(new Uint8Array(32).fill(11)).publicKey.toBase58();
const ONE = 10n ** 6n;

function account(overrides: Partial<FakeTokenAccount> = {}): FakeTokenAccount {
  return { address: AGENT_ATA, mint: MINT, owner: AGENT, amount: 1_000n * ONE, ...overrides };
}

function memoText(ix: TransactionInstruction): string {
  expect(ix.programId.toBase58()).toBe(MEMO_PROGRAM_ID);
  return Buffer.from(ix.data).toString('utf8');
}

async function failure(promise: Promise<unknown>): Promise<WalletError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(WalletError);
  return error as WalletError;
}

describe('parseSecretKey / keypairFromSecret', () => {
  it('reads a base58 secret key, a JSON byte array (solana-keygen file) and a 32-byte seed', () => {
    const b58 = bs58.encode(AGENT_KEYPAIR.secretKey);
    expect(keypairFromSecret(b58).publicKey.toBase58()).toBe(AGENT);
    expect(keypairFromSecret(JSON.stringify(Array.from(AGENT_KEYPAIR.secretKey))).publicKey.toBase58()).toBe(AGENT);
    expect(keypairFromSecret(` ${JSON.stringify(Array.from(AGENT_KEYPAIR.secretKey))}\n`).publicKey.toBase58()).toBe(AGENT);
    const seed = new Uint8Array(32).fill(7);
    expect(keypairFromSecret(bs58.encode(seed)).publicKey.toBase58()).toBe(AGENT);
    expect(parseSecretKey(b58).length).toBe(64);
  });

  it('rejects malformed keys with invalid_secret_key and never echoes the material', () => {
    const cases = ['', '   ', '[1,2,3]', '[1, "a"]', '[', 'not base58 0OIl', bs58.encode(new Uint8Array(10))];
    for (const text of cases) {
      let error: unknown;
      try {
        parseSecretKey(text);
      } catch (e) {
        error = e;
      }
      expect(error, text).toBeInstanceOf(WalletError);
      expect((error as WalletError).code).toBe('invalid_secret_key');
      if (text.trim().length > 3) expect((error as WalletError).message).not.toContain(text.trim());
    }
    // 64 bytes that are not a keypair (public half does not match)
    const wrong = new Uint8Array(64).fill(1);
    expect(() => keypairFromSecret(wrong)).toThrow(WalletError);
  });
});

describe('resolveTokenAccount', () => {
  it('prefers the associated token account when it holds the amount (one read, no listing)', async () => {
    const rpc = createFakeConnection({ tokenAccounts: [account()] });
    const resolved = await resolveTokenAccount(rpc, { owner: AGENT, deployment: DEPLOYMENT, need: 500n * ONE });
    expect(resolved).toEqual({ address: AGENT_ATA, amount: 1_000n * ONE, isAta: true, delegate: null, delegatedAmount: 0n });
    expect(rpc.callsTo('getAccountInfo')).toBe(1);
    expect(rpc.callsTo('getTokenAccountsByOwner')).toBe(0);
  });

  it('falls back to the largest account of the mint when the ATA is short or missing', async () => {
    const rpc = createFakeConnection({
      tokenAccounts: [
        account({ amount: 10n * ONE }),
        account({ address: SECOND_ACCOUNT, amount: 800n * ONE, delegate: OPERATOR, delegatedAmount: 50n * ONE }),
        account({ address: Keypair.fromSeed(new Uint8Array(32).fill(12)).publicKey.toBase58(), amount: 300n * ONE }),
      ],
    });
    const resolved = await resolveTokenAccount(rpc, { owner: AGENT, deployment: DEPLOYMENT, need: 500n * ONE });
    expect(resolved).toEqual({ address: SECOND_ACCOUNT, amount: 800n * ONE, isAta: false, delegate: OPERATOR, delegatedAmount: 50n * ONE });
    expect(rpc.callsTo('getTokenAccountsByOwner')).toBe(1);

    const noAta = createFakeConnection({ tokenAccounts: [account({ address: SECOND_ACCOUNT, amount: 5n * ONE })] });
    const any = await resolveTokenAccount(noAta, { owner: AGENT, deployment: DEPLOYMENT, need: 0n });
    expect(any.address).toBe(SECOND_ACCOUNT);
    expect(any.isAta).toBe(false);
  });

  it('reports insufficient_tokens with the amounts, and no account at all', async () => {
    const short = createFakeConnection({ tokenAccounts: [account({ amount: 100n * ONE }), account({ address: SECOND_ACCOUNT, amount: 200n * ONE })] });
    const error = await failure(resolveTokenAccount(short, { owner: AGENT, deployment: DEPLOYMENT, need: 500n * ONE }));
    expect(error.code).toBe('insufficient_tokens');
    expect(error.message).toMatch(/holds 200 BEAGLE \(200000000 raw\) in its largest BEAGLE account/);
    expect(error.message).toMatch(/less than the 500 BEAGLE \(500000000 raw\) needed/);

    const none = createFakeConnection({ tokenAccounts: [] });
    const missing = await failure(resolveTokenAccount(none, { owner: AGENT, deployment: DEPLOYMENT, need: 0n }));
    expect(missing.code).toBe('insufficient_tokens');
    expect(missing.message).toMatch(/no token account of mint/);
  });

  it('ignores accounts of other mints / programs and maps RPC failures to rpc_error', async () => {
    const otherMint = Keypair.fromSeed(new Uint8Array(32).fill(13)).publicKey.toBase58();
    const rpc = createFakeConnection({
      tokenAccounts: [account({ address: SECOND_ACCOUNT, mint: otherMint, amount: 999n * ONE }), account({ amount: 1n, programId: TOKEN_2022_PROGRAM_ID })],
    });
    const error = await failure(resolveTokenAccount(rpc, { owner: AGENT, deployment: DEPLOYMENT, need: 0n }));
    expect(error.code).toBe('insufficient_tokens');

    const down = createFakeConnection({ fail: { getAccountInfo: new Error('ECONNREFUSED') } });
    const rpcError = await failure(resolveTokenAccount(down, { owner: AGENT, deployment: DEPLOYMENT, need: 0n }));
    expect(rpcError.code).toBe('rpc_error');
    expect(rpcError.message).toMatch(/ECONNREFUSED/);
  });

  it('rejects malformed addresses', async () => {
    const rpc = createFakeConnection();
    await expect(resolveTokenAccount(rpc, { owner: 'nope', deployment: DEPLOYMENT, need: 0n })).rejects.toMatchObject({ code: 'invalid_address' });
    await expect(resolveTokenAccount(rpc, { owner: AGENT, deployment: { ...DEPLOYMENT, mint: '0x12' }, need: 0n })).rejects.toMatchObject({ code: 'invalid_address' });
  });
});

describe('buildUnsignedTransactions', () => {
  const blockhash = { blockhash: BLOCKHASH, lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT };

  it('encodes BurnChecked + Memo as an unsigned legacy transaction with feePayer = payer', () => {
    const tokens = 1_000n * ONE;
    const req = buildUnsignedTransactions({ action: 'buyCompute', deployment: DEPLOYMENT, payer: PAYER, tokenAccount: ata(PAYER), tokens, workspace: OTHER_WORKSPACE }, blockhash);
    expect(req.unsigned).toBe(true);
    expect(req.cluster).toBe('localnet');
    expect(req.feePayer).toBe(PAYER);
    expect(req.blockhash).toBe(BLOCKHASH);
    expect(req.lastValidBlockHeight).toBe(LAST_VALID_BLOCK_HEIGHT);
    expect(req.transactions.length).toBe(1);
    const [tx] = req.transactions;
    expect(tx!.description).toMatch(/^BurnChecked 1000 BEAGLE from token account/);
    expect(tx!.description).toContain(`credit workspace ${OTHER_WORKSPACE} via memo "beagle:v1 ws=${OTHER_WORKSPACE}"`);

    const decoded = Transaction.from(Buffer.from(tx!.base64, 'base64'));
    expect(decoded.feePayer?.toBase58()).toBe(PAYER);
    expect(decoded.recentBlockhash).toBe(BLOCKHASH);
    // unsigned: the fee payer's signature slot is empty
    expect(decoded.signatures.length).toBe(1);
    expect(decoded.signatures[0]!.publicKey.toBase58()).toBe(PAYER);
    expect(decoded.signatures[0]!.signature).toBeNull();
    expect(decoded.instructions.length).toBe(2);

    const burn = decodeInstruction(decoded.instructions[0]!, new PublicKey(TOKEN_PROGRAM_ID));
    expect(isBurnCheckedInstruction(burn)).toBe(true);
    if (!isBurnCheckedInstruction(burn)) throw new Error('unreachable');
    expect(burn.data).toEqual({ instruction: TokenInstruction.BurnChecked, amount: tokens, decimals: 6 });
    expect(burn.keys.account.pubkey.toBase58()).toBe(ata(PAYER));
    expect(burn.keys.mint.pubkey.toBase58()).toBe(MINT);
    expect(burn.keys.owner.pubkey.toBase58()).toBe(PAYER);
    expect(burn.keys.owner.isSigner).toBe(true);

    const memo = decoded.instructions[1]!;
    expect(memoText(memo)).toBe(encodePurchaseMemo({ workspace: OTHER_WORKSPACE }));
    expect(parseMemo(memoText(memo))).toEqual({ kind: 'purchase', workspace: OTHER_WORKSPACE });
    expect(memo.keys.map((k) => [k.pubkey.toBase58(), k.isSigner])).toEqual([[PAYER, true]]);
  });

  it('adds no memo when the payer is the credited workspace', () => {
    const req = buildUnsignedTransactions({ action: 'buyCompute', deployment: DEPLOYMENT, payer: PAYER, tokenAccount: ata(PAYER), tokens: ONE, workspace: PAYER }, blockhash);
    const decoded = Transaction.from(Buffer.from(req.transactions[0]!.base64, 'base64'));
    expect(decoded.instructions.length).toBe(1);
    expect(req.transactions[0]!.description).toContain('credit workspace');
    expect(req.transactions[0]!.description).toContain('(the owner)');
  });

  it('encodes ApproveChecked to the operator for a budget and Revoke to close it', () => {
    const cap = 250n * ONE;
    const open = buildUnsignedTransactions({ action: 'openBudget', deployment: DEPLOYMENT, payer: PAYER, tokenAccount: ata(PAYER), cap }, blockhash);
    const approveTx = Transaction.from(Buffer.from(open.transactions[0]!.base64, 'base64'));
    expect(approveTx.instructions.length).toBe(1);
    const approve = decodeInstruction(approveTx.instructions[0]!);
    expect(isApproveCheckedInstruction(approve)).toBe(true);
    if (!isApproveCheckedInstruction(approve)) throw new Error('unreachable');
    expect(approve.data).toEqual({ instruction: TokenInstruction.ApproveChecked, amount: cap, decimals: 6 });
    expect(approve.keys.delegate.pubkey.toBase58()).toBe(OPERATOR);
    expect(approve.keys.owner.pubkey.toBase58()).toBe(PAYER);
    expect(approve.keys.account.pubkey.toBase58()).toBe(ata(PAYER));
    expect(open.transactions[0]!.description).toMatch(/delegate up to 250 BEAGLE/);
    expect(open.transactions[0]!.description).toContain(OPERATOR);
    expect(open.transactions[0]!.description).toMatch(/replaces any previous delegation/);

    const close = buildUnsignedTransactions({ action: 'closeBudget', deployment: DEPLOYMENT, payer: PAYER, tokenAccount: ata(PAYER) }, blockhash);
    const revokeTx = Transaction.from(Buffer.from(close.transactions[0]!.base64, 'base64'));
    const revoke = decodeInstruction(revokeTx.instructions[0]!);
    expect(isRevokeInstruction(revoke)).toBe(true);
    if (!isRevokeInstruction(revoke)) throw new Error('unreachable');
    expect(revoke.keys.account.pubkey.toBase58()).toBe(ata(PAYER));
    expect(revoke.keys.owner.pubkey.toBase58()).toBe(PAYER);
    expect(close.transactions[0]!.description).toMatch(/^Revoke the delegation/);
  });

  it('honours the Token-2022 program id of the deployment', () => {
    const dep: WalletDeployment = { ...DEPLOYMENT, tokenProgram: TOKEN_2022_PROGRAM_ID };
    const req = buildUnsignedTransactions({ action: 'closeBudget', deployment: dep, payer: PAYER, tokenAccount: ata(PAYER) }, blockhash);
    const tx = Transaction.from(Buffer.from(req.transactions[0]!.base64, 'base64'));
    expect(tx.instructions[0]!.programId.toBase58()).toBe(TOKEN_2022_PROGRAM_ID);
  });

  it('rejects bad input', () => {
    const base = { deployment: DEPLOYMENT, payer: PAYER, tokenAccount: ata(PAYER) } as const;
    expect(() => buildUnsignedTransactions({ ...base, action: 'buyCompute', tokens: 0n, workspace: PAYER }, blockhash)).toThrow(WalletError);
    expect(() => buildUnsignedTransactions({ ...base, action: 'buyCompute', tokens: U64_MAX + 1n, workspace: PAYER }, blockhash)).toThrow(/u64/);
    expect(() => buildUnsignedTransactions({ ...base, action: 'buyCompute', tokens: 1n, workspace: '0x123' }, blockhash)).toThrow(/workspace/);
    expect(() => buildUnsignedTransactions({ ...base, action: 'openBudget', cap: -1n }, blockhash)).toThrow(/cap/);
    expect(() => buildUnsignedTransactions({ ...base, action: 'openBudget', cap: 1n, deployment: { ...DEPLOYMENT, operator: null } }, blockhash)).toThrow(/operator/);
    const noOperator = (() => {
      try {
        buildUnsignedTransactions({ ...base, action: 'openBudget', cap: 1n, deployment: { ...DEPLOYMENT, operator: null } }, blockhash);
        return undefined;
      } catch (e) {
        return e as WalletError;
      }
    })();
    expect(noOperator?.code).toBe('not_configured');
    expect(() => buildUnsignedTransactions({ ...base, action: 'closeBudget', payer: 'nope' }, blockhash)).toThrow(/payer/);
  });
});

describe('prepareUnsignedTransactions', () => {
  it('resolves the token account and a fresh blockhash over the RPC', async () => {
    const rpc = createFakeConnection({ tokenAccounts: [account({ address: ata(PAYER), owner: PAYER, amount: 50n * ONE })] });
    const prepared = await prepareUnsignedTransactions(rpc, { action: 'buyCompute', deployment: DEPLOYMENT, payer: PAYER, tokens: 10n * ONE, workspace: OTHER_WORKSPACE });
    expect(prepared.tokenAccount.address).toBe(ata(PAYER));
    expect(prepared.tokenAccount.amount).toBe(50n * ONE);
    expect(prepared.memo).toBe(`beagle:v1 ws=${OTHER_WORKSPACE}`);
    expect(prepared.blockhash).toBe(BLOCKHASH);
    expect(rpc.calls.map((c) => c.method)).toEqual(['getAccountInfo', 'getLatestBlockhash']);
    const tx = Transaction.from(Buffer.from(prepared.transactions[0]!.base64, 'base64'));
    expect(tx.feePayer?.toBase58()).toBe(PAYER);
  });

  it('uses a given token account after checking it belongs to the mint', async () => {
    const rpc = createFakeConnection({ tokenAccounts: [account({ address: SECOND_ACCOUNT, owner: PAYER, amount: 5n * ONE, delegate: OPERATOR, delegatedAmount: 5n * ONE })] });
    const prepared = await prepareUnsignedTransactions(rpc, { action: 'closeBudget', deployment: DEPLOYMENT, payer: PAYER, tokenAccount: SECOND_ACCOUNT });
    expect(prepared.tokenAccount).toEqual({ address: SECOND_ACCOUNT, amount: 5n * ONE, isAta: false, delegate: OPERATOR, delegatedAmount: 5n * ONE });
    const bad = await failure(prepareUnsignedTransactions(rpc, { action: 'closeBudget', deployment: DEPLOYMENT, payer: PAYER, tokenAccount: OTHER_WORKSPACE }));
    expect(bad.code).toBe('invalid_address');
    expect(bad.message).toMatch(/not a token account of mint/);
  });

  it('needs the tokens for a burn but only an account for a budget, and surfaces blockhash failures as rpc_error', async () => {
    const rpc = createFakeConnection({ tokenAccounts: [account({ address: ata(PAYER), owner: PAYER, amount: 1n })] });
    const short = await failure(prepareUnsignedTransactions(rpc, { action: 'buyCompute', deployment: DEPLOYMENT, payer: PAYER, tokens: 10n * ONE, workspace: PAYER }));
    expect(short.code).toBe('insufficient_tokens');
    const budget = await prepareUnsignedTransactions(rpc, { action: 'openBudget', deployment: DEPLOYMENT, payer: PAYER, cap: 10n * ONE });
    expect(budget.tokenAccount.amount).toBe(1n);

    rpc.options.fail = { getLatestBlockhash: new Error('503 Service Unavailable') };
    const down = await failure(prepareUnsignedTransactions(rpc, { action: 'openBudget', deployment: DEPLOYMENT, payer: PAYER, cap: 10n * ONE }));
    expect(down.code).toBe('rpc_error');
    expect(down.message).toMatch(/blockhash/);
  });

  it('describeTokenAccount reports ATA-ness relative to the account owner', async () => {
    const rpc = createFakeConnection({ tokenAccounts: [account()] });
    const info = await describeTokenAccount(rpc, AGENT_ATA, DEPLOYMENT);
    expect(info.isAta).toBe(true);
    expect(info.amount).toBe(1_000n * ONE);
  });
});

// ---------------------------------------------------------------------------------------------
// Keypair executor

interface Harness {
  rpc: FakeConnection;
  wallet: WalletExecutor;
}

function harness(connection: Parameters<typeof createFakeConnection>[0] = {}, deployment: WalletDeployment = DEPLOYMENT): Harness {
  const rpc = createFakeConnection({ tokenAccounts: [account()], ...connection });
  const wallet = createKeypairWalletExecutor({ secretKey: AGENT_KEYPAIR, deployment, connection: rpc });
  return { rpc, wallet };
}

function sentInstructions(rpc: FakeConnection, index = 0): { tx: Transaction; instructions: TransactionInstruction[] } {
  const sent = rpc.sent[index];
  expect(sent).toBeDefined();
  return { tx: sent!.transaction, instructions: sent!.transaction.instructions };
}

describe('createKeypairWalletExecutor', () => {
  it('derives the address from any secret form', () => {
    expect(createKeypairWalletExecutor({ secretKey: AGENT_KEYPAIR, deployment: DEPLOYMENT, connection: createFakeConnection() }).address).toBe(AGENT);
    expect(createKeypairWalletExecutor({ secretKey: bs58.encode(AGENT_KEYPAIR.secretKey), deployment: DEPLOYMENT, connection: createFakeConnection() }).address).toBe(AGENT);
    expect(createKeypairWalletExecutor({ secretKey: AGENT_KEYPAIR.secretKey, deployment: DEPLOYMENT, connection: createFakeConnection() }).address).toBe(AGENT);
    expect(() => createKeypairWalletExecutor({ secretKey: 'nope', deployment: DEPLOYMENT, connection: createFakeConnection() })).toThrow(WalletError);
  });

  it('buyCompute burns from the ATA with a memo for another workspace, signed, sent with preflight and confirmed by blockhash', async () => {
    const { rpc, wallet } = harness();
    const tokens = 500n * ONE;
    const result = await wallet.buyCompute({ workspace: OTHER_WORKSPACE, tokens });

    const { tx, instructions } = sentInstructions(rpc);
    expect(result).toEqual({ signature: bs58.encode(tx.signature!), slot: 42, tokenAccount: AGENT_ATA, memo: `beagle:v1 ws=${OTHER_WORKSPACE}` });
    expect(tx.feePayer?.toBase58()).toBe(AGENT);
    expect(tx.recentBlockhash).toBe(BLOCKHASH);
    expect(tx.verifySignatures()).toBe(true);
    expect(instructions.length).toBe(2);
    const burn = decodeInstruction(instructions[0]!);
    if (!isBurnCheckedInstruction(burn)) throw new Error('expected BurnChecked');
    expect(burn.data).toEqual({ instruction: TokenInstruction.BurnChecked, amount: tokens, decimals: 6 });
    expect(burn.keys.account.pubkey.toBase58()).toBe(AGENT_ATA);
    expect(burn.keys.owner.pubkey.toBase58()).toBe(AGENT);
    expect(parseMemo(memoText(instructions[1]!))).toEqual({ kind: 'purchase', workspace: OTHER_WORKSPACE });

    // localnet: no genesis check; the mint is verified once, then SOL, token account, blockhash, send, confirm
    expect(rpc.calls.map((c) => c.method)).toEqual(['getAccountInfo', 'getAccountInfo', 'getBalance', 'getLatestBlockhash', 'sendRawTransaction', 'confirmTransaction']);
    expect(rpc.calls[0]!.args[0]).toBe(MINT);
    expect(rpc.calls[1]!.args[0]).toBe(AGENT_ATA);
    expect(rpc.calls[4]!.args[0]).toEqual({ skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 });
    expect(rpc.calls[5]!.args).toEqual([{ signature: result.signature, blockhash: BLOCKHASH, lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT }, 'confirmed']);

    // the second call skips the mint check
    await wallet.buyCompute({ workspace: AGENT, tokens: ONE });
    expect(rpc.calls.filter((c) => c.method === 'getAccountInfo' && c.args[0] === MINT).length).toBe(1);
    expect(sentInstructions(rpc, 1).instructions.length).toBe(1); // own workspace: no memo
    expect(rpc.sent[1]!.transaction.instructions[0]!.programId.toBase58()).toBe(TOKEN_PROGRAM_ID);
  });

  it('openBudget delegates the ATA to the operator and reports its balance; closeBudget revokes it', async () => {
    const { rpc, wallet } = harness();
    const open = await wallet.openBudget({ cap: 2_000n * ONE }); // above the balance: SPL allows it, the headroom is capped by the balance
    expect(open).toEqual({ signature: expect.any(String), slot: 42, tokenAccount: AGENT_ATA, balance: 1_000n * ONE });
    const approve = decodeInstruction(sentInstructions(rpc).instructions[0]!);
    if (!isApproveCheckedInstruction(approve)) throw new Error('expected ApproveChecked');
    expect(approve.data).toEqual({ instruction: TokenInstruction.ApproveChecked, amount: 2_000n * ONE, decimals: 6 });
    expect(approve.keys.delegate.pubkey.toBase58()).toBe(OPERATOR);
    expect(approve.keys.owner.pubkey.toBase58()).toBe(AGENT);

    const close = await wallet.closeBudget({});
    expect(close.tokenAccount).toBe(AGENT_ATA);
    const revoke = decodeInstruction(sentInstructions(rpc, 1).instructions[0]!);
    expect(isRevokeInstruction(revoke)).toBe(true);

    rpc.options.tokenAccounts = [...(rpc.options.tokenAccounts ?? []), account({ address: SECOND_ACCOUNT, amount: 3n, delegate: OPERATOR, delegatedAmount: 3n })];
    const explicit = await wallet.closeBudget({ tokenAccount: SECOND_ACCOUNT });
    expect(explicit.tokenAccount).toBe(SECOND_ACCOUNT);
    const revoke2 = decodeInstruction(sentInstructions(rpc, 2).instructions[0]!);
    if (!isRevokeInstruction(revoke2)) throw new Error('expected Revoke');
    expect(revoke2.keys.account.pubkey.toBase58()).toBe(SECOND_ACCOUNT);

    const bad = await failure(wallet.closeBudget({ tokenAccount: OTHER_WORKSPACE }));
    expect(bad.code).toBe('invalid_address');
  });

  it('openBudget without an operator fails with not_configured before touching the chain', async () => {
    const { rpc, wallet } = harness({}, { ...DEPLOYMENT, operator: null });
    const error = await failure(wallet.openBudget({ cap: ONE }));
    expect(error.code).toBe('not_configured');
    expect(rpc.sent.length).toBe(0);
  });

  it('refuses to burn more than the wallet holds (insufficient_tokens) and sends nothing', async () => {
    const { rpc, wallet } = harness({ tokenAccounts: [account({ amount: 10n * ONE })] });
    const error = await failure(wallet.buyCompute({ workspace: AGENT, tokens: 11n * ONE }));
    expect(error.code).toBe('insufficient_tokens');
    expect(rpc.sent.length).toBe(0);
    expect(rpc.callsTo('sendRawTransaction')).toBe(0);
  });

  it('refuses to send without SOL for the fee (insufficient_sol)', async () => {
    const { rpc, wallet } = harness({ lamports: MIN_FEE_LAMPORTS - 1 });
    const error = await failure(wallet.buyCompute({ workspace: AGENT, tokens: ONE }));
    expect(error.code).toBe('insufficient_sol');
    expect(error.message).toMatch(/lamports/);
    expect(rpc.sent.length).toBe(0);
  });

  it('detects a wrong RPC endpoint as chain_mismatch: missing mint, foreign token program, wrong genesis hash', async () => {
    const noMint = harness({ mintExists: false });
    const missing = await failure(noMint.wallet.buyCompute({ workspace: AGENT, tokens: ONE }));
    expect(missing.code).toBe('chain_mismatch');
    expect(missing.message).toMatch(/does not exist on the RPC node/);
    expect(missing.message).toMatch(/BEAGLE_RPC_URL/);

    const wrongProgram = harness({ mintOwner: TOKEN_2022_PROGRAM_ID });
    const owner = await failure(wrongProgram.wallet.closeBudget({}));
    expect(owner.code).toBe('chain_mismatch');
    expect(owner.message).toMatch(/not the configured token program/);

    const devnet = harness({ genesisHash: GENESIS_HASHES['mainnet-beta']! }, { ...DEPLOYMENT, cluster: 'devnet' });
    const genesis = await failure(devnet.wallet.buyCompute({ workspace: AGENT, tokens: ONE }));
    expect(genesis.code).toBe('chain_mismatch');
    expect(genesis.message).toMatch(/genesis hash/);
    expect(devnet.rpc.callsTo('getGenesisHash')).toBe(1);
    expect(devnet.rpc.sent.length).toBe(0);

    const mainnet = harness({ genesisHash: GENESIS_HASHES['mainnet-beta']! }, { ...DEPLOYMENT, cluster: 'mainnet-beta' });
    await mainnet.wallet.buyCompute({ workspace: AGENT, tokens: ONE });
    expect(mainnet.rpc.sent.length).toBe(1);
    expect(mainnet.rpc.callsTo('getGenesisHash')).toBe(1);
  });

  it('maps an expired blockhash to blockhash_expired with the signature', async () => {
    const { wallet } = harness({
      confirm: (signature) => {
        throw new TransactionExpiredBlockheightExceededError(signature);
      },
    });
    const error = await failure(wallet.buyCompute({ workspace: AGENT, tokens: ONE }));
    expect(error.code).toBe('blockhash_expired');
    expect(error.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{87,88}$/);
    expect(error.message).toMatch(/may still have landed/);
  });

  it('maps an on-chain failure to tx_failed with the signature and error', async () => {
    const { wallet } = harness({ confirm: () => ({ context: { slot: 43 }, value: { err: { InstructionError: [0, { Custom: 1 }] } } }) });
    const error = await failure(wallet.buyCompute({ workspace: AGENT, tokens: ONE }));
    expect(error.code).toBe('tx_failed');
    expect(error.signature).toBeDefined();
    expect(error.message).toMatch(/"Custom":1/);
  });

  it('maps preflight failures by their cause: SPL insufficient funds, fee payer broke, blockhash gone, anything else', async () => {
    const simulate = (message: string, logs?: string[]): Error => new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: message, ...(logs === undefined ? {} : { logs }) });

    const spl = harness({ send: () => { throw simulate('Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1', ['Program log: Error: insufficient funds']); } });
    const tokens = await failure(spl.wallet.buyCompute({ workspace: AGENT, tokens: ONE }));
    expect(tokens.code).toBe('insufficient_tokens');
    expect(tokens.logs).toEqual(['Program log: Error: insufficient funds']);

    const fee = harness({ send: () => { throw simulate('Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.'); } });
    expect((await failure(fee.wallet.buyCompute({ workspace: AGENT, tokens: ONE }))).code).toBe('insufficient_sol');

    const stale = harness({ send: () => { throw simulate('Transaction simulation failed: Blockhash not found'); } });
    expect((await failure(stale.wallet.buyCompute({ workspace: AGENT, tokens: ONE }))).code).toBe('blockhash_expired');

    const other = harness({ send: () => { throw simulate('Transaction simulation failed: Error processing Instruction 0: custom program error: 0x4', ['Program log: Error: owner does not match']); } });
    const failed = await failure(other.wallet.buyCompute({ workspace: AGENT, tokens: ONE }));
    expect(failed.code).toBe('tx_failed');
    expect(failed.message).toMatch(/owner does not match/);
    expect(failed.signature).toBeUndefined();

    const network = harness({ send: () => { throw new Error('fetch failed'); } });
    expect((await failure(network.wallet.buyCompute({ workspace: AGENT, tokens: ONE }))).code).toBe('tx_failed');
  });

  it('maps confirmation RPC trouble to rpc_error and validates its inputs', async () => {
    const { wallet, rpc } = harness({ confirm: () => { throw new Error('socket hang up'); } });
    const error = await failure(wallet.buyCompute({ workspace: AGENT, tokens: ONE }));
    expect(error.code).toBe('rpc_error');
    expect(error.signature).toBeDefined();
    expect(rpc.sent.length).toBe(1);

    await expect(wallet.buyCompute({ workspace: 'nope', tokens: ONE })).rejects.toMatchObject({ code: 'invalid_address' });
    await expect(wallet.buyCompute({ workspace: AGENT, tokens: 0n })).rejects.toMatchObject({ code: 'invalid_amount' });
    await expect(wallet.openBudget({ cap: U64_MAX + 1n })).rejects.toMatchObject({ code: 'invalid_amount' });
    expect(rpc.sent.length).toBe(1);
  });
});

describe('createLazyWalletExecutor', () => {
  it('knows its address up front, wraps setup failures as wallet_unavailable and retries the build until it succeeds', async () => {
    let attempts = 0;
    let ready = false;
    const inner = harness();
    const wallet = createLazyWalletExecutor({
      address: AGENT,
      build: async () => {
        attempts += 1;
        if (!ready) throw new Error('request to GET /api/config failed: fetch failed');
        return inner.wallet;
      },
    });
    expect(wallet.address).toBe(AGENT);
    const down = await failure(wallet.buyCompute({ workspace: AGENT, tokens: ONE }));
    expect(down.code).toBe('wallet_unavailable');
    expect(down.message).toMatch(/fetch failed/);
    expect(down.message).toMatch(/nothing was sent/);
    ready = true;
    const result = await wallet.openBudget({ cap: ONE });
    expect(result.tokenAccount).toBe(AGENT_ATA);
    await wallet.closeBudget({});
    expect(attempts).toBe(2); // the built executor is cached
    expect(inner.rpc.sent.length).toBe(2);
    expect(() => createLazyWalletExecutor({ address: 'nope', build: async () => inner.wallet })).toThrow(WalletError);
  });
});
