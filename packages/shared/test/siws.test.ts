import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { clusterCaip } from '../src/clusters.js';
import {
  SIWS_DEFAULT_MAX_SKEW_MS,
  SIWS_DEFAULT_STATEMENT,
  SIWS_DEFAULT_TTL_MS,
  SIWS_VERSION,
  SiwsParseError,
  createSiwsMessage,
  parseSiwsMessage,
  parseSiwsTimestamp,
  siwsExpiration,
  siwsTimestamp,
  validateSiwsFields,
  type BeagleSiwsFields,
  type SiwsExpectations,
  type SiwsFields,
  type SiwsProblemCode,
} from '../src/siws.js';

const ADDRESS = bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => i + 1)); // 4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw
const OTHER = bs58.encode(new Uint8Array(32).fill(255));
const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const ISSUED = '2026-10-12T11:59:30.000Z';
const EXPIRES = '2026-10-12T12:09:30.000Z';

const fields: BeagleSiwsFields = {
  domain: 'localhost:5173',
  address: ADDRESS,
  statement: SIWS_DEFAULT_STATEMENT,
  uri: 'http://localhost:5173/',
  version: '1',
  chainId: 'solana:localnet',
  nonce: 'n0nceN0nce12',
  issuedAt: ISSUED,
  expirationTime: EXPIRES,
};

const expected = {
  domain: 'localhost:5173',
  uri: 'http://localhost:5173',
  chainId: clusterCaip('localnet'),
  now: NOW,
  nonceOk: (n: string) => n === fields.nonce,
  address: ADDRESS,
};

function codes(problems: ReturnType<typeof validateSiwsFields>): SiwsProblemCode[] {
  return problems.map((p) => p.code);
}

describe('createSiwsMessage (SPEC §4.1 layout)', () => {
  it('produces the wallet-standard text', () => {
    expect(createSiwsMessage(fields)).toBe(
      [
        `localhost:5173 wants you to sign in with your Solana account:`,
        ADDRESS,
        '',
        SIWS_DEFAULT_STATEMENT,
        '',
        'URI: http://localhost:5173/',
        'Version: 1',
        'Chain ID: solana:localnet',
        'Nonce: n0nceN0nce12',
        `Issued At: ${ISSUED}`,
        `Expiration Time: ${EXPIRES}`,
      ].join('\n'),
    );
  });

  it('omits the statement block when there is no statement, and supports the optional fields', () => {
    const { statement: _s, ...noStatement } = fields;
    expect(createSiwsMessage(noStatement)).toBe(
      `localhost:5173 wants you to sign in with your Solana account:\n${ADDRESS}\n\nURI: http://localhost:5173/\nVersion: 1\nChain ID: solana:localnet\nNonce: n0nceN0nce12\nIssued At: ${ISSUED}\nExpiration Time: ${EXPIRES}`,
    );
    const full = createSiwsMessage({ ...fields, notBefore: ISSUED, requestId: 'req-1', resources: ['https://a.example/x', 'ipfs://y'] });
    expect(full.endsWith(`Expiration Time: ${EXPIRES}\nNot Before: ${ISSUED}\nRequest ID: req-1\nResources:\n- https://a.example/x\n- ipfs://y`)).toBe(true);
    expect(createSiwsMessage({ domain: 'a.b', address: ADDRESS })).toBe(`a.b wants you to sign in with your Solana account:\n${ADDRESS}`);
    expect(createSiwsMessage({ domain: 'a.b', address: ADDRESS, statement: 'Hi' })).toBe(`a.b wants you to sign in with your Solana account:\n${ADDRESS}\n\nHi`);
  });

  it('rejects unsafe input', () => {
    expect(() => createSiwsMessage({ ...fields, domain: '' })).toThrow(TypeError);
    expect(() => createSiwsMessage({ ...fields, domain: 'local host' })).toThrow(/whitespace/);
    expect(() => createSiwsMessage({ ...fields, domain: 'a\nb' })).toThrow(/line breaks/);
    expect(() => createSiwsMessage({ ...fields, address: 'not-a-key' })).toThrow(/base58/);
    expect(() => createSiwsMessage({ ...fields, nonce: 'abc\nURI: http://evil/' })).toThrow(/line breaks/);
    expect(() => createSiwsMessage({ ...fields, uri: 'http://x/\r\n' })).toThrow(/line breaks/);
    expect(() => createSiwsMessage({ ...fields, statement: '\nhello' })).toThrow(/start or end/);
    expect(() => createSiwsMessage({ ...fields, statement: 'hello\n' })).toThrow(/start or end/);
    expect(() => createSiwsMessage({ ...fields, statement: '' })).toThrow(/non-empty/);
    expect(() => createSiwsMessage({ ...fields, resources: ['ok', 'bad\nline'] })).toThrow(/line breaks/);
  });
});

