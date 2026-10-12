import { describe, expect, it } from 'vitest';
import { isHttpsUrl, parseAddressInput, parseHours, parseName } from './validate.js';

const KEY = 'BEJQY85xuHoT2NyAT5eXF9ftMv6RnSM7LQSujxm8BAbZ';

describe('validate', () => {
  it('parseAddressInput accepts 32-byte base58 keys only', () => {
    expect(parseAddressInput(` ${KEY} `)).toBe(KEY);
    expect(parseAddressInput('11111111111111111111111111111111')).toBe('11111111111111111111111111111111');
    expect(parseAddressInput(KEY.slice(0, 20))).toBeUndefined();
    expect(parseAddressInput(`${KEY}A`)).toBeUndefined();
    expect(parseAddressInput('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')).toBeUndefined();
    expect(parseAddressInput('BEJQY85xuHoT2NyAT5eXF9ftMv6RnSM7LQSujxm8BAbO')).toBeUndefined();
    expect(parseAddressInput('')).toBeUndefined();
  });
  it('isHttpsUrl', () => {
    expect(isHttpsUrl('https://api.example.com/v1')).toBe(true);
    expect(isHttpsUrl('http://api.example.com')).toBe(false);
    expect(isHttpsUrl('nope')).toBe(false);
    expect(isHttpsUrl('')).toBe(false);
  });
  it('parseHours', () => {
    expect(parseHours('24', 168)).toEqual({ ok: true, hours: 24 });
    expect(parseHours('', 168)).toMatchObject({ ok: false });
    expect(parseHours('1.5', 168)).toMatchObject({ ok: false, error: 'Hours must be a whole number' });
    expect(parseHours('0', 168)).toMatchObject({ ok: false, error: 'At least 1 hour' });
    expect(parseHours('169', 168)).toMatchObject({ ok: false, error: 'At most 168 hours' });
  });
  it('parseName', () => {
    expect(parseName('  ')).toBe('default');
    expect(parseName(' ci ')).toBe('ci');
    expect(parseName('x'.repeat(65))).toBeUndefined();
  });
});
