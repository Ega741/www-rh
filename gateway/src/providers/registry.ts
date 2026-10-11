/**
 * Provider registry (SPEC §5.5): one adapter per provider, platform keys from the config, BYOK
 * keys decrypted from `provider_keys` in the request path only, and the SSRF guard for BYOK base
 * URLs (https only, no private / loopback / link-local targets — checked at save and at use).
 *
 * @module providers/registry
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { BYOK_PROVIDERS, type Provider } from '@beagle/shared/models';
import type { Keyring } from '../auth/crypto.js';
import type { Config } from '../config.js';
import type { ProviderKeyRepo } from '../db/repos.js';
import type { Logger } from '../log.js';
import { ANTHROPIC_BASE_URL, createAnthropicAdapter, type AnthropicClientFactory } from './anthropic.js';
import { createOpenAiCompatAdapter, type FetchLike } from './openaiCompat.js';
import type { Credentials, ProviderAdapter } from './types.js';

/** Resolves a hostname to addresses (injectable for tests). */
export type DnsLookup = (hostname: string) => Promise<string[]>;

/** Thrown by {@link assertSafeBaseUrl}. */
export class UnsafeBaseUrlError extends Error {
  override readonly name = 'UnsafeBaseUrlError';
}

/** `true` for loopback, private, link-local, CGNAT, multicast, unspecified and IPv4-mapped equivalents. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const parts = ip.split('.').map(Number);
    const [a = 0, b = 0] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
    if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique local
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link local
    if (lower.startsWith('ff')) return true; // multicast
    return false;
  }
  return true;
}

const defaultLookup: DnsLookup = async (hostname) => (await dnsLookup(hostname, { all: true })).map((a) => a.address);

/**
 * Validates a BYOK base URL: `https:`, a hostname that is not an IP literal in a private range and
 * does not resolve to one. Throws {@link UnsafeBaseUrlError}.
 */
export async function assertSafeBaseUrl(baseUrl: string, lookup: DnsLookup = defaultLookup): Promise<URL> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new UnsafeBaseUrlError('baseUrl is not a valid URL');
  }
  if (url.protocol !== 'https:') throw new UnsafeBaseUrlError('baseUrl must use https:');
  if (url.username !== '' || url.password !== '') throw new UnsafeBaseUrlError('baseUrl must not carry credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === '' || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new UnsafeBaseUrlError('baseUrl must not point at a local host');
  }
  if (isIP(host) !== 0) {
    if (isPrivateAddress(host)) throw new UnsafeBaseUrlError('baseUrl must not point at a private address');
    return url;
  }
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    throw new UnsafeBaseUrlError(`baseUrl host ${host} does not resolve`);
  }
  if (addresses.length === 0) throw new UnsafeBaseUrlError(`baseUrl host ${host} does not resolve`);
  if (addresses.some(isPrivateAddress)) throw new UnsafeBaseUrlError('baseUrl resolves to a private address');
  return url;
}

/** Dependencies of {@link ProviderRegistry}. */
export interface ProviderRegistryDeps {
  config: Config;
  providerKeys: ProviderKeyRepo;
  keyring: Keyring | undefined;
  logger: Logger;
  fetch?: FetchLike;
  anthropicClientFactory?: AnthropicClientFactory;
  lookup?: DnsLookup;
  /** Replaces adapters (tests). */
  adapters?: Partial<Record<Provider, ProviderAdapter>>;
}

/** Default BYOK base URLs per provider. */
export const DEFAULT_BASE_URLS: Readonly<Record<Provider, string>> = Object.freeze({
  anthropic: ANTHROPIC_BASE_URL,
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  house: '',
});

/** Adapters and credential resolution. */
export class ProviderRegistry {
  private readonly adapters: Record<Provider, ProviderAdapter>;
  private readonly lookup: DnsLookup;

