import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { describe, expect, it } from 'vitest';
import { API_KEY_PATTERN, ApiKeyService, apiKeyPrefix, extractApiKey, generateApiKey, hashApiKey } from '../src/auth/apiKeys.js';
import { Keyring, KeyringError, safeEqual, sha256Hex } from '../src/auth/crypto.js';
import { extractSessionToken, parseCookies, sessionCookie, SessionService } from '../src/auth/session.js';
import { SiweService } from '../src/auth/siwe.js';
import { Repos } from '../src/db/repos.js';
import { migrate } from '../src/db/schema.js';
import { Db } from '../src/db/sqlite.js';
import { createLogger, redactString } from '../src/log.js';
import { WS1 } from './helpers.js';

function repos(): Repos {
  const db = new Db(':memory:');
  migrate(db);
  return new Repos(db);
}

describe('API keys', () => {
  it('generates bgl_ + 43 base64url chars, hashes with sha256 and exposes a 12-char prefix', () => {
    const key = generateApiKey();
    expect(key).toMatch(API_KEY_PATTERN);
    expect(hashApiKey(key)).toBe(sha256Hex(key));
    expect(apiKeyPrefix(key)).toHaveLength(12);
    expect(apiKeyPrefix(key).startsWith('bgl_')).toBe(true);
  });

  it('creates, authenticates, touches last_used_at once a minute and revokes', () => {
    const r = repos();
    let now = 1_000_000;
    const svc = new ApiKeyService(r.apiKeys, r.workspaces, () => now);
    const created = svc.create(WS1.toUpperCase(), 'ci');
    expect(r.workspaces.get(WS1)).toBeDefined();
    const auth = svc.authenticate(created.key);
    expect(auth?.workspace).toBe(WS1);
    expect(r.apiKeys.byId(created.id)?.lastUsedAt).toBe(now);
    now += 1000;
    svc.authenticate(created.key);
    expect(r.apiKeys.byId(created.id)?.lastUsedAt).toBe(now - 1000);
    now += 60_000;
    svc.authenticate(created.key);
    expect(r.apiKeys.byId(created.id)?.lastUsedAt).toBe(now);
    expect(svc.authenticate('bgl_nope')).toBeUndefined();
    expect(svc.authenticate('sk-other')).toBeUndefined();
    expect(svc.revoke(created.id, WS1)).toBe(true);
    expect(svc.revoke(created.id, WS1)).toBe(false);
    expect(svc.authenticate(created.key)).toBeUndefined();
    expect(svc.list(WS1)).toHaveLength(0);
  });

  it('extracts keys from bearer and x-api-key headers', () => {
    expect(extractApiKey(new Headers({ authorization: 'Bearer bgl_abc' }))).toBe('bgl_abc');
    expect(extractApiKey(new Headers({ 'x-api-key': 'bgl_xyz' }))).toBe('bgl_xyz');
    expect(extractApiKey(new Headers({ authorization: 'Bearer sess_123' }))).toBeUndefined();
    expect(extractApiKey(new Headers())).toBeUndefined();
  });
});

describe('sessions', () => {
  it('creates, resolves, expires and destroys sessions; stores only an HMAC', () => {
    const r = repos();
    let now = 5_000;
    r.workspaces.ensure(WS1, now);
    const svc = new SessionService(r.sessions, 'secret', () => now);
    const { token } = svc.create(WS1);
    expect(r.sessions.get(token)).toBeUndefined();
    expect(svc.resolve(token)?.workspace).toBe(WS1);
    now += 7 * 24 * 3600 * 1000 + 1;
    expect(svc.resolve(token)).toBeUndefined();
    const second = svc.create(WS1).token;
    svc.destroy(second);
    expect(svc.resolve(second)).toBeUndefined();
  });

  it('parses cookies and builds Set-Cookie', () => {
    expect(parseCookies('a=1; beagle_session=tok%20en; b=2').get('beagle_session')).toBe('tok en');
    expect(extractSessionToken(new Headers({ cookie: 'beagle_session=abcdefghijklmnopqrstuvwxyz' }))).toBe('abcdefghijklmnopqrstuvwxyz');
    expect(extractSessionToken(new Headers({ authorization: 'Bearer sess_abcdefghijklmnop' }))).toBe('sess_abcdefghijklmnop');
    expect(extractSessionToken(new Headers({ authorization: 'Bearer bgl_abcdefghijklmnop' }))).toBeUndefined();
    expect(sessionCookie('t', true)).toContain('Secure');
    expect(sessionCookie('t', false)).not.toContain('Secure');
    expect(sessionCookie(null, false)).toContain('Max-Age=0');
  });
});

