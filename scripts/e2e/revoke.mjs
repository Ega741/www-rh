#!/usr/bin/env node
// Closes a budget: SPL `Revoke(tokenAccount, owner)` clears the delegate of the keypair's associated token account
// (docs/SPEC.md §3.4; the gateway's scanner marks the budget `closed`). Prints one JSON line:
// { signature, slot, owner, tokenAccount, mint }.
//
//   node scripts/e2e/revoke.mjs --keypair <path> --mint <base58> [--rpc http://127.0.0.1:8899] [--token-account <base58>]
import { web3, splToken, DEFAULT_RPC, parseArgs, loadKeypair, pubkey, mintContext, ataFor, sendAndConfirm, out } from './_common.mjs';

const args = parseArgs(
  process.argv.slice(2),
  {
    keypair: { required: true, help: 'owner keypair file (solana-keygen JSON)' },
    mint: { required: true, help: 'mint address (base58)' },
    rpc: { default: DEFAULT_RPC, help: 'JSON-RPC URL' },
    'token-account': { help: 'token account whose delegate is revoked (default: the owner\'s ATA)' },
  },
  'node scripts/e2e/revoke.mjs --keypair <path> --mint <base58> [--rpc <url>]',
);

const owner = loadKeypair(args.keypair);
const mint = pubkey(args.mint, '--mint');
const connection = new web3.Connection(args.rpc, 'confirmed');
const { programId } = await mintContext(connection, mint);
const tokenAccount = args['token-account'] ? pubkey(args['token-account'], '--token-account') : ataFor(owner.publicKey, mint, programId);

const ix = splToken.createRevokeInstruction(tokenAccount, owner.publicKey, [], programId);
const { signature, slot } = await sendAndConfirm(connection, [ix], [owner]);
out({ signature, slot, owner: owner.publicKey.toBase58(), tokenAccount: tokenAccount.toBase58(), mint: mint.toBase58() });
