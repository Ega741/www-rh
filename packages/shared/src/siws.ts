/**
 * Sign-In-With-Solana message text (SPEC §4.1, §5.3): the wallet-standard `signIn` layout.
 *
 * ```
 * <domain> wants you to sign in with your Solana account:
 * <address>
 *
 * <statement>
 *
 * URI: <uri>
 * Version: 1
 * Chain ID: <solana:mainnet|solana:devnet|solana:localnet>
 * Nonce: <nonce>
 * Issued At: <ISO 8601>
 * Expiration Time: <ISO 8601>
 * Not Before: <ISO 8601>          (optional)
 * Request ID: <id>                (optional)
 * Resources:                      (optional)
 * - <uri>
 * ```
 *
 * {@link createSiwsMessage} builds the text, {@link parseSiwsMessage} reads it back (strict:
 * header, base58 address, known fields in this order, `\n` line endings, no trailing newline) and
 * {@link validateSiwsFields} checks the fields against what the gateway expects. No signature
 * verification here (browser-safe): the gateway verifies the UTF-8 bytes of the exact text with
 * tweetnacl.
 *
 * @module siws
 */
import { isBase58Pubkey } from './solana.js';

/** The only SIWS message version. */
export const SIWS_VERSION = '1';
/** Lifetime of a sign-in message the web offers (`expirationTime = issuedAt + 10 min`). */
export const SIWS_DEFAULT_TTL_MS = 10 * 60_000;
/** `issuedAt` may be at most this far in the future (clock skew, SPEC §5.3). */
export const SIWS_DEFAULT_MAX_SKEW_MS = 5 * 60_000;
/** Statement the web puts in its sign-in message. */
export const SIWS_DEFAULT_STATEMENT = 'Sign in to Beagle. This signature proves wallet ownership; it sends no transaction and costs no fees.';
const HEADER_SUFFIX = ' wants you to sign in with your Solana account:';

/** The fields of a SIWS message (`domain` and `address` are the only mandatory ones in the layout). */
export interface SiwsFields {
  /** RFC 3986 authority (`host[:port]`) of the site asking for the signature. */
  domain: string;
  /** Base58 public key of the signer. */
  address: string;
  statement?: string;
  uri?: string;
  version?: string;
  /** CAIP-2 id: `solana:mainnet | solana:devnet | solana:localnet`. */
  chainId?: string;
  nonce?: string;
  /** ISO 8601 (`toISOString()`). */
  issuedAt?: string;
  expirationTime?: string;
  notBefore?: string;
  requestId?: string;
  resources?: readonly string[];
}

/** Fields a Beagle sign-in requires (the validator reports each missing one). */
export type SiwsRequiredField = 'uri' | 'version' | 'chainId' | 'nonce' | 'issuedAt' | 'expirationTime';
/** A message with every field Beagle requires. */
export type BeagleSiwsFields = SiwsFields & Required<Pick<SiwsFields, SiwsRequiredField>>;

/** Thrown by {@link parseSiwsMessage} on text that is not a SIWS message. */
export class SiwsParseError extends Error {
  override readonly name = 'SiwsParseError';
  constructor(message: string) {
    super(message);
  }
}

const FIELD_KEYS = [
  ['URI', 'uri'],
  ['Version', 'version'],
  ['Chain ID', 'chainId'],
  ['Nonce', 'nonce'],
  ['Issued At', 'issuedAt'],
  ['Expiration Time', 'expirationTime'],
  ['Not Before', 'notBefore'],
  ['Request ID', 'requestId'],
] as const;
type LineField = (typeof FIELD_KEYS)[number][1];

function assertLine(name: string, value: string): string {
  if (typeof value !== 'string' || value === '') throw new TypeError(`siws: ${name} must be a non-empty string`);
  if (/[\r\n]/.test(value)) throw new TypeError(`siws: ${name} must not contain line breaks`);
  return value;
}

/** ISO 8601 timestamp of `date` (`toISOString()`, millisecond precision, `Z`). */
export function siwsTimestamp(date: Date | number): string {
  const d = typeof date === 'number' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) throw new RangeError('siws: invalid date');
  return d.toISOString();
}