describe('SIWE', () => {
  const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

  async function signed(svc: SiweService, overrides: Partial<Parameters<typeof createSiweMessage>[0]> = {}): Promise<{ message: string; signature: `0x${string}` }> {
    const nonce = svc.issueNonce();
    const message = createSiweMessage({ address: account.address, chainId: 31337, domain: 'localhost:8787', nonce, uri: 'http://localhost:8787', version: '1', ...overrides });
    const signature = await account.signMessage({ message });
    return { message, signature };
  }

  it('verifies an EOA signature offline and consumes the nonce', async () => {
    const r = repos();
    const svc = new SiweService(r.nonces, { domain: 'localhost:8787' });
    const { message, signature } = await signed(svc);
    const first = await svc.verify(message, signature);
    expect(first).toEqual({ ok: true, address: account.address, chainId: 31337 });
    const replay = await svc.verify(message, signature);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.code).toBe('bad_nonce');
  });

  it('rejects wrong domain, unsupported chain, bad signature and unknown nonce', async () => {
    const r = repos();
    const svc = new SiweService(r.nonces, { domain: 'localhost:8787' });
    const wrongDomain = await signed(svc, { domain: 'evil.example' });
    expect((await svc.verify(wrongDomain.message, wrongDomain.signature)).ok).toBe(false);
    const wrongChain = await signed(svc, { chainId: 1 });
    expect((await svc.verify(wrongChain.message, wrongChain.signature)).ok).toBe(false);
    const other = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
    const nonce = svc.issueNonce();
    const message = createSiweMessage({ address: account.address, chainId: 31337, domain: 'localhost:8787', nonce, uri: 'http://localhost:8787', version: '1' });
    const forged = await other.signMessage({ message });
    const res = await svc.verify(message, forged);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('bad_signature');
    const unknownNonce = createSiweMessage({ address: account.address, chainId: 31337, domain: 'localhost:8787', nonce: 'abcdefgh12345678', uri: 'http://localhost:8787', version: '1' });
    const r2 = await svc.verify(unknownNonce, await account.signMessage({ message: unknownNonce }));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('bad_nonce');
    expect((await svc.verify('not a siwe message', '0x00')).ok).toBe(false);
  });

  it('honours an injected verifier', async () => {
    const r = repos();
    const svc = new SiweService(r.nonces, { domain: 'localhost:8787', verifier: async () => true });
    const nonce = svc.issueNonce();
    const message = createSiweMessage({ address: account.address, chainId: 4663, domain: 'localhost:8787', nonce, uri: 'http://localhost:8787', version: '1' });
    expect((await svc.verify(message, '0x1234')).ok).toBe(true);
  });
});

describe('crypto', () => {
  it('AES-256-GCM round-trips and binds the AAD', () => {
    const k = new Keyring(Buffer.from('11'.repeat(32), 'hex'));
    const enc = k.encrypt('sk-ant-secret', WS1, 'anthropic');
    expect(enc.iv).toHaveLength(12);
    expect(k.decrypt(enc, WS1, 'anthropic')).toBe('sk-ant-secret');
    expect(() => k.decrypt(enc, WS1, 'openai')).toThrow(KeyringError);
    expect(() => k.decrypt({ ...enc, tag: new Uint8Array(16) }, WS1, 'anthropic')).toThrow(KeyringError);
    expect(() => new Keyring(Buffer.alloc(16))).toThrow(KeyringError);
  });

  it('safeEqual compares constant-time-ish', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('logging redaction', () => {
  it('never prints API keys, provider keys, bearer tokens or private keys', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'debug', write: (l) => lines.push(l) });
    const key = generateApiKey();
    const txHash = '0x' + 'cd'.repeat(32);
    log.info('auth ok', { key, apiKey: 'sk-ant-api03-abcdefghijklmnop', header: 'Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnop', privateKey: '0x' + 'ab'.repeat(32), txHash, nested: { token: 'secret-value', sessionSecret: 'sess' } });
    const out = lines.join('\n');
    expect(out).not.toContain(key);
    expect(out).not.toContain('sk-ant-api03');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(out).not.toContain('ab'.repeat(32));
    expect(out).not.toContain('secret-value');
    expect(out).not.toContain('"sess"');
    expect(out).toContain(txHash);
    expect(out).toContain('[redacted]');
    expect(redactString(`key ${key} used`)).toBe('key [redacted] used');
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'info', msg: 'auth ok' });
  });

  it('respects the level threshold', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'warn', write: (l) => lines.push(l) });
    log.info('hidden');
    log.warn('shown');
    expect(lines).toHaveLength(1);
  });
});
