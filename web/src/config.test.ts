import { robinhoodChain, robinhoodChainTestnet } from '@www-rh/shared';
import { describe, expect, it } from 'vitest';
import { resolveApiBase, resolveChain, resolveLaunchpad, resolveRpcUrl, resolveWsBase, type WebEnv } from './config';

const loc = { protocol: 'https:', host: 'app.example' };

describe('runner URLs (W1)', () => {
  it('uses relative URLs through the dev proxy', () => {
    const env: WebEnv = { DEV: true, VITE_RUNNER_URL: 'http://localhost:8787' };
    expect(resolveApiBase(env)).toBe('');
    expect(resolveWsBase(env, loc)).toBe('wss://app.example/ws');
  });

  it('uses absolute URLs in production', () => {
    expect(resolveApiBase({ DEV: false, VITE_RUNNER_URL: 'https://runner.example/' })).toBe('https://runner.example');
    expect(resolveWsBase({ DEV: false, VITE_RUNNER_URL: 'https://runner.example', VITE_RUNNER_WS: 'wss://ws.example/ws' }, loc)).toBe('wss://ws.example/ws');
    expect(resolveWsBase({ DEV: false, VITE_RUNNER_URL: 'https://runner.example' }, loc)).toBe('wss://app.example/ws');
    expect(resolveApiBase({ DEV: false })).toBe('');
  });
});

describe('chain and launchpad', () => {
  it('resolves the chain from VITE_CHAIN_ID and strips multicall unless enabled (W5)', () => {
    expect(resolveChain({ DEV: false }).id).toBe(robinhoodChainTestnet.id);
    const main = resolveChain({ DEV: false, VITE_CHAIN_ID: '4663' });
    expect(main.id).toBe(robinhoodChain.id);
    expect(main.contracts?.multicall3).toBeUndefined();
    expect(resolveChain({ DEV: false, VITE_CHAIN_ID: '4663', VITE_MULTICALL: '1' }).contracts?.multicall3).toBeDefined();
    expect(resolveChain({ DEV: false, VITE_CHAIN_ID: '4663', VITE_RPC_URL: 'http://127.0.0.1:9999' }).rpcUrls.default.http).toEqual(robinhoodChain.rpcUrls.default.http);
    expect(resolveRpcUrl({ DEV: false, VITE_RPC_URL: ' http://127.0.0.1:9999 ' })).toBe('http://127.0.0.1:9999');
    expect(resolveRpcUrl({ DEV: false })).toBeUndefined();
    expect(resolveChain({ DEV: false, VITE_CHAIN_ID: '999999' }).id).toBe(robinhoodChainTestnet.id);
  });

  it('prefers a non-zero VITE_LAUNCHPAD_ADDRESS', () => {
    const addr = '0x1111111111111111111111111111111111111111';
    expect(resolveLaunchpad({ DEV: false, VITE_LAUNCHPAD_ADDRESS: addr }, 46630)).toBe(addr);
    expect(resolveLaunchpad({ DEV: false, VITE_LAUNCHPAD_ADDRESS: '0x0000000000000000000000000000000000000000' }, 999)).toBeNull();
    expect(resolveLaunchpad({ DEV: false, VITE_LAUNCHPAD_ADDRESS: 'garbage' }, 999)).toBeNull();
  });
});