/** `issuedAt + ttlMs` as an ISO 8601 timestamp. */
export function siwsExpiration(issuedAt: string | Date | number, ttlMs: number = SIWS_DEFAULT_TTL_MS): string {
  const t = typeof issuedAt === 'string' ? Date.parse(issuedAt) : typeof issuedAt === 'number' ? issuedAt : issuedAt.getTime();
  if (!Number.isFinite(t)) throw new RangeError(`siws: invalid issuedAt ${JSON.stringify(issuedAt)}`);
  return new Date(t + ttlMs).toISOString();
}

/**
 * Builds the message text. Throws `TypeError` when `domain` is blank or contains whitespace, when
 * `address` is not a 32-byte base58 key, when any single-line field contains a line break, or
 * when the statement starts / ends with a line break.
 */
export function createSiwsMessage(fields: SiwsFields): string {
  const domain = assertLine('domain', fields.domain);
  if (/\s/.test(domain)) throw new TypeError('siws: domain must not contain whitespace');
  if (!isBase58Pubkey(fields.address)) throw new TypeError(`siws: address is not a base58 public key: ${JSON.stringify(fields.address)}`);

  let message = `${domain}${HEADER_SUFFIX}\n${fields.address}`;
  if (fields.statement !== undefined) {
    if (typeof fields.statement !== 'string' || fields.statement === '') throw new TypeError('siws: statement must be a non-empty string');
    if (/\r/.test(fields.statement)) throw new TypeError('siws: statement must use \\n line endings');
    if (/^\n|\n$/.test(fields.statement)) throw new TypeError('siws: statement must not start or end with a line break');
    message += `\n\n${fields.statement}`;
  }
  const lines: string[] = [];
  for (const [label, key] of FIELD_KEYS) {
    const value = fields[key];
    if (value !== undefined) lines.push(`${label}: ${assertLine(key, value)}`);
  }
  if (fields.resources !== undefined) {
    lines.push('Resources:');
    for (const resource of fields.resources) lines.push(`- ${assertLine('resource', resource)}`);
  }
  if (lines.length > 0) message += `\n\n${lines.join('\n')}`;
  return message;
}

/** Parses an ordered block of `Key: value` lines (+ `Resources:` list); `undefined` when it is not one. */
function parseFieldBlock(lines: readonly string[]): Partial<Record<LineField, string>> & { resources?: string[] } | undefined {
  const out: Partial<Record<LineField, string>> & { resources?: string[] } = {};
  let next = 0;
  for (let j = 0; j < lines.length; j++) {
    const line = lines[j] as string;
    if (line === 'Resources:') {
      const resources: string[] = [];
      for (const item of lines.slice(j + 1)) {
        if (!item.startsWith('- ') || item.length < 3) return undefined;
        resources.push(item.slice(2));
      }
      out.resources = resources;
      return out;
    }
    const sep = line.indexOf(': ');
    if (sep <= 0) return undefined;
    const label = line.slice(0, sep);
    const value = line.slice(sep + 2);
    if (value === '') return undefined;
    const position = FIELD_KEYS.findIndex(([l]) => l === label);
    if (position < next) return undefined; // unknown label, duplicate, or out of order
    out[(FIELD_KEYS[position] as (typeof FIELD_KEYS)[number])[1]] = value;
    next = position + 1;
  }
  return out;
}

/**
 * Parses message text produced by {@link createSiwsMessage} (or a wallet's `signIn`). Throws
 * {@link SiwsParseError} on CRLF line endings, a missing header, a non-base58 address, a missing
 * blank line, unknown / duplicated / misordered fields, or a trailing newline.
 */
