#!/usr/bin/env node
// Calls ONE tool of the `beagle-mcp` stdio binary (packages/mcp/dist/bin.js) the way an MCP client does — spawn the
// binary, initialize, tools/call, close — and prints the tool's structured result as one JSON line (exit 1, same line,
// when the tool reports isError). The binary is configured by the inherited environment: BEAGLE_API_URL, BEAGLE_API_KEY,
// BEAGLE_AGENT_SECRET_KEY (with it the wallet tools sign and send), BEAGLE_RPC_URL, BEAGLE_WORKSPACE. The e2e uses
// it to run the real Keypair executor (memo, confirmation, budget registration) against solana-test-validator
// (docs/SPEC.md §8); the package's own tests only see a scripted fake connection.
//
//   node scripts/e2e/mcp-call.mjs <tool> [<json-arguments>] [--timeout <ms>]
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = resolve(ROOT, 'packages/mcp/dist/bin.js');

// @modelcontextprotocol/sdk is a dependency of @beagle/mcp, not of the root. `require.resolve` from there picks the
// package's CommonJS build (the `require` export condition); the sibling ESM build is used when present.
const require = createRequire(resolve(ROOT, 'packages/mcp/package.json'));
function sdk(file) {
  const cjs = require.resolve(`@modelcontextprotocol/sdk/client/${file}`);
  const esm = cjs.replace(/([\\/])dist\1cjs\1/, '$1dist$1esm$1');
  return import(pathToFileURL(existsSync(esm) ? esm : cjs).href);
}
const [{ Client }, { StdioClientTransport }] = await Promise.all([sdk('index.js'), sdk('stdio.js')]);

function die(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
let timeoutMs = 120_000;
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--timeout') {
    timeoutMs = Number(argv[++i]);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) die('--timeout needs a positive integer (ms)');
  } else if (argv[i] === '-h' || argv[i] === '--help') {
    process.stdout.write('usage: node scripts/e2e/mcp-call.mjs <tool> [<json-arguments>] [--timeout <ms>]\n');
    process.exit(0);
  } else {
    positional.push(argv[i]);
  }
}
const [tool, argsJson] = positional;
if (tool === undefined) die('usage: node scripts/e2e/mcp-call.mjs <tool> [<json-arguments>] [--timeout <ms>]');
let args = {};
if (argsJson !== undefined) {
  try {
    args = JSON.parse(argsJson);
  } catch (e) {
    die(`arguments are not valid JSON (${e instanceof Error ? e.message : String(e)}): ${argsJson}`);
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) die('arguments must be a JSON object');
}
if (!existsSync(BIN)) die(`${BIN} is missing: build @beagle/mcp first (pnpm --filter @beagle/mcp build)`);
if (!process.env.BEAGLE_API_KEY) die('BEAGLE_API_KEY is required in the environment (the binary refuses to start without it)');

// The transport's default environment keeps only a few "safe" variables; the binary needs the BEAGLE_* ones.
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string'));
const transport = new StdioClientTransport({ command: process.execPath, args: [BIN], env, stderr: 'inherit' });
const client = new Client({ name: 'beagle-e2e', version: '0.0.0' });
await client.connect(transport);
let result;
try {
  result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs });
} finally {
  await client.close().catch(() => undefined);
}
const text = (result.content ?? []).find((c) => c.type === 'text')?.text;
const data = result.structuredContent ?? (text === undefined ? result : JSON.parse(text));
process.stdout.write(`${JSON.stringify(data)}\n`);
if (result.isError) {
  process.stderr.write(`mcp-call: ${tool} reported an error\n`);
  process.exit(1);
}
