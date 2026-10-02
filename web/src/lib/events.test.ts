import { encodeAbiParameters, encodeEventTopics, type Hex, type Log } from 'viem';
import { describe, expect, it } from 'vitest';
import { mindLaunchpadAbi as launchpadAbi } from '@www-rh/shared';
import { mindCreatedToken } from './events';

const LAUNCHPAD = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';
const CREATOR = '0x3333333333333333333333333333333333333333';

function mindCreatedLog(address: Hex): Log {
  const topics = encodeEventTopics({ abi: launchpadAbi, eventName: 'MindCreated', args: { token: TOKEN, creator: CREATOR } });
  const data = encodeAbiParameters(
    [{ type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'bytes32' }, { type: 'bytes32' }],
    ['Night Sky', 'STARS', 'runner://metadata/abc', `0x${'01'.repeat(32)}`, `0x${'02'.repeat(32)}`],
  );
  return {
    address,
    topics: topics as [Hex, ...Hex[]],
    data,
    blockHash: `0x${'aa'.repeat(32)}`,
    blockNumber: 1n,
    logIndex: 0,
    transactionHash: `0x${'bb'.repeat(32)}`,
    transactionIndex: 0,
    removed: false,
  };
}

describe('mindCreatedToken (W2)', () => {
  it('decodes the token from the launchpad MindCreated event', () => {
    expect(mindCreatedToken([mindCreatedLog(LAUNCHPAD)], LAUNCHPAD)).toBe(TOKEN);
  });

  it('ignores events emitted by other contracts', () => {
    expect(mindCreatedToken([mindCreatedLog('0x4444444444444444444444444444444444444444')], LAUNCHPAD)).toBeNull();
    expect(mindCreatedToken([], LAUNCHPAD)).toBeNull();
  });
});
