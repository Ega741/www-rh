import { describe, expect, it } from 'vitest';
import { canonicalJson, metadataDataUri, metadataHash, personaHash, type MindMetadata } from '@www-rh/shared';
import type { EgressFilter } from '../src/browser/egress.js';
import { applyLogs, decodeLaunchpadLogs } from '../src/indexer/apply.js';
import { MetadataResolver, normalizeImage, parseExternalMetadata } from '../src/metadata/resolve.js';
import { storeMetadata } from '../src/metadata/store.js';
import type { FetchText } from '../src/metadata/safeFetch.js';
import { encodeLog, memoryRepos, mindCreatedLog, PERSONA, silentLogger, TOKEN } from './helpers.js';

const GATEWAY = 'https://ipfs.io/ipfs/';
const meta: MindMetadata = { name: 'Mind', symbol: 'MIND', description: 'Curious.', image: 'ipfs://bafyimg/cat.png', persona: PERSONA, model: 'claude-opus-5-5', links: { x: 'https://x.com/mind' } };
const egress: EgressFilter = { checkUrl: async (u) => ({ ok: true, url: new URL(u), addresses: ['1.1.1.1'] }), checkHost: async () => ({ ok: true, addresses: ['1.1.1.1'] }) };

function setup(uri: string, fetchText: FetchText = async () => { throw new Error('offline'); }) {
  const repos = memoryRepos();
  repos.tx(() => applyLogs(repos, decodeLaunchpadLogs([mindCreatedLog(TOKEN, 1n)]), () => 1n));
  repos.tx(() => applyLogs(repos, decodeLaunchpadLogs([encodeLog('MindConfigUpdated', { token: TOKEN, modelId: repos.minds.get(TOKEN)!.model_id, personaHash: personaHash(PERSONA), metadataURI: uri }, { block: 2n, logIndex: 0 })]), () => 1n));
  return { repos, resolver: new MetadataResolver(repos, egress, GATEWAY, silentLogger, fetchText, () => 42) };
}

describe('metadata resolution (SPEC §4.1 metadata/)', () => {
  it('runner://metadata/<hash> from the local table; persona verified; image and links normalized', async () => {
    const { repos, resolver } = setup('placeholder');
    const stored = storeMetadata(repos, meta);
    expect(stored.ok && stored.response.hash).toBe(metadataHash(meta));
    if (!stored.ok) return;
    repos.minds.setConfig(TOKEN, repos.minds.get(TOKEN)!.model_id, personaHash(PERSONA), stored.response.uri);
    await resolver.resolve(TOKEN);
    const m = repos.minds.get(TOKEN)!;
    expect([m.meta_status, m.meta_persona, m.meta_persona_verified, m.meta_image, m.meta_description]).toEqual(['ok', PERSONA, 1, 'https://ipfs.io/ipfs/bafyimg/cat.png', 'Curious.']);
    expect(JSON.parse(m.meta_links!)).toEqual({ x: 'https://x.com/mind', website: null, telegram: null });
  });

  it('data:application/json;base64 (the web fallback), unknown keys stripped', async () => {
    const withExtra = `data:application/json;base64,${Buffer.from(JSON.stringify({ ...meta, extra: 1, links: { x: 'https://x.com/mind', discord: 'z' } })).toString('base64')}`;
    for (const uri of [metadataDataUri(meta), withExtra]) {
      const { repos, resolver } = setup(uri);
      await resolver.resolve(TOKEN);
      expect(repos.minds.get(TOKEN)?.meta_status).toBe('ok');
    }
  });

  it('ipfs:// and http(s) go through the safe fetcher (gateway prefix)', async () => {
    const seen: string[] = [];
    const fetchText: FetchText = async (url) => (seen.push(url), canonicalJson(meta));
    const ipfs = setup('ipfs://bafymeta/meta.json', fetchText);
    await ipfs.resolver.resolve(TOKEN);
    const https = setup('https://meta.example/mind.json', fetchText);
    await https.resolver.resolve(TOKEN);
    expect(seen).toEqual(['https://ipfs.io/ipfs/bafymeta/meta.json', 'https://meta.example/mind.json']);
    expect(https.repos.minds.get(TOKEN)?.meta_status).toBe('ok');
  });

  it('an unverified persona is never stored; failures null every metadata field', async () => {
    const other = metadataDataUri({ ...meta, persona: 'Someone else entirely.' });
    const a = setup(other);
    await a.resolver.resolve(TOKEN);
    expect([a.repos.minds.get(TOKEN)?.meta_status, a.repos.minds.get(TOKEN)?.meta_persona, a.repos.minds.get(TOKEN)?.meta_persona_verified]).toEqual(['ok', null, 0]);
    for (const uri of ['https://offline.example/x.json', 'gopher://x', 'data:application/json;base64,bm90IGpzb24=', 'runner://metadata/' + '0'.repeat(64), metadataDataUri({ ...meta, model: 'gpt-5' } as unknown as MindMetadata)]) {
      const b = setup(uri);
      await b.resolver.resolve(TOKEN);
      const m = b.repos.minds.get(TOKEN)!;
      expect([m.meta_status, m.meta_image, m.meta_description, m.meta_persona, m.meta_links], uri).toEqual(['error', null, null, null, null]);
    }
  });

  it('normalizeImage / parseExternalMetadata', () => {
    expect(normalizeImage('https://cdn.example/a.png', GATEWAY)).toBe('https://cdn.example/a.png');
    expect(normalizeImage('ipfs://ipfs/bafy/a.png', GATEWAY)).toBe('https://ipfs.io/ipfs/bafy/a.png');
    expect(normalizeImage('data:image/png;base64,AAAA', GATEWAY)).toBeNull();
    expect(normalizeImage(undefined, GATEWAY)).toBeNull();
    expect(() => parseExternalMetadata('{"name":"x"}')).toThrow();
  });
});