export function parseSiwsMessage(text: string): SiwsFields {
  if (typeof text !== 'string') throw new SiwsParseError('message must be a string');
  if (text.includes('\r')) throw new SiwsParseError('message must use \\n line endings');
  const lines = text.split('\n');
  const header = lines[0] ?? '';
  if (!header.endsWith(HEADER_SUFFIX)) throw new SiwsParseError('missing "<domain> wants you to sign in with your Solana account:" header');
  const domain = header.slice(0, -HEADER_SUFFIX.length);
  if (domain === '' || /\s/.test(domain)) throw new SiwsParseError('invalid domain in header');
  if (lines.length < 2) throw new SiwsParseError('missing address line');
  const address = lines[1] as string;
  if (!isBase58Pubkey(address)) throw new SiwsParseError('address is not a base58 public key');

  const fields: SiwsFields = { domain, address };
  if (lines.length === 2) return fields;
  if (lines[2] !== '') throw new SiwsParseError('expected a blank line after the address');
  const rest = lines.slice(3);
  if (rest.length === 0) throw new SiwsParseError('nothing follows the blank line after the address');

  for (let f = 0; f <= rest.length; f++) {
    if (f === rest.length) {
      // No field block: everything after the blank line is the statement.
      const statement = rest.join('\n');
      if (statement === '' || rest.includes('')) throw new SiwsParseError('malformed statement or field block');
      return { ...fields, statement };
    }
    const block = parseFieldBlock(rest.slice(f));
    if (block === undefined) continue;
    if (f > 0) {
      if (rest[f - 1] !== '') continue;
      const statementLines = rest.slice(0, f - 1);
      if (statementLines.length === 0 || statementLines[0] === '' || statementLines[statementLines.length - 1] === '') {
        throw new SiwsParseError('malformed statement block');
      }
      fields.statement = statementLines.join('\n');
    }
    const { resources, ...single } = block;
    return { ...fields, ...single, ...(resources !== undefined ? { resources } : {}) };
  }
  throw new SiwsParseError('malformed field block');
}

/** Machine-readable reasons {@link validateSiwsFields} can report. */
export type SiwsProblemCode =
  | 'domain_mismatch'
  | 'address_invalid'
  | 'address_mismatch'
  | 'uri_missing'
  | 'uri_invalid'
  | 'uri_mismatch'
  | 'version_missing'
  | 'version_unsupported'
  | 'chain_missing'
  | 'chain_mismatch'
  | 'nonce_missing'
  | 'nonce_invalid'
  | 'nonce_unknown'
  | 'issued_at_missing'
  | 'issued_at_invalid'
  | 'issued_at_future'
  | 'expiration_missing'
  | 'expiration_invalid'
  | 'expired'
  | 'expiration_before_issued'
  | 'not_before_invalid'
  | 'not_yet_valid';

/** One validation problem. */
export interface SiwsProblem {
  field: keyof SiwsFields;
  code: SiwsProblemCode;
  message: string;
}

/** What the gateway expects a sign-in message to say (SPEC §5.3). */
export interface SiwsExpectations {
  /** `host(PUBLIC_URL)`. */
  domain: string;
  /** `PUBLIC_URL`: the message `uri` must have the same origin. */
  uri: string;
  /** `clusterCaip(CLUSTER)`. */
  chainId: string;
  /** The wallet that signed (`publicKey` of the verify request); checked against `address` when given. */
  address?: string;
  /** Unix milliseconds or a `Date` (default `Date.now()`). */
  now?: number | Date;
  /** `false` when the nonce was never issued or was already used. */
  nonceOk?: (nonce: string) => boolean;
  /** Allowed future skew of `issuedAt` (default 5 min). */
  maxClockSkewMs?: number;
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
const NONCE_RE = /^[A-Za-z0-9_-]{8,}$/;

/**
 * Parses an RFC 3339 timestamp (`2026-10-12T12:00:00.000Z`, offsets allowed) to unix milliseconds;
 * `undefined` when the text is not one or names an impossible date (`2026-02-30`).
 */
export function parseSiwsTimestamp(value: string): number | undefined {
  const m = ISO_RE.exec(value);
  if (!m) return undefined;
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) return undefined;
  if (m[8] !== undefined && (Number(m[8]) > 23 || Number(m[9]) > 59)) return undefined;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Checks parsed fields against `expected`. Returns the list of problems (empty = ok): domain and
 * uri origin equality, version `1`, chain id, nonce format (≥ 8 `[A-Za-z0-9_-]`) and `nonceOk`,
 * `issuedAt ≤ now + skew`, `expirationTime > now`, `notBefore ≤ now`, and `address` equality
 * when `expected.address` is given. Throws `TypeError` when `expected.uri` is not a URL.
 */
export function validateSiwsFields(fields: SiwsFields, expected: SiwsExpectations): SiwsProblem[] {
  const problems: SiwsProblem[] = [];
  const add = (field: keyof SiwsFields, code: SiwsProblemCode, message: string): void => {
    problems.push({ field, code, message });
  };
  const now = expected.now === undefined ? Date.now() : typeof expected.now === 'number' ? expected.now : expected.now.getTime();
  const skew = expected.maxClockSkewMs ?? SIWS_DEFAULT_MAX_SKEW_MS;
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(expected.uri).origin;
  } catch {
    throw new TypeError(`validateSiwsFields: expected.uri is not a URL: ${JSON.stringify(expected.uri)}`);
  }

