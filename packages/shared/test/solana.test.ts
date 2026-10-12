import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { MEMO_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../src/addresses.js';
import { DEFAULT_DECIMALS as CREDIT_DEFAULT_DECIMALS } from '../src/credit.js';
import {
  BASE58_ALPHABET,
  BURN_INSTRUCTION_TYPES,
  Base58PubkeySchema,
  ClusterSchema,
  DEFAULT_DECIMALS,
  PUBKEY_BYTES,
  SIGNATURE_BYTES,
  SignatureSchema,
  TOKEN_ACCOUNT_AMOUNT_OFFSET,
  TOKEN_ACCOUNT_DELEGATED_AMOUNT_OFFSET,
  TOKEN_ACCOUNT_DELEGATE_OFFSET,
  TOKEN_ACCOUNT_DELEGATE_OPTION_OFFSET,
  TOKEN_ACCOUNT_MINT_OFFSET,
  TOKEN_ACCOUNT_OWNER_OFFSET,
  TOKEN_ACCOUNT_SIZE,
  assertPubkey,
  creditEventId,
  decodeBase58,
  encodeBase58,
  isBase58Pubkey,
  isBase58Signature,
  isBurnInstructionType,
  parseCreditEventId,
  shortAddress,
} from '../src/solana.js';

const KEY = bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => i + 1)); // 4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw
const KEY_MAX = bs58.encode(new Uint8Array(32).fill(255)); // 44 chars
const SIG = bs58.encode(new Uint8Array(64).fill(7)); // 87 chars
const SIG_MAX = bs58.encode(new Uint8Array(64).fill(255)); // 88 chars

describe('base58 keys and signatures', () => {
  it('decode / encode round trip', () => {
    expect(encodeBase58(Uint8Array.from({ length: 32 }, (_, i) => i + 1))).toBe('4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw');
    expect(Array.from(decodeBase58(KEY) ?? [])).toEqual(Array.from({ length: 32 }, (_, i) => i + 1));
    expect(decodeBase58('')).toBeUndefined();
    expect(decodeBase58('0OIl')).toBeUndefined();
    expect(decodeBase58(' ' + KEY)).toBeUndefined();
    expect(BASE58_ALPHABET).toHaveLength(58);
    expect(BASE58_ALPHABET).not.toMatch(/[0OIl]/);
  });

  it('isBase58Pubkey requires exactly 32 decoded bytes', () => {
    expect(PUBKEY_BYTES).toBe(32);
    for (const k of [KEY, KEY_MAX, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, MEMO_PROGRAM_ID, SYSTEM_PROGRAM_ID]) {
      expect(isBase58Pubkey(k), k).toBe(true);
    }
    expect(KEY_MAX).toHaveLength(44);
    expect(SYSTEM_PROGRAM_ID).toHaveLength(32);
    expect(isBase58Pubkey(bs58.encode(new Uint8Array(31).fill(9)))).toBe(false);
    expect(isBase58Pubkey(bs58.encode(new Uint8Array(33).fill(9)))).toBe(false);
    expect(isBase58Pubkey(KEY.slice(0, -1))).toBe(false);
    expect(isBase58Pubkey(`${KEY_MAX}1`)).toBe(false); // 45 chars
    expect(isBase58Pubkey(`1${KEY_MAX}`)).toBe(false); // a leading '1' is a leading zero byte → 33 bytes
    expect(isBase58Pubkey(KEY.replace('4', '0'))).toBe(false); // '0' is not base58
    // case-sensitive: the lowercase text is a different key (or no key at all)
    expect(Array.from(decodeBase58(KEY.toLowerCase()) ?? [])).not.toEqual(Array.from(decodeBase58(KEY) ?? []));
    expect(isBase58Pubkey('0x0bd7d308f8e1639fab988df18a8011f41eacad73')).toBe(false);
    expect(isBase58Pubkey('')).toBe(false);
    expect(isBase58Pubkey(42)).toBe(false);
    expect(isBase58Pubkey(null)).toBe(false);
  });

  it('Base58PubkeySchema', () => {
    expect(Base58PubkeySchema.parse(KEY)).toBe(KEY);
    expect(Base58PubkeySchema.safeParse(`${KEY} `).success).toBe(false);
    expect(Base58PubkeySchema.safeParse('abc').success).toBe(false);
    expect(Base58PubkeySchema.safeParse(bs58.encode(new Uint8Array(33).fill(9))).success).toBe(false);
    const r = Base58PubkeySchema.safeParse('4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLK0'); // '0' not in alphabet
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/base58 Solana public key/);
  });

  it('isBase58Signature requires exactly 64 decoded bytes', () => {
    expect(SIGNATURE_BYTES).toBe(64);
    expect(SIG).toHaveLength(87);
    expect(SIG_MAX).toHaveLength(88);
    expect(isBase58Signature(SIG)).toBe(true);
    expect(isBase58Signature(SIG_MAX)).toBe(true);
    expect(isBase58Signature(bs58.encode(new Uint8Array(63).fill(7)))).toBe(false);
    // a signature whose first bytes are zero is shorter than 87 characters yet still 64 bytes
    const leadingZeros = Uint8Array.from({ length: 64 }, (_, i) => (i < 2 ? 0 : (i * 3) % 251));
    expect(bs58.encode(leadingZeros)).toHaveLength(86);
    expect(isBase58Signature(bs58.encode(leadingZeros))).toBe(true);
    expect(isBase58Signature(bs58.encode(new Uint8Array(65).fill(7)))).toBe(false);
    expect(isBase58Signature(KEY)).toBe(false);
    expect(isBase58Signature(Buffer.from(new Uint8Array(64).fill(7)).toString('base64'))).toBe(false);
    expect(SignatureSchema.parse(SIG)).toBe(SIG);
    expect(SignatureSchema.safeParse(`${SIG}1`).success).toBe(false);
    expect(SignatureSchema.safeParse(KEY).success).toBe(false);
  });

  it('assertPubkey trims and throws', () => {
    expect(assertPubkey(`  ${KEY}\n`)).toBe(KEY);
    expect(() => assertPubkey('nope', 'MINT_ADDRESS')).toThrow(/MINT_ADDRESS is not a base58 Solana public key/);
    expect(() => assertPubkey(undefined)).toThrow(TypeError);
  });

  it('ClusterSchema', () => {
    expect(ClusterSchema.parse('devnet')).toBe('devnet');
    expect(ClusterSchema.safeParse('testnet').success).toBe(false);
  });
});