  constructor(private readonly deps: ProviderRegistryDeps) {
    const fetchImpl = deps.fetch;
    const mk = (provider: Provider): ProviderAdapter =>
      deps.adapters?.[provider] ??
      (provider === 'anthropic'
        ? createAnthropicAdapter({ timeoutMs: deps.config.providers.timeoutMs, ...(deps.anthropicClientFactory === undefined ? {} : { clientFactory: deps.anthropicClientFactory }) })
        : createOpenAiCompatAdapter({ provider, ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }) }));
    this.adapters = { anthropic: mk('anthropic'), openai: mk('openai'), google: mk('google'), house: mk('house') };
    this.lookup = deps.lookup ?? defaultLookup;
  }

  /** The adapter of `provider`. */
  adapter(provider: Provider): ProviderAdapter {
    return this.adapters[provider];
  }

  /** Platform credentials from the config, or `undefined` when the provider is not configured. */
  platformCredentials(provider: Provider): Credentials | undefined {
    const p = this.deps.config.providers;
    switch (provider) {
      case 'anthropic':
        return p.anthropicApiKey === undefined ? undefined : { kind: 'platform', key: p.anthropicApiKey, baseUrl: ANTHROPIC_BASE_URL };
      case 'openai':
        return p.openaiApiKey === undefined ? undefined : { kind: 'platform', key: p.openaiApiKey, baseUrl: p.openaiBaseUrl };
      case 'google':
        return p.googleApiKey === undefined ? undefined : { kind: 'platform', key: p.googleApiKey, baseUrl: p.googleBaseUrl };
      case 'house':
        return p.houseBaseUrl === undefined ? undefined : { kind: 'platform', key: p.houseApiKey ?? '', baseUrl: p.houseBaseUrl };
    }
  }

  /** `true` when a platform key (or house URL) is configured. */
  platformConfigured(provider: Provider): boolean {
    return this.platformCredentials(provider) !== undefined;
  }

  /** Providers the workspace brought a key for. */
  byokProviders(workspace: string): Provider[] {
    return this.deps.providerKeys.providers(workspace).filter((p): p is Provider => (BYOK_PROVIDERS as readonly string[]).includes(p));
  }

  /** BYOK credentials when stored (decrypted now; SSRF re-checked for custom base URLs), else undefined. */
  async byokCredentials(provider: Provider, workspace: string): Promise<Credentials | undefined> {
    if (!(BYOK_PROVIDERS as readonly string[]).includes(provider)) return undefined;
    const row = this.deps.providerKeys.get(workspace, provider);
    if (row === undefined) return undefined;
    if (this.deps.keyring === undefined) {
      this.deps.logger.warn('BYOK key present but KEYRING_MASTER_KEY is unset; ignoring', { workspace, provider });
      return undefined;
    }
    let key: string;
    try {
      key = this.deps.keyring.decrypt({ ciphertext: row.ciphertext, iv: row.iv, tag: row.tag }, workspace, provider);
    } catch (e) {
      this.deps.logger.error('BYOK key decryption failed', { workspace, provider, error: e });
      return undefined;
    }
    let baseUrl = DEFAULT_BASE_URLS[provider];
    if (row.baseUrl !== null) {
      try {
        await assertSafeBaseUrl(row.baseUrl, this.lookup);
        baseUrl = row.baseUrl.replace(/\/+$/, '');
      } catch (e) {
        this.deps.logger.warn('BYOK base URL rejected at use time; falling back to the default', { workspace, provider, error: e });
      }
    }
    return { kind: 'byok', key, baseUrl };
  }

  /** SPEC §5.5 `resolveCredentials`: BYOK first, then platform, else `undefined`. */
  async resolveCredentials(provider: Provider, workspace: string, paidBy: 'credit' | 'byok'): Promise<Credentials | undefined> {
    if (paidBy === 'byok') {
      const byok = await this.byokCredentials(provider, workspace);
      if (byok !== undefined) return byok;
    }
    return this.platformCredentials(provider);
  }

  /** Validates a BYOK base URL for storage. */
  async validateBaseUrl(baseUrl: string): Promise<void> {
    await assertSafeBaseUrl(baseUrl, this.lookup);
  }
}