  if (fields.domain !== expected.domain) add('domain', 'domain_mismatch', `domain ${JSON.stringify(fields.domain)} ≠ ${JSON.stringify(expected.domain)}`);
  if (!isBase58Pubkey(fields.address)) add('address', 'address_invalid', 'address is not a base58 public key');
  else if (expected.address !== undefined && fields.address !== expected.address) add('address', 'address_mismatch', 'address does not match the signing key');

  if (fields.uri === undefined) add('uri', 'uri_missing', 'URI is missing');
  else {
    let origin: string | undefined;
    try {
      origin = new URL(fields.uri).origin;
    } catch {
      add('uri', 'uri_invalid', 'URI is not a URL');
    }
    if (origin !== undefined && origin !== expectedOrigin) add('uri', 'uri_mismatch', `URI origin ${origin} ≠ ${expectedOrigin}`);
  }

  if (fields.version === undefined) add('version', 'version_missing', 'Version is missing');
  else if (fields.version !== SIWS_VERSION) add('version', 'version_unsupported', `Version ${JSON.stringify(fields.version)} is not ${SIWS_VERSION}`);

  if (fields.chainId === undefined) add('chainId', 'chain_missing', 'Chain ID is missing');
  else if (fields.chainId !== expected.chainId) add('chainId', 'chain_mismatch', `Chain ID ${fields.chainId} ≠ ${expected.chainId}`);

  if (fields.nonce === undefined) add('nonce', 'nonce_missing', 'Nonce is missing');
  else if (!NONCE_RE.test(fields.nonce)) add('nonce', 'nonce_invalid', 'Nonce must be at least 8 characters of [A-Za-z0-9_-]');
  else if (expected.nonceOk !== undefined && !expected.nonceOk(fields.nonce)) add('nonce', 'nonce_unknown', 'Nonce is unknown, expired or already used');

  let issuedAt: number | undefined;
  if (fields.issuedAt === undefined) add('issuedAt', 'issued_at_missing', 'Issued At is missing');
  else {
    issuedAt = parseSiwsTimestamp(fields.issuedAt);
    if (issuedAt === undefined) add('issuedAt', 'issued_at_invalid', 'Issued At is not an ISO 8601 timestamp');
    else if (issuedAt > now + skew) add('issuedAt', 'issued_at_future', 'Issued At is in the future');
  }

  if (fields.expirationTime === undefined) add('expirationTime', 'expiration_missing', 'Expiration Time is missing');
  else {
    const exp = parseSiwsTimestamp(fields.expirationTime);
    if (exp === undefined) add('expirationTime', 'expiration_invalid', 'Expiration Time is not an ISO 8601 timestamp');
    else {
      if (exp <= now) add('expirationTime', 'expired', 'message has expired');
      if (issuedAt !== undefined && exp < issuedAt) add('expirationTime', 'expiration_before_issued', 'Expiration Time precedes Issued At');
    }
  }

  if (fields.notBefore !== undefined) {
    const nbf = parseSiwsTimestamp(fields.notBefore);
    if (nbf === undefined) add('notBefore', 'not_before_invalid', 'Not Before is not an ISO 8601 timestamp');
    else if (nbf > now) add('notBefore', 'not_yet_valid', 'message is not valid yet');
  }

  return problems;
}
