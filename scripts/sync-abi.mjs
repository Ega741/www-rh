#!/usr/bin/env node
/**
 * Copies compiled ABIs from contracts/out into packages/shared/abi/*.json and checks that the
 * human-readable ABI exported by @www-rh/shared matches the compiled contracts exactly
 * (functions, events and errors compared by canonical signature).
 *
 * Usage: node scripts/sync-abi.mjs [--no-check]
 * Requires: `forge build` (contracts/out) and `pnpm --filter @www-rh/shared build` (dist/abi.js).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'contracts', 'out');
const abiDir = path.join(root, 'packages', 'shared', 'abi');
const noCheck = process.argv.includes('--no-check');

const CONTRACTS = [
  { name: 'MindLaunchpad', shared: 'mindLaunchpadAbi' },
  { name: 'MindToken', shared: 'mindTokenAbi' },
  // SPEC §3.3: graduatorAbi = IGraduator + GraduatedAtSkewedPrice + implementation errors, so its
  // events/errors may come from the compiled graduator implementations (functions must match IGraduator).
  { name: 'IGraduator', shared: 'graduatorAbi', alsoFrom: ['UniswapV3Graduator', 'MockGraduator'] },
  { name: 'UniswapV3Graduator', shared: null },
  { name: 'MockGraduator', shared: null },
];

function typeOf(input) {
  if (input.type.startsWith('tuple')) {
    const inner = `(${(input.components ?? []).map(typeOf).join(',')})`;
    return input.type.replace('tuple', inner);
  }
  return input.type;
}
function sig(item) {
  return `${item.type} ${item.name}(${(item.inputs ?? []).map(typeOf).join(',')})`;
}
function signatures(abi) {
  return new Set(abi.filter((i) => ['function', 'event', 'error'].includes(i.type)).map(sig));
}

mkdirSync(abiDir, { recursive: true });
let failed = false;
let sharedAbi = null;
if (!noCheck) {
  const distPath = path.join(root, 'packages', 'shared', 'dist', 'abi.js');
  if (!existsSync(distPath)) {
    console.error(`missing ${distPath}: run \`pnpm --filter @www-rh/shared build\` first (or pass --no-check)`);
    process.exit(2);
  }
  sharedAbi = await import(distPath);
}

function implementationSignatures(names) {
  const out = new Set();
  for (const ref of names ?? []) {
    const file = path.join(outDir, `${ref}.sol`, `${ref}.json`);
    if (!existsSync(file)) continue;
    for (const s of signatures(JSON.parse(readFileSync(file, 'utf8')).abi)) if (!s.startsWith('function ')) out.add(s);
  }
  return out;
}

for (const { name, shared, alsoFrom } of CONTRACTS) {
  const artifact = path.join(outDir, `${name}.sol`, `${name}.json`);
  if (!existsSync(artifact)) {
    console.error(`missing artifact ${artifact}: run \`forge build\` in contracts/ first`);
    process.exit(2);
  }
  const abi = JSON.parse(readFileSync(artifact, 'utf8')).abi;
  writeFileSync(path.join(abiDir, `${name}.json`), JSON.stringify(abi, null, 2) + '\n');
  console.log(`wrote packages/shared/abi/${name}.json (${abi.length} items)`);
  if (sharedAbi && shared) {
    const expected = signatures(abi);
    const actual = signatures(sharedAbi[shared]);
    // The shared ABI for MindToken only needs to be a subset (ERC20 surface); others must match exactly.
    const missing = [...expected].filter((s) => !actual.has(s));
    const fromImplementations = implementationSignatures(alsoFrom);
    const extra = [...actual].filter((s) => !expected.has(s) && !fromImplementations.has(s));
    const subsetOk = name === 'MindToken';
    if ((missing.length && !subsetOk) || extra.length) {
      failed = true;
      console.error(`ABI mismatch for ${name} vs @www-rh/shared.${shared}:`);
      if (!subsetOk) for (const s of missing) console.error(`  missing in shared: ${s}`);
      for (const s of extra) console.error(`  not in compiled:   ${s}`);
    } else {
      console.log(`ok: @www-rh/shared.${shared} matches ${name}${subsetOk ? ' (subset)' : ''}`);
    }
  }
}
process.exit(failed ? 1 : 0);
