import { encodeAbiParameters, encodeEventTopics, type Hex, type Log } from 'viem';
import { describe, expect, it } from 'vitest';
import { ponsMindRegistryAbi } from './abi';
import { launchedTokenFromLogs, mindLaunchedFromLogs } from './events';

const REGISTRY = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';
const CURVE = '0x3333333333333333333333333333333333333333';
const ACCOUNT = '0x4444444444444444444444444444444444444444';
const CREATOR = '0x5555555555555555555555555555555555555555';

function log(address: Hex, topics: Hex[], data: Hex, logIndex = 0): Log {
  return {
    address,
    topics: topics as [Hex, ...Hex[]],
    data,
    blockHash: `0x${'aa'.repeat(32)}`,
    blockNumber: 1n,
    logIndex,
    transactionHash: `0x${'bb'.repeat(32)}`,
    transactionIndex: 0,
    removed: false,
  };
}

function mindLaunchedLog(address: Hex): Log {
  const topics = encodeEventTopics({ abi: ponsMindRegistryAbi, eventName: 'MindLaunched', args: { token: TOKEN, curve: CURVE, account: ACCOUNT } }) as Hex[];
  return log(address, topics, encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [CREATOR, 3n]), 1);
}

function mindCreatedLog(address: Hex): Log {
  const topics = encodeEventTopics({ abi: ponsMindRegistryAbi, eventName: 'MindCreated', args: { token: TOKEN, creator: CREATOR } }) as Hex[];
  const data = encodeAbiParameters(
    [{ type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'bytes32' }, { type: 'bytes32' }],
    ['Night Sky', 'STARS', 'runner://metadata/abc', `0x${'01'.repeat(32)}`, `0x${'02'.repeat(32)}`],
  );
  return log(address, topics, data, 0);
}

describe('MindLaunched decoding (SPEC §9.5)', () => {
  it('decodes token, curve, account, creator and config from the registry event', () => {
    expect(mindLaunchedFromLogs([mindCreatedLog(REGISTRY), mindLaunchedLog(REGISTRY)], REGISTRY)).toEqual({
      token: TOKEN,
      curve: CURVE,
      account: ACCOUNT,
      creator: CREATOR,
      launchConfigId: 3n,
    });
    expect(launchedTokenFromLogs([mindLaunchedLog(REGISTRY)], REGISTRY)).toBe(TOKEN);
  });

  it('ignores other emitters and falls back to MindCreated', () => {
    const other = '0x9999999999999999999999999999999999999999';
    expect(mindLaunchedFromLogs([mindLaunchedLog(other)], REGISTRY)).toBeNull();
    expect(launchedTokenFromLogs([mindCreatedLog(REGISTRY)], REGISTRY)).toBe(TOKEN);
    expect(launchedTokenFromLogs([mindLaunchedLog(other), mindCreatedLog(other)], REGISTRY)).toBeNull();
  });
});
