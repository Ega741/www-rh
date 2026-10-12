#!/usr/bin/env node
// Burns N whole tokens from a keypair's associated token account with SPL `BurnChecked`, optionally with an SPL
// Memo (`beagle:v1 ws=<base58>` credits another workspace, docs/SPEC.md §3.2). Prints one JSON line:
// { signature, slot, owner, tokenAccount, mint, amount (raw), decimals, memo }.
//
//   node scripts/e2e/burn.mjs --keypair <path> --mint <base58> --amount 1000 [--memo "beagle:v1 ws=…"] \
//        [--rpc http://127.0.0.1:8899] [--token-account <base58>] [--memo-program <base58>]
import { web3, splToken, MEMO_PROGRAM_ID, createMemoInstruction, DEFAULT_RPC, parseArgs, loadKeypair, pubkey, toRawAmount, mintContext, ataFor, sendAndConfirm, out, die } from './_common.mjs';

const args = parseArgs(
  process.argv.slice(2),
  {
    keypair: { required: true, help: 'owner keypair file (solana-keygen JSON)' },
    mint: { required: true, help: 'mint address (base58)' },
    amount: { required: true, help: 'whole tokens to burn, e.g. 1000 or 0.5' },
    memo: { help: 'SPL Memo text appended after the burn (≤ 256 bytes)' },
    rpc: { default: DEFAULT_RPC, help: 'JSON-RPC URL' },
    'token-account': { help: 'token account to burn from (default: the owner\'s ATA)' },
    'memo-program': { default: MEMO_PROGRAM_ID.toBase58(), help: 'memo program id (the deployment\'s memoProgram)' },
  },
  'node scripts/e2e/burn.mjs --keypair <path> --mint <base58> --amount <whole> [--memo <text>] [--rpc <url>]',
);

const owner = loadKeypair(args.keypair);
const mint = pubkey(args.mint, '--mint');
const connection = new web3.Connection(args.rpc, 'confirmed');
const { programId, decimals } = await mintContext(connection, mint);
const tokenAccount = args['token-account'] ? pubkey(args['token-account'], '--token-account') : ataFor(owner.publicKey, mint, programId);
const amount = toRawAmount(args.amount, decimals);
if (args.memo !== undefined && Buffer.byteLength(args.memo, 'utf8') > 256) die('memo exceeds 256 bytes');

const instructions = [splToken.createBurnCheckedInstruction(tokenAccount, mint, owner.publicKey, amount, decimals, [], programId)];
if (args.memo !== undefined) instructions.push(createMemoInstruction(args.memo, [owner.publicKey], pubkey(args['memo-program'], '--memo-program')));

const { signature, slot } = await sendAndConfirm(connection, instructions, [owner]);
out({
  signature,
  slot,
  owner: owner.publicKey.toBase58(),
  tokenAccount: tokenAccount.toBase58(),
  mint: mint.toBase58(),
  amount: amount.toString(),
  decimals,
  memo: args.memo ?? null,
});
