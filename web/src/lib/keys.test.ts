import { describe, expect, it } from 'vitest';
import { displayKey, isApiKey, keyPrefix, maskKey, redactKeys } from './keys.js';

const KEY = 'bgl_' + 'A'.repeat(43);

describe('api key display', () => {
  it('recognises keys', () => {
    expect(isApiKey(KEY)).toBe(true);
    expect(isApiKey('bgl_short')).toBe(false);
    expect(isApiKey('sk-' + 'A'.repeat(43))).toBe(false);
  });
  it('prefix and mask', () => {
    expect(keyPrefix(KEY)).toBe('bgl_AAAAAAAA');
    expect(maskKey('bgl_AAAAAAAA')).toBe('bgl_AAAAAAAA••••••••');
    expect(displayKey(KEY, false)).toBe('bgl_AAAAAAAA••••••••');
    expect(displayKey(KEY, true)).toBe(KEY);
  });
  it('redacts keys in free text', () => {
    expect(redactKeys(`token ${KEY} leaked`)).toBe('token bgl_AAAAAAAA•••••••• leaked');
  });
});
