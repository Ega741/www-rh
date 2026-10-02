import { ponsMindRegistryAbi as sharedPonsMindRegistryAbi } from '@www-rh/shared';
import { encodeFunctionData, parseAbi, type Abi } from 'viem';
import { describe, expect, it } from 'vitest';
import { SUPERSEDED_REGISTRY_MEMBERS, abiItemKey, mergeAbi, ponsMindRegistryAbi, ponsMindRegistryV2Abi } from './abi';

const TOKEN = '0x1111111111111111111111111111111111111111';
const PREPARER = '0x2222222222222222222222222222222222222222';

function named(abi: Abi, name: string) {
  return abi.filter((item) => 'name' in item && item.name === name);
}

describe('mergeAbi', () => {
  const v1 = parseAbi(['function activateAdoption(address token)', 'function harvest(address token)', 'error Same()', 'event MindAdopted(address indexed token, address indexed account)']);
  const v2 = parseAbi(['function activateAdoption(address token, address preparer)', 'error Same()', 'event MindAdopted(address indexed token, address indexed account, address indexed creator)']);

  it('drops superseded signatures, keeps the rest of the base and deduplicates by signature', () => {
    const merged = mergeAbi(v1, v2, ['activateAdoption', 'MindAdopted']);
    expect(merged.map(abiItemKey)).toEqual([
      'function harvest(address)',
      'error Same()',
      'function activateAdoption(address,address)',
      'event MindAdopted(address,address,address)',
    ]);
  });

  it('keeps a base item whose signature already is the new one (shared updated)', () => {
    const merged = mergeAbi([...v2, ...v1.slice(1, 2)], v2, ['activateAdoption', 'MindAdopted']);
    expect(merged.map(abiItemKey)).toEqual(['function activateAdoption(address,address)', 'error Same()', 'event MindAdopted(address,address,address)', 'function harvest(address)']);
  });

  it('keys tuples by their component types', () => {
    const [item] = parseAbi(['struct P { address a; uint256[] b; }', 'function f(P[] ps, P p)']);
    expect(item && abiItemKey(item)).toBe('function f((address,uint256[])[],(address,uint256[]))');
  });
});

describe('PonsMindRegistry ABI (SPEC §9.7)', () => {
  it('has exactly the §9.7 adoption signatures, whatever shared currently declares', () => {
    const keys = ponsMindRegistryAbi.map(abiItemKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const name of SUPERSEDED_REGISTRY_MEMBERS) expect(named(ponsMindRegistryAbi, name)).toHaveLength(1);
    expect(keys).toContain('function activateAdoption(address,address)');
    expect(keys).toContain('function predictAdoptionAccount(address,address)');
    expect(keys).toContain('event MindAdopted(address,address,address)');
    for (const item of ponsMindRegistryV2Abi) expect(keys).toContain(abiItemKey(item));
  });

  it('keeps every other shared member', () => {
    const keys = new Set(ponsMindRegistryAbi.map(abiItemKey));
    const kept = sharedPonsMindRegistryAbi.filter((item) => !('name' in item && (SUPERSEDED_REGISTRY_MEMBERS as readonly string[]).includes(item.name)));
    expect(kept.length).toBeGreaterThan(40);
    for (const item of kept) expect(keys.has(abiItemKey(item))).toBe(true);
  });

  it('encodes the v2 calls', () => {
    expect(encodeFunctionData({ abi: ponsMindRegistryAbi, functionName: 'activateAdoption', args: [TOKEN, PREPARER] }).length).toBe(2 + 8 + 128);
    expect(encodeFunctionData({ abi: ponsMindRegistryAbi, functionName: 'recoverAccountTokens', args: [TOKEN, PREPARER] }).slice(0, 10)).toBe(
      encodeFunctionData({ abi: parseAbi(['function recoverAccountTokens(address,address)']), functionName: 'recoverAccountTokens', args: [TOKEN, PREPARER] }).slice(0, 10),
    );
  });
});
