// Shared bits of the e2e chain helpers (burn.mjs, approve.mjs, revoke.mjs). Plain Node ESM, no root
// dependencies: @solana/web3.js, @solana/spl-token and @solana/spl-memo are resolved from the gateway's
// node_modules through createRequire(gateway/package.json), so `pnpm install` is the only prerequisite.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(resolve(ROOT, 'gateway/package.json'));

/** @type {typeof import('@solana/web3.js')} */
export const web3 = require('@solana/web3.js');
/** @type {typeof import('@solana/spl-token')} */
export const splToken = require('@solana/spl-token');

export const DEFAULT_RPC = 'http://127.0.0.1:8899';

/** SPL Memo v3 — the program the gateway indexes (docs/SPEC.md §1) and the one solana-test-validator ships. */
export const MEMO_PROGRAM_ID = new web3.PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

/**
 * Builds an SPL Memo instruction. Deliberately not `createMemoInstruction` from `@solana/spl-memo` 0.3.x: its
 * `MEMO_PROGRAM_ID` is the Memo **v4** program (`Memo4c2pN8afCj432Lb7RMVKi9PbQnnW7ewFFaV3oAH`), absent from the test
 * validator and not what the indexer parses as `spl-memo`.
 * @param {string} memo UTF-8 text (≤ 256 bytes for Beagle memos)
 * @param {import('@solana/web3.js').PublicKey[]} signers accounts that must sign (the memo program checks them)
 * @param {import('@solana/web3.js').PublicKey} [programId]
 */
export function createMemoInstruction(memo, signers, programId = MEMO_PROGRAM_ID) {
  return new web3.TransactionInstruction({
    programId,
    keys: signers.map((pubkey) => ({ pubkey, isSigner: true, isWritable: false })),
    data: Buffer.from(memo, 'utf8'),
  });
}

/**
 * Minimal `--name value` / `--flag` parser.
 * @param {string[]} argv
 * @param {Record<string, { required?: boolean; default?: string; flag?: boolean; help: string }>} spec
 * @param {string} usage
 */
export function parseArgs(argv, spec, usage) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      printUsage(spec, usage);
      process.exit(0);
    }
    if (!a.startsWith('--')) die(`unexpected argument ${a}\n\n${usageText(spec, usage)}`);
    const name = a.slice(2);
    const s = spec[name];
    if (!s) die(`unknown option --${name}\n\n${usageText(spec, usage)}`);
    if (s.flag) {
      out[name] = true;
      continue;
    }
    const v = argv[i + 1];
    if (v === undefined) die(`--${name} needs a value`);
    out[name] = v;
    i++;
  }
  for (const [name, s] of Object.entries(spec)) {
    if (out[name] === undefined && s.default !== undefined) out[name] = s.default;
    if (s.required && out[name] === undefined) die(`--${name} is required\n\n${usageText(spec, usage)}`);
  }
  return out;
}
function usageText(spec, usage) {
  const opts = Object.entries(spec)
    .map(([n, s]) => `  --${n}${s.flag ? '' : ' <value>'}${s.required ? ' (required)' : s.default !== undefined ? ` (default ${s.default})` : ''}  ${s.help}`)
    .join('\n');
  return `usage: ${usage}\n${opts}`;
}
function printUsage(spec, usage) {
  process.stdout.write(`${usageText(spec, usage)}\n`);
}

/** @param {string} msg */
export function die(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

/** Loads a `solana-keygen` JSON keypair file. */
export function loadKeypair(path) {
  const bytes = Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')));
  return web3.Keypair.fromSecretKey(bytes);
}

/** Parses a base58 public key or dies with a readable message. */
export function pubkey(s, what) {
  try {
    return new web3.PublicKey(s);
  } catch {
    return die(`${what} is not a valid base58 public key: ${s}`);
  }
}

/**
 * Whole-token decimal string ("1000", "0.5") → raw bigint for `decimals`.
 * @param {string} s
 * @param {number} decimals
 */
export function toRawAmount(s, decimals) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(s).trim());
  if (!m) die(`amount must be a decimal number of whole tokens, got ${JSON.stringify(s)}`);
  const whole = m[1];
  const frac = (m[2] ?? '').padEnd(decimals, '0');
  if (frac.length > decimals) die(`amount has more than ${decimals} fraction digits: ${s}`);
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac || '0');
  if (raw <= 0n) die('amount must be positive');
  return raw;
}

/**
 * Reads the mint: its owning token program and decimals.
 * @param {import('@solana/web3.js').Connection} connection
 * @param {import('@solana/web3.js').PublicKey} mint
 */
export async function mintContext(connection, mint) {
  const info = await connection.getAccountInfo(mint, 'confirmed');
  if (!info) die(`mint ${mint.toBase58()} does not exist on this cluster`);
  const programId = info.owner;
  if (!programId.equals(splToken.TOKEN_PROGRAM_ID) && !programId.equals(splToken.TOKEN_2022_PROGRAM_ID)) {
    die(`mint ${mint.toBase58()} is owned by ${programId.toBase58()}, not an SPL Token program`);
  }
  const m = await splToken.getMint(connection, mint, 'confirmed', programId);
  return { programId, decimals: m.decimals };
}

/** The owner's associated token account of `mint` under `programId`. */
export function ataFor(owner, mint, programId) {
  return splToken.getAssociatedTokenAddressSync(mint, owner, false, programId);
}

/**
 * Builds a legacy transaction, signs it, sends it and waits for `confirmed` using the blockhash/height pair.
 * @param {import('@solana/web3.js').Connection} connection
 * @param {import('@solana/web3.js').TransactionInstruction[]} instructions
 * @param {import('@solana/web3.js').Keypair[]} signers first signer = fee payer
 */
export async function sendAndConfirm(connection, instructions, signers) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new web3.Transaction({ feePayer: signers[0].publicKey, blockhash, lastValidBlockHeight });
  tx.add(...instructions);
  tx.sign(...signers);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  if (res.value.err) die(`transaction ${signature} failed: ${JSON.stringify(res.value.err)}`);
  return { signature, slot: res.context.slot };
}

/** Prints the result as one JSON line on stdout (the e2e script parses it). */
export function out(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
