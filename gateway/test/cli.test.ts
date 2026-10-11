import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseArgs, runCli } from '../src/cli.js';
import { MIGRATIONS } from '../src/db/schema.js';
import { WS1 } from './helpers.js';

describe('cli', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beagle-cli-'));
  const env = { NODE_ENV: 'test', DB_PATH: join(dir, 'gw.sqlite'), SESSION_SECRET: 'cli-secret-cli-secret-cli-secret', LOG_LEVEL: 'error' };
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('parses commands and flags', () => {
    expect(parseArgs(['create-key', '--workspace', WS1, '--name', 'e2e-1'])).toEqual({ command: 'create-key', flags: { workspace: WS1, name: 'e2e-1' } });
    expect(parseArgs(['credit', '--usd=10', '--force'])).toEqual({ command: 'credit', flags: { usd: '10', force: true } });
  });

  it('migrate, create-key prints the key on stdout, credit adjusts, status prints JSON', async () => {
    const out: string[] = [];
    const err: string[] = [];
    expect(await runCli(['migrate'], env, (s) => out.push(s), (s) => err.push(s))).toBe(0);
    expect(out[0]).toMatch(new RegExp(`schema 0 → ${MIGRATIONS.length}$`));
    out.length = 0;
    expect(await runCli(['create-key', '--workspace', WS1, '--name', 'e2e-1'], env, (s) => out.push(s), (s) => err.push(s))).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^bgl_[A-Za-z0-9_-]{43}$/);
    expect(err.join('\n')).not.toContain(out[0]!);
    out.length = 0;
    expect(await runCli(['credit', '--workspace', WS1, '--usd', '2.5', '--memo', 'promo'], env, (s) => out.push(s), (s) => err.push(s))).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ ok: true, amountMicro: '2500000', balanceMicro: '2500000' });
    out.length = 0;
    expect(await runCli(['credit', '--workspace', WS1, '--usd', '1'], { ...env, NODE_ENV: 'production' }, (s) => out.push(s), (s) => err.push(s))).toBe(1);
    expect(await runCli(['status'], env, (s) => out.push(s), (s) => err.push(s))).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ chainId: 31337, version: '0.1.0' });
    expect(await runCli([], env, (s) => out.push(s), (s) => err.push(s))).toBe(1);
    expect(await runCli(['bogus'], env, (s) => out.push(s), (s) => err.push(s))).toBe(1);
    expect(await runCli(['create-key'], env, (s) => out.push(s), (s) => err.push(s))).toBe(1);
    expect(err.at(-1)).toContain('--workspace is required');
  });
});
