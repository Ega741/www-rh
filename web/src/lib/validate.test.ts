import { describe, expect, it } from 'vitest';
import { isHttpsUrl, parseAddressInput, parseHours, parseName } from './validate.js';

describe('validate', () => {
  it('addresses', () => {
    expect(parseAddressInput(' 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266 ')).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(parseAddressInput('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(parseAddressInput('0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266')).toBeUndefined(); // bad checksum
    expect(parseAddressInput('0x123')).toBeUndefined();
    expect(parseAddressInput('')).toBeUndefined();
  });
  it('https urls', () => {
    expect(isHttpsUrl('https://api.openai.com/v1')).toBe(true);
    expect(isHttpsUrl('http://api.openai.com/v1')).toBe(false);
    expect(isHttpsUrl('')).toBe(false);
    expect(isHttpsUrl('api.openai.com')).toBe(false);
  });
  it('hours', () => {
    expect(parseHours('24', 720)).toEqual({ ok: true, hours: 24 });
    expect(parseHours('0', 720).ok).toBe(false);
    expect(parseHours('721', 720)).toEqual({ ok: false, error: 'At most 720 hours' });
    expect(parseHours('1.5', 168).ok).toBe(false);
    expect(parseHours('', 168).ok).toBe(false);
  });
  it('names', () => {
    expect(parseName('  ')).toBe('default');
    expect(parseName(' ci ')).toBe('ci');
    expect(parseName('x'.repeat(65))).toBeUndefined();
  });
});
