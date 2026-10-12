import { createSiwsMessage, siwsExpiration, siwsTimestamp, type SiwsFields } from '@beagle/shared/siws';
import { encodeBase58 } from '@beagle/shared/solana';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import { API_KEY_PATTERN, ApiKeyService, apiKeyPrefix, extractApiKey, generateApiKey, hashApiKey } from '../src/auth/apiKeys.js';
import { Keyring, KeyringError, safeEqual, sha256Hex } from '../src/auth/crypto.js';
import { extractSessionToken, parseCookies, sessionCookie, SessionService } from '../src/auth/session.js';
import { decodeSignature, SiwsService, SIWS_NONCE_TTL_MS } from '../src/auth/siws.js';
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

  it('creates, authenticates, touches last_used_at once a minute and revokes; workspaces are base58 verbatim', () => {
    const r = repos();
    let now = 1_000_000;
    const svc = new ApiKeyService(r.apiKeys, r.workspaces, () => now);
    const created = svc.create(` ${WS1} `, 'ci');
    expect(r.workspaces.get(WS1)).toBeDefined();
    expect(r.workspaces.get(WS1.toLowerCase())).toBeUndefined(); // base58 is case-sensitive: no lowercasing
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

describe('SIWS', () => {
  const T0 = 1_791_808_200_000;
  const keypair = nacl.sign.keyPair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
  const other = nacl.sign.keyPair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => 100 + i));
  const address = encodeBase58(keypair.publicKey);
  const expected = { domain: 'localhost:8787', uri: 'http://localhost:8787', chainId: 'solana:localnet' } as const;

  function service(now: () => number = () => T0): SiwsService {
    return new SiwsService(repos().nonces, { ...expected, now });
  }

  function message(svc: SiwsService, overrides: Partial<SiwsFields> = {}, now = T0, omit: (keyof SiwsFields)[] = []): string {
    const nonce = overrides.nonce ?? svc.issueNonce();
    const fields: SiwsFields = {
      domain: expected.domain,
      address,
      statement: 'Sign in to Beagle.',
      uri: `${expected.uri}/`,
      version: '1',
      chainId: expected.chainId,
      nonce,
      issuedAt: siwsTimestamp(now),
      expirationTime: siwsExpiration(now),
      ...overrides,
    };
    for (const key of omit) delete fields[key];
    return createSiwsMessage(fields);
  }

  function sign(text: string, key: nacl.SignKeyPair = keypair, encoding: 'base58' | 'base64' = 'base58'): string {
    const sig = nacl.sign.detached(new TextEncoder().encode(text), key.secretKey);
    return encoding === 'base58' ? encodeBase58(sig) : Buffer.from(sig).toString('base64');
  }

  it('verifies a base58 or base64 signature over the exact text and consumes the nonce', () => {
    const svc = service();
    const text = message(svc);
    const ok = svc.verify(text, sign(text), address);
    expect(ok).toMatchObject({ ok: true, address });
    const replay = svc.verify(text, sign(text), address);
    expect(replay).toMatchObject({ ok: false, code: 'nonce_unknown' });
    const text64 = message(svc);
    expect(svc.verify(text64, sign(text64, keypair, 'base64'), address)).toMatchObject({ ok: true });
    expect(svc.issueNonce()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('reports each validation failure with its code', () => {
    const svc = service();
    const check = (text: string, signature: string, publicKey: string, code: string): void => {
      const res = svc.verify(text, signature, publicKey);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe(code);
    };
    const wrongDomain = message(svc, { domain: 'evil.example' });
    check(wrongDomain, sign(wrongDomain), address, 'domain_mismatch');
    const wrongChain = message(svc, { chainId: 'solana:mainnet' });
    check(wrongChain, sign(wrongChain), address, 'chain_mismatch');
    const wrongUri = message(svc, { uri: 'http://evil.example/' });
    check(wrongUri, sign(wrongUri), address, 'uri_mismatch');
    const unknownNonce = message(svc, { nonce: 'abcdefgh12345678' });
    check(unknownNonce, sign(unknownNonce), address, 'nonce_unknown');
    const expired = message(svc, { expirationTime: siwsTimestamp(T0 - 1000) });
    check(expired, sign(expired), address, 'expired');
    const future = message(svc, { issuedAt: siwsTimestamp(T0 + 6 * 60_000) });
    check(future, sign(future), address, 'issued_at_future');
    const noNonce = message(svc, {}, T0, ['nonce']);
    check(noNonce, sign(noNonce), address, 'nonce_missing');
    const fine = message(svc);
    check(fine, sign(fine), encodeBase58(other.publicKey), 'address_mismatch');
    check(fine, sign(fine, other), address, 'bad_signature');
    check(fine, encodeBase58(new Uint8Array(63).fill(7)), address, 'invalid_signature');
    check(fine, 'not-a-signature', address, 'invalid_signature');
    check(fine, sign(fine), 'not-a-key', 'invalid_public_key');
    check('hello', sign('hello'), address, 'invalid_message');
    // The nonce survives a failed signature check and is consumed by the successful one.
    expect(svc.verify(fine, sign(fine), address)).toMatchObject({ ok: true });
  });

  it('expires nonces after 10 minutes and purges them from housekeeping', () => {
    let now = T0;
    const r = repos();
    const svc = new SiwsService(r.nonces, { ...expected, now: () => now });
    const text = message(svc);
    const signature = sign(text);
    now += SIWS_NONCE_TTL_MS + 1;
    expect(svc.verify(text, signature, address)).toMatchObject({ ok: false, code: 'nonce_unknown' });
    expect(svc.purgeExpired()).toBe(1);
    expect(decodeSignature(signature)?.length).toBe(64);
    expect(decodeSignature('x')).toBeUndefined();
  });
});

describe('crypto', () => {
  it('AES-256-GCM round-trips and binds the AAD', () => {
    const k = new Keyring(Buffer.from('11'.repeat(32), 'hex'));
    const enc = k.encrypt('sk-ant-secret', WS1, 'anthropic');
    expect(enc.iv).toHaveLength(12);
    expect(k.decrypt(enc, WS1, 'anthropic')).toBe('sk-ant-secret');
    expect(() => k.decrypt(enc, WS1, 'openai')).toThrow(KeyringError);
    expect(() => k.decrypt(enc, WS1.toLowerCase(), 'anthropic')).toThrow(KeyringError); // AAD is the base58 workspace verbatim (case-sensitive)
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
  it('never prints API keys, provider keys, bearer tokens or secret keys', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'debug', write: (l) => lines.push(l) });
    const key = generateApiKey();
    const signature = '5X31v1NFMMuZdh6dipB1DmvM2Ysn31ww62f3dauoqaPUi1JfdgdDH6hjdGER8HQeg46WzyxPoktbiD22a5r2Ee3j';
    log.info('auth ok', { key, apiKey: 'sk-ant-api03-abcdefghijklmnop', header: 'Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnop', secretKey: '[1,2,3,4]', signature, nested: { token: 'secret-value', sessionSecret: 'sess' } });
    const out = lines.join('\n');
    expect(out).not.toContain(key);
    expect(out).not.toContain('sk-ant-api03');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(out).not.toContain('[1,2,3,4]');
    expect(out).not.toContain('secret-value');
    expect(out).not.toContain('"sess"');
    expect(out).toContain(signature);
    expect(out).toContain('[redacted]');
    expect(redactString(`key ${key} used`)).toBe('key [redacted] used');
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'info', msg: 'auth ok' });
    // URLs with userinfo / key query parameters, and byte arrays under secret-named keys (a Keypair's secretKey).
    log.info('boot', {
      rpcUrl: 'https://mainnet.helius-rpc.com/?api-key=SECRET-KEY-123&x=1',
      feed: 'https://user:PASSWORD@feed.example/p?a=1',
      operator: { secretKey: new Uint8Array([1, 2, 3, 4, 5]) },
      keypair: { _keypair: { secretKey: new Uint8Array([9, 9, 9]) } },
      bytes: new Uint8Array([7, 7]),
      explorer: 'https://explorer.solana.com/tx/abc?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899',
    });
    const boot = lines.at(-1)!;
    expect(boot).not.toContain('SECRET-KEY-123');
    expect(boot).toContain('api-key=[redacted]&x=1');
    expect(boot).not.toContain('PASSWORD');
    expect(boot).toContain('https://[redacted]@feed.example/p?a=1');
    expect(boot).not.toContain('"0":');
    expect(boot).toContain('"operator":{"secretKey":"[redacted]"}');
    expect(boot).toContain('"_keypair":{"secretKey":"[redacted]"}');
    expect(boot).toContain('"bytes":"[bytes:2]"');
    expect(boot).toContain('customUrl=http%3A%2F%2F127.0.0.1%3A8899');
    expect(redactString('https://x.example/?key=abc&apikey=def&token=ghi')).toBe('https://x.example/?key=[redacted]&apikey=[redacted]&token=[redacted]');
  });

  it('respects the level threshold', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'warn', write: (l) => lines.push(l) });
    log.info('hidden');
    log.warn('shown');
    expect(lines).toHaveLength(1);
  });
});
