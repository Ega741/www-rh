import { zeroAddress, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { checkLeaveRecipient, parseRecipient, type LeaveRecipientContext } from './leave';

const ACCOUNT = '0x4444444444444444444444444444444444444444' as Address;
const REGISTRY = '0x00000000000000000000000000000000000000aa' as Address;
const WALLET = '0x5555555555555555555555555555555555555555' as Address;
const OTHER_TOKEN = '0x6666666666666666666666666666666666666666' as Address;

const ctx: LeaveRecipientContext = { account: ACCOUNT, registry: REGISTRY, recipientTokenOf: zeroAddress };

describe('leave recipient validation (SPEC §9.7 InvalidRecipient)', () => {
  it('accepts a plain wallet that is not a mind account', () => {
    expect(checkLeaveRecipient(` ${WALLET} `, ctx)).toEqual({ status: 'ok', recipient: WALLET, warning: null });
    expect(checkLeaveRecipient(WALLET.toUpperCase().replace('0X', '0x'), ctx)).toMatchObject({ status: 'ok', recipient: WALLET });
  });

  it('rejects empty input, non-addresses and the zero address', () => {
    expect(checkLeaveRecipient('', ctx)).toMatchObject({ status: 'invalid', message: expect.stringMatching(/Enter the address/) });
    expect(checkLeaveRecipient('0x1234', ctx)).toEqual({ status: 'invalid', message: 'Not an address.' });
    expect(checkLeaveRecipient(zeroAddress, ctx)).toMatchObject({ status: 'invalid', message: expect.stringMatching(/zero address/) });
  });

  it('rejects the mind account itself and the registry (before the tokenOf read)', () => {
    expect(checkLeaveRecipient('0x4444444444444444444444444444444444444444', { ...ctx, recipientTokenOf: undefined })).toMatchObject({
      status: 'invalid',
      message: expect.stringMatching(/mind account itself/),
    });
    expect(checkLeaveRecipient('0x00000000000000000000000000000000000000AA', { ...ctx, recipientTokenOf: undefined })).toMatchObject({
      status: 'invalid',
      message: expect.stringMatching(/registry/),
    });
  });

  it('rejects any other mind account via registry.tokenOf', () => {
    expect(checkLeaveRecipient(WALLET, { ...ctx, recipientTokenOf: OTHER_TOKEN })).toMatchObject({ status: 'invalid', message: expect.stringMatching(/another mind/) });
  });

  it('waits for tokenOf, and lets the registry decide when the read failed', () => {
    expect(checkLeaveRecipient(WALLET, { ...ctx, recipientTokenOf: undefined })).toEqual({ status: 'checking', recipient: WALLET });
    expect(checkLeaveRecipient(WALLET, { ...ctx, recipientTokenOf: null })).toMatchObject({ status: 'ok', recipient: WALLET, warning: expect.stringMatching(/Could not check/) });
  });

  it('works without a known account or registry', () => {
    expect(checkLeaveRecipient(WALLET, { account: null, registry: null, recipientTokenOf: zeroAddress })).toMatchObject({ status: 'ok' });
  });

  it('parses recipients', () => {
    expect(parseRecipient(' 0x5555555555555555555555555555555555555555 ')).toBe(WALLET);
    expect(parseRecipient('nope')).toBeNull();
  });
});