describe('layouts and constants (SPEC §3.4, §4.1)', () => {
  it('classic token account offsets', () => {
    expect(TOKEN_ACCOUNT_SIZE).toBe(165);
    expect(TOKEN_ACCOUNT_MINT_OFFSET).toBe(0);
    expect(TOKEN_ACCOUNT_OWNER_OFFSET).toBe(32);
    expect(TOKEN_ACCOUNT_AMOUNT_OFFSET).toBe(64);
    expect(TOKEN_ACCOUNT_DELEGATE_OPTION_OFFSET).toBe(72);
    expect(TOKEN_ACCOUNT_DELEGATE_OFFSET).toBe(76);
    expect(TOKEN_ACCOUNT_DELEGATED_AMOUNT_OFFSET).toBe(121);
  });
  it('burn instruction names and decimals', () => {
    expect(BURN_INSTRUCTION_TYPES).toEqual(['burn', 'burnChecked']);
    expect(isBurnInstructionType('burnChecked')).toBe(true);
    expect(isBurnInstructionType('transfer')).toBe(false);
    expect(DEFAULT_DECIMALS).toBe(6);
    expect(DEFAULT_DECIMALS).toBe(CREDIT_DEFAULT_DECIMALS);
  });
});

describe('display helpers', () => {
  it('shortAddress', () => {
    expect(shortAddress('4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw')).toBe('4wBq…Vigw');
    expect(shortAddress('4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw', 6)).toBe('4wBqpZ…y4Vigw');
    expect(shortAddress('abcdefghij')).toBe('abcd…ghij');
    expect(shortAddress('abcdefghi')).toBe('abcdefghi'); // nothing to elide
    expect(shortAddress('abcdefgh')).toBe('abcdefgh');
    expect(shortAddress('')).toBe('');
    expect(() => shortAddress(KEY, 0)).toThrow(RangeError);
  });
  it('credit event ids', () => {
    expect(creditEventId(SIG, 0)).toBe(`${SIG}:0`);
    expect(creditEventId(SIG, 12)).toBe(`${SIG}:12`);
    expect(() => creditEventId(SIG, -1)).toThrow(RangeError);
    expect(() => creditEventId(SIG, 1.5)).toThrow(RangeError);
    expect(parseCreditEventId(`${SIG}:3`)).toEqual({ signature: SIG, ixIndex: 3 });
    expect(parseCreditEventId(`${SIG_MAX}:0`)).toEqual({ signature: SIG_MAX, ixIndex: 0 });
    expect(parseCreditEventId(`${SIG}:03`)).toBeUndefined();
    expect(parseCreditEventId(`${SIG}`)).toBeUndefined();
    expect(parseCreditEventId(`${KEY}:1`)).toBeUndefined();
    expect(parseCreditEventId(`${SIG}:x`)).toBeUndefined();
  });
});
