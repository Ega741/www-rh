#!/usr/bin/env node
// Delegates a budget cap: SPL `ApproveChecked(tokenAccount, mint, delegate = operator, owner, amount, decimals)` on
// the keypair's associated token account (docs/SPEC.md §3.4; a new approval replaces the previous cap). Prints one
// JSON line: { signature, slot, owner, tokenAccount, mint, delegate, amount (raw), decimals }.
//
//   node scripts/e2e/approve.mjs --keypair <path> --mint <base58> --amount 500 --delegate <operator base58> \
//        [--rpc http://127.0.0.1:8899] [--token-account <base58>]
import { web3, splToken, DEFAULT_RPC, parseArgs, loadKeypair, pubkey, toRawAmount, mintContext, ataFor, sendAndConfirm, out } from './_common.mjs';

const args = parseArgs(
  process.argv.slice(2),
  {
    keypair: { required: true, help: 'owner keypair file (solana-keygen JSON)' },
    mint: { required: true, help: 'mint address (base58)' },
    amount: { required: true, help: 'cap in whole tokens, e.g. 500' },
    delegate: { required: true, help: 'delegate public key (the gateway operator)' },
    rpc: { default: DEFAULT_RPC, help: 'JSON-RPC URL' },
    'token-account': { help: 'token account to delegate (default: the owner\'s ATA)' },
  },
  'node scripts/e2e/approve.mjs --keypair <path> --mint <base58> --amount <whole> --delegate <base58> [--rpc <url>]',
);

const owner = loadKeypair(args.keypair);
const mint = pubkey(args.mint, '--mint');
const delegate = pubkey(args.delegate, '--delegate');
const connection = new web3.Connection(args.rpc, 'confirmed');
const { programId, decimals } = await mintContext(connection, mint);
const tokenAccount = args['token-account'] ? pubkey(args['token-account'], '--token-account') : ataFor(owner.publicKey, mint, programId);
const amount = toRawAmount(args.amount, decimals);

const ix = splToken.createApproveCheckedInstruction(tokenAccount, mint, delegate, owner.publicKey, amount, decimals, [], programId);
const { signature, slot } = await sendAndConfirm(connection, [ix], [owner]);
out({
  signature,
  slot,
  owner: owner.publicKey.toBase58(),
  tokenAccount: tokenAccount.toBase58(),
  mint: mint.toBase58(),
  delegate: delegate.toBase58(),
  amount: amount.toString(),
  decimals,
});