describe('parseSiwsMessage', () => {
  it('round-trips every field', () => {
    expect(parseSiwsMessage(createSiwsMessage(fields))).toEqual(fields);
    const { statement: _s, ...noStatement } = fields;
    expect(parseSiwsMessage(createSiwsMessage(noStatement))).toEqual(noStatement);
    const full: SiwsFields = { ...fields, notBefore: ISSUED, requestId: 'req-1', resources: ['https://a.example/x', 'ipfs://y'] };
    expect(parseSiwsMessage(createSiwsMessage(full))).toEqual(full);
    expect(parseSiwsMessage(createSiwsMessage({ domain: 'a.b', address: ADDRESS }))).toEqual({ domain: 'a.b', address: ADDRESS });
    expect(parseSiwsMessage(createSiwsMessage({ domain: 'a.b', address: ADDRESS, statement: 'Hi' }))).toEqual({ domain: 'a.b', address: ADDRESS, statement: 'Hi' });
    const multi: SiwsFields = { ...fields, statement: 'Line one.\nLine two.' };
    expect(parseSiwsMessage(createSiwsMessage(multi))).toEqual(multi);
    const fieldLike: SiwsFields = { ...fields, statement: 'Nonce: looks like a field' };
    expect(parseSiwsMessage(createSiwsMessage(fieldLike))).toEqual(fieldLike);
    const resourcesOnly: SiwsFields = { domain: 'a.b', address: ADDRESS, resources: [] };
    expect(parseSiwsMessage(createSiwsMessage(resourcesOnly))).toEqual(resourcesOnly);
  });

  it('rejects text that is not a SIWS message', () => {
    const good = createSiwsMessage(fields);
    const cases: Array<[string, RegExp]> = [
      ['', /header/],
      ['hello', /header/],
      [good.replace(/\n/g, '\r\n'), /line endings/],
      [good.replace('wants you to sign in with your Solana account:', 'wants you to sign in:'), /header/],
      [good.replace('localhost:5173 wants', ' wants'), /domain/],
      [good.replace('localhost:5173 wants', 'local host wants'), /domain/],
      ['localhost:5173 wants you to sign in with your Solana account:', /address/],
      [good.replace(ADDRESS, '0x0bd7d308f8e1639fab988df18a8011f41eacad73'), /base58/],
      [good.replace(`${ADDRESS}\n\n`, `${ADDRESS}\n`), /blank line/],
      [`${good}\n`, /malformed/],
      [`${good}\n\n`, /malformed/],
      [good.replace('Nonce: ', 'Nonce:'), /malformed/],
      [`${good}\nNonce: again`, /malformed/],
      [`${good}\nUnknown: x`, /malformed/],
      [good.replace('URI: http://localhost:5173/\nVersion: 1', 'Version: 1\nURI: http://localhost:5173/'), /malformed/],
      [good.replace(`\n\n${SIWS_DEFAULT_STATEMENT}\n\n`, '\n\n\n'), /malformed/],
      [`localhost:5173 wants you to sign in with your Solana account:\n${ADDRESS}\n\n`, /nothing follows|malformed/],
      [`localhost:5173 wants you to sign in with your Solana account:\n${ADDRESS}\n\n\nhello`, /malformed/],
      [good.replace('Version: 1', 'Version: '), /malformed/],
      [`${good}\nResources:\n-`, /malformed/],
      [`${good}\nResources:\nnot-a-dash`, /malformed/],
    ];
    for (const [text, re] of cases) {
      expect(() => parseSiwsMessage(text), JSON.stringify(text)).toThrow(SiwsParseError);
      expect(() => parseSiwsMessage(text), JSON.stringify(text)).toThrow(re);
    }
    // a missing field is not a parse error (the validator reports it)
    const parsed = parseSiwsMessage(good.replace('Nonce: n0nceN0nce12\n', ''));
    expect(parsed.nonce).toBeUndefined();
    expect(parsed.issuedAt).toBe(ISSUED);
    expect(() => parseSiwsMessage(42 as unknown as string)).toThrow(SiwsParseError);
    const err = (() => {
      try {
        parseSiwsMessage('x');
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(SiwsParseError);
    expect((err as Error).name).toBe('SiwsParseError');
  });
});

describe('validateSiwsFields (SPEC §5.3)', () => {
  it('accepts a fresh, matching message', () => {
    expect(validateSiwsFields(fields, expected)).toEqual([]);
    expect(validateSiwsFields(parseSiwsMessage(createSiwsMessage(fields)), expected)).toEqual([]);
    // uri comparison is by origin; trailing slash and path do not matter; address check is optional
    expect(validateSiwsFields({ ...fields, uri: 'http://localhost:5173/app?x=1' }, { ...expected, uri: 'http://localhost:5173/' })).toEqual([]);
    const { address: _a, nonceOk: _n, ...minimal } = expected;
    expect(validateSiwsFields(fields, minimal)).toEqual([]);
    expect(validateSiwsFields(fields, { ...expected, now: new Date(NOW) })).toEqual([]);
  });

  it('reports each problem', () => {
    const check = (f: SiwsFields, e: Partial<SiwsExpectations> = {}): SiwsProblemCode[] => codes(validateSiwsFields(f, { ...expected, ...e }));
    expect(check({ ...fields, domain: 'evil.example' })).toEqual(['domain_mismatch']);
    expect(check({ ...fields, address: OTHER })).toEqual(['address_mismatch']);
    expect(check({ ...fields, address: 'nope' })).toEqual(['address_invalid']);
    expect(check(fields, { uri: 'https://beagle.example' })).toEqual(['uri_mismatch']);
    expect(check({ ...fields, uri: 'http://localhost:5174/' })).toEqual(['uri_mismatch']);
    expect(check({ ...fields, uri: 'https://localhost:5173/' })).toEqual(['uri_mismatch']);
    expect(check({ ...fields, uri: 'not a url' })).toEqual(['uri_invalid']);
    expect(check({ ...fields, version: '2' })).toEqual(['version_unsupported']);
    expect(check({ ...fields, chainId: 'solana:devnet' })).toEqual(['chain_mismatch']);
    expect(check({ ...fields, nonce: 'short' })).toEqual(['nonce_invalid']);
    expect(check({ ...fields, nonce: 'has space here' })).toEqual(['nonce_invalid']);
    expect(check({ ...fields, nonce: 'someOtherNonce' })).toEqual(['nonce_unknown']);
    expect(check(fields, { nonceOk: () => false })).toEqual(['nonce_unknown']);
    expect(check({ ...fields, issuedAt: '2026-10-12 11:59:30' })).toEqual(['issued_at_invalid']);
    expect(check({ ...fields, issuedAt: '2026-13-45T11:59:30.000Z' })).toEqual(['issued_at_invalid']);
    expect(check({ ...fields, issuedAt: new Date(NOW + SIWS_DEFAULT_MAX_SKEW_MS + 1000).toISOString() })).toEqual(['issued_at_future']);
    expect(check({ ...fields, issuedAt: new Date(NOW + SIWS_DEFAULT_MAX_SKEW_MS).toISOString() })).toEqual([]);
    expect(check({ ...fields, issuedAt: new Date(NOW + 1000).toISOString() }, { maxClockSkewMs: 0 })).toEqual(['issued_at_future']);
    expect(check({ ...fields, expirationTime: 'yesterday' })).toEqual(['expiration_invalid']);
    expect(check(fields, { now: Date.parse(EXPIRES) })).toEqual(['expired']);
    expect(check(fields, { now: Date.parse(EXPIRES) - 1 })).toEqual([]);
    expect(check({ ...fields, expirationTime: '2026-10-12T11:59:00.000Z' }, { now: Date.parse('2026-10-12T11:58:00.000Z') })).toEqual(['expiration_before_issued']);
    expect(check({ ...fields, notBefore: new Date(NOW + 60_000).toISOString() })).toEqual(['not_yet_valid']);
    expect(check({ ...fields, notBefore: new Date(NOW - 60_000).toISOString() })).toEqual([]);
    expect(check({ ...fields, notBefore: 'soon' })).toEqual(['not_before_invalid']);
    // the gateway's own config must be a URL
    expect(() => validateSiwsFields(fields, { ...expected, uri: 'nope' })).toThrow(TypeError);
  });

  it('reports every missing required field', () => {
    const bare = validateSiwsFields({ domain: 'localhost:5173', address: ADDRESS }, expected);
    expect(codes(bare)).toEqual(['uri_missing', 'version_missing', 'chain_missing', 'nonce_missing', 'issued_at_missing', 'expiration_missing']);
    expect(bare.map((p) => p.field)).toEqual(['uri', 'version', 'chainId', 'nonce', 'issuedAt', 'expirationTime']);
    for (const p of bare) expect(p.message.length).toBeGreaterThan(0);
  });

  it('catches tampering with the signed text', () => {
    const text = createSiwsMessage(fields);
    const tampered = [
      text.replace('Chain ID: solana:localnet', 'Chain ID: solana:mainnet'),
      text.replace('Nonce: n0nceN0nce12', 'Nonce: n0nceN0nce13'),
      text.replace('localhost:5173 wants', 'evil.example wants'),
      text.replace(ADDRESS, OTHER),
      text.replace('URI: http://localhost:5173/', 'URI: http://evil.example/'),
      text.replace(`Expiration Time: ${EXPIRES}`, 'Expiration Time: 2099-01-01T00:00:00.000Z\nNot Before: 2099-01-01T00:00:00.000Z'),
    ];
    for (const t of tampered) {
      expect(validateSiwsFields(parseSiwsMessage(t), expected).length, t).toBeGreaterThan(0);
    }
    // field smuggling through the statement does not reach the fields
    const smuggled = parseSiwsMessage(text.replace(`\n\n${SIWS_DEFAULT_STATEMENT}\n\n`, `\n\n${SIWS_DEFAULT_STATEMENT}\nNonce: n0nceN0nce12\n\n`));
    expect(smuggled.statement).toBe(`${SIWS_DEFAULT_STATEMENT}\nNonce: n0nceN0nce12`);
    expect(smuggled.nonce).toBe('n0nceN0nce12');
  });

  it('timestamps', () => {
    expect(SIWS_VERSION).toBe('1');
    expect(SIWS_DEFAULT_TTL_MS).toBe(600_000);
    expect(siwsTimestamp(NOW)).toBe('2026-10-12T12:00:00.000Z');
    expect(siwsTimestamp(new Date(NOW))).toBe('2026-10-12T12:00:00.000Z');
    expect(() => siwsTimestamp(new Date(Number.NaN))).toThrow(RangeError);
    expect(siwsExpiration(ISSUED)).toBe(EXPIRES);
    expect(siwsExpiration(NOW, 60_000)).toBe('2026-10-12T12:01:00.000Z');
    expect(siwsExpiration(new Date(NOW), 0)).toBe('2026-10-12T12:00:00.000Z');
    expect(() => siwsExpiration('never')).toThrow(RangeError);
    expect(parseSiwsTimestamp(ISSUED)).toBe(Date.parse(ISSUED));
    expect(parseSiwsTimestamp('2026-10-12T11:59:30Z')).toBe(Date.parse('2026-10-12T11:59:30Z'));
    expect(parseSiwsTimestamp('2026-10-12T11:59:30+02:00')).toBe(Date.parse('2026-10-12T09:59:30Z'));
    expect(parseSiwsTimestamp('2026-10-12')).toBeUndefined();
    expect(parseSiwsTimestamp('2026-10-12T11:59:30')).toBeUndefined();
    expect(parseSiwsTimestamp('2026-02-30T00:00:00Z')).toBeUndefined();
    expect(parseSiwsTimestamp('2028-02-29T00:00:00Z')).toBe(Date.parse('2028-02-29T00:00:00Z'));
    expect(parseSiwsTimestamp('2026-10-12T24:00:00Z')).toBeUndefined();
    expect(parseSiwsTimestamp('2026-10-12T11:60:00Z')).toBeUndefined();
    expect(parseSiwsTimestamp('2026-10-12T11:59:30+24:00')).toBeUndefined();
    expect(parseSiwsTimestamp('2026-00-12T11:59:30Z')).toBeUndefined();
  });
});
