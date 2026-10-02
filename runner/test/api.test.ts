import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  anchorBatchHash,
  anchorBatchSchema,
  canonicalJson,
  computeResponseSchema,
  drawReceiptHash,
  healthResponseSchema,
  memorySchema,
  metadataHash,
  metadataUploadResponseSchema,
  mindDetailSchema,
  mindsResponseSchema,
  personaHash,
  publicModelSchema,
  statsResponseSchema,
  thoughtSchema,
  tradeSchema,
  wsServerMessageSchema,
  type WsServerMessage,
} from '@www-rh/shared';
import { createApi, type ApiStatus } from '../src/api/routes.js';
import { createRunnerApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { FakeLogSource } from './helpers.js';
import { startServer, type RunningServer } from '../src/api/server.js';
import { WsHub } from '../src/api/ws.js';
import type { TxQueue } from '../src/chain/txQueue.js';
import { FixedEthUsd } from '../src/economics/ethUsd.js';
import { EconomicsService } from '../src/economics/service.js';
import { Settler } from '../src/economics/settle.js';
import { applyLogs, decodeLaunchpadLogs } from '../src/indexer/apply.js';
import { MemoryService } from '../src/memory/memory.js';
import { StreamBus } from '../src/stream/bus.js';
import { encodeLog, FakeQueue, memoryRepos, mindCreatedLog, PERSONA, silentLogger, TOKEN, TOKEN2 } from './helpers.js';

const ETH = 10n ** 18n;
const NOW = 1_800_000_000_000;
const policy = { tickIntervalMs: 20_000, targetRunwayDays: 14, minDailySpendUsd: 0.5, maxTickCostUsd: 0.25, minTickBudgetUsd: 0.05 };

function world(opts: { launchpad?: string | null; rateLimit?: number } = {}) {
  const repos = memoryRepos();
  const bus = new StreamBus();
  const economics = new EconomicsService(repos, new FixedEthUsd(3_000_000_000), null, policy, silentLogger, () => NOW);
  const status: ApiStatus = {
    chainId: 46630,
    launchpad: opts.launchpad === undefined ? '0x5FbDB2315678afecb367f032d93F642f64180aa3' : opts.launchpad,
    dryRun: () => true,
    indexer: () => ({ live: true, lastError: null, headBlock: 120n, lastIndexedBlock: 118n }),
    activeMinds: () => 1,
  };
  const app = createApi({ repos, economics, bus, status, origins: ['http://localhost:5173'], log: silentLogger, now: () => NOW, metadataRateLimit: opts.rateLimit ?? 60 });
  return { repos, bus, economics, app };
}

async function seed(w: ReturnType<typeof world>) {
  const ts = BigInt(Math.floor(NOW / 1000)) - 3600n; // trades 1 h ago (inside the 24 h window)
  const logs = [
    { ...mindCreatedLog(TOKEN, 100n), blockTimestamp: ts - 100n },
    { ...mindCreatedLog(TOKEN2, 101n), blockTimestamp: ts - 50n },
    encodeLog('Trade', { token: TOKEN, trader: TOKEN2, isBuy: true, ethAmount: ETH, tokenAmount: 10n ** 24n, fee: 10n ** 16n, realEthReserve: 99n * 10n ** 16n, tokensSold: 10n ** 24n }, { block: 102n, logIndex: 0, timestamp: ts }),
    encodeLog('FeeAccrued', { token: TOKEN, mindAmount: 7n * 10n ** 15n, protocolAmount: 3n * 10n ** 15n }, { block: 102n, logIndex: 1 }),
    encodeLog('Trade', { token: TOKEN, trader: TOKEN2, isBuy: false, ethAmount: ETH / 2n, tokenAmount: 5n * 10n ** 23n, fee: ETH / 200n, realEthReserve: 48n * 10n ** 16n, tokensSold: 5n * 10n ** 23n }, { block: 103n, logIndex: 0, timestamp: ts + 1n }),
    encodeLog('MindFunded', { token: TOKEN, from: TOKEN2, amount: ETH }, { block: 104n, logIndex: 0, timestamp: ts + 2n }),
  ];
  w.repos.tx(() => applyLogs(w.repos, decodeLaunchpadLogs(logs), () => ts));
  const memory = new MemoryService(w.repos, w.bus, new FakeQueue(true) as unknown as TxQueue, { anchorEvery: 5 }, silentLogger, () => NOW);
  for (let i = 1; i <= 6; i++) memory.remember(TOKEN, i % 2 === 0 ? 'finding' : 'note', `memory number ${i} about trains`, i === 2 ? 'https://example.com/trains' : null, null);
  const tickId = w.repos.ticks.start(TOKEN, 'claude-opus-5-5', NOW - 60_000);
  w.repos.minds.tickStarted(TOKEN, NOW - 60_000);
  w.repos.ticks.finish(tickId, { endedAt: NOW - 30_000, servedModel: 'claude-opus-4-8', iterations: 3, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 9000, cacheWriteTokens: 0, costUsdMicro: 3_000_000, stopReason: 'end_turn', status: 'ok', error: null });
  w.repos.ticks.insertThought(TOKEN, tickId, 'aloud', 'Trains are neat.', NOW - 45_000);
  w.repos.ticks.insertThought(TOKEN, tickId, 'summary', 'I read about trains.', NOW - 30_000);
  const settler = new Settler(w.repos, w.economics, new FakeQueue(true) as unknown as TxQueue, { drawThresholdUsd: 2 }, silentLogger, () => undefined, () => NOW);
  await settler.settle(TOKEN);
  return { tickId };
}

const getJson = async (w: ReturnType<typeof world>, path: string): Promise<{ status: number; body: unknown; headers: Headers }> => {
  const res = await w.app.request(path);
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.arrayBuffer(), headers: res.headers };
};

describe('HTTP API (SPEC §5)', () => {
  it('GET /api/health', async () => {
    const w = world();
    const { status, body } = await getJson(w, '/api/health');
    expect(status).toBe(200);
    expect(healthResponseSchema.parse(body)).toEqual({ ok: true, chainId: 46630, launchpad: '0x5fbdb2315678afecb367f032d93f642f64180aa3', lastIndexedBlock: 118, headBlock: 120, activeMinds: 1, dryRun: true });
    const degraded = await getJson(world({ launchpad: null }), '/api/health');
    expect(healthResponseSchema.parse(degraded.body)).toMatchObject({ ok: false, launchpad: '0x0000000000000000000000000000000000000000' });
  });

  it('GET /api/minds: DTOs, 24 h activity (gross ETH), sorting, cursor pagination, validation', async () => {
    const w = world();
    await seed(w);
    const { body } = await getJson(w, '/api/minds?limit=1');
    const page1 = mindsResponseSchema.parse(body);
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0]?.token).toBe(TOKEN2); // created later → first
    expect(page1.nextCursor).not.toBeNull();
    const page2 = mindsResponseSchema.parse((await getJson(w, `/api/minds?limit=1&cursor=${page1.nextCursor}`)).body);
    expect(page2.items[0]?.token).toBe(TOKEN);
    expect(page2.nextCursor).toBeNull();
    const m = page2.items[0]!;
    expect(m.trades24h).toBe(2);
    expect(m.volume24hWei).toBe((ETH + ETH / 2n + ETH / 200n).toString()); // buy ethAmount + sell (ethAmount + fee)
    expect(m.mindBalanceWei).toBe((7n * 10n ** 15n + ETH).toString());
    expect(m.model).toBe('claude-opus-5-5');
    expect(m.lastTickAt).not.toBeNull();
    const mcap = mindsResponseSchema.parse((await getJson(w, '/api/minds?sort=mcap')).body);
    expect(mcap.items[0]?.token).toBe(TOKEN);
    const activity = mindsResponseSchema.parse((await getJson(w, '/api/minds?sort=activity')).body);
    expect(activity.items.map((i) => i.token)).toEqual([TOKEN, TOKEN2]); // nulls last
    expect((await getJson(w, '/api/minds?sort=bogus')).status).toBe(400);
    expect((await getJson(w, '/api/minds?limit=0')).status).toBe(400);
    expect((await getJson(w, '/api/minds?cursor=***')).status).toBe(400);
  });

  it('GET /api/minds/:token and sub-resources parse with the shared schemas', async () => {
    const w = world();
    const { tickId } = await seed(w);
    const detail = mindDetailSchema.parse((await getJson(w, `/api/minds/${TOKEN.toUpperCase().replace('0X', '0x')}`)).body);
    expect(detail.personaHash).toBe(personaHash(PERSONA));
    expect(detail.persona).toBeNull();
    expect(detail.personaVerified).toBe(false);
    expect(detail.links).toEqual({ x: null, website: null, telegram: null });
    expect((await getJson(w, `/api/minds/0x${'99'.repeat(20)}`)).status).toBe(404);
    expect((await getJson(w, '/api/minds/0x1234')).status).toBe(400);

    const trades = tradeSchema.array().parse((await getJson(w, `/api/minds/${TOKEN}/trades`)).body);
    expect(trades.map((t) => t.isBuy)).toEqual([false, true]);
    expect((await getJson(w, `/api/minds/${TOKEN}/trades?limit=501`)).status).toBe(400);

    const memories = memorySchema.array().parse((await getJson(w, `/api/minds/${TOKEN}/memories?limit=3`)).body);
    expect(memories.map((m) => m.seq)).toEqual([6, 5, 4]);
    const older = memorySchema.array().parse((await getJson(w, `/api/minds/${TOKEN}/memories?before=3`)).body);
    expect(older.map((m) => m.seq)).toEqual([2, 1]);

    const thoughts = thoughtSchema.array().parse((await getJson(w, `/api/minds/${TOKEN}/thoughts`)).body);
    expect(thoughts.map((t) => t.kind)).toEqual(['summary', 'aloud']);

    const compute = computeResponseSchema.parse((await getJson(w, `/api/minds/${TOKEN}/compute`)).body);
    expect(compute.ledger[0]).toMatchObject({ tickId, model: 'claude-opus-4-8', iterations: 3, costUsd: 3 });
    expect(compute.receipts).toHaveLength(1);
    const receipt = compute.receipts[0]!;
    expect(receipt.status).toBe('dry_run');
    expect(drawReceiptHash(receipt.receipt)).toBe(receipt.receiptHash);
    expect(compute.ledger[0]?.receiptHash).toBe(receipt.receiptHash);
    expect(compute.unsettledUsd).toBe(3); // dry-run receipts never settle
    expect(compute.balanceUsd).toBeCloseTo(3021, 6);
  });

  it('GET memories/batch/:from-:to returns exactly the anchored object (hash reproducible)', async () => {
    const w = world();
    await seed(w);
    const res = await w.app.request(`/api/minds/${TOKEN}/memories/batch/1-5`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const batch = anchorBatchSchema.parse(JSON.parse(text));
    expect(batch.memories.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
    const anchor = w.repos.memories.anchorsWithStatus('dry_run')[0]!;
    expect(anchor.uri).toBe(`runner://memories/${TOKEN}/1-5`);
    expect(anchorBatchHash(batch)).toBe(anchor.content_hash);
    expect(canonicalJson(batch)).toBe(text); // served bytes are already canonical
    expect((await getJson(w, `/api/minds/${TOKEN}/memories/batch/5-9`)).status).toBe(404);
    expect((await getJson(w, `/api/minds/${TOKEN}/memories/batch/3-1`)).status).toBe(400);
    expect((await getJson(w, `/api/minds/${TOKEN}/memories/batch/1-1001`)).status).toBe(400);
    expect((await getJson(w, `/api/minds/${TOKEN}/memories/batch/x`)).status).toBe(400);
  });

  it('frame.jpg, models, stats, CORS', async () => {
    const w = world();
    await seed(w);
    expect((await getJson(w, `/api/minds/${TOKEN}/frame.jpg`)).status).toBe(404);
    w.bus.publishFrame(TOKEN, { jpegBase64: Buffer.from('jpegbytes').toString('base64'), url: 'https://example.com', at: new Date(NOW).toISOString() });
    const frame = await w.app.request(`/api/minds/${TOKEN}/frame.jpg`);
    expect(frame.status).toBe(200);
    expect(frame.headers.get('content-type')).toBe('image/jpeg');
    expect(frame.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await frame.arrayBuffer()).toString()).toBe('jpegbytes');
    const models = publicModelSchema.array().parse((await getJson(w, '/api/models')).body);
    expect(models.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-fable-5-1']);
    expect(statsResponseSchema.parse((await getJson(w, '/api/stats')).body)).toEqual({
      minds: 2,
      alive: 2,
      graduated: 0,
      totalVolumeWei: (ETH + ETH / 2n + ETH / 200n).toString(),
      totalFeesToMindsWei: (7n * 10n ** 15n).toString(),
    });
    const pre = await w.app.request('/api/minds', { method: 'OPTIONS', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' } });
    expect(pre.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    const other = await w.app.request('/api/minds', { headers: { origin: 'https://evil.example' } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    expect((await getJson(w, '/api/nope')).body).toEqual({ error: 'not found' });
  });

  it('POST /api/metadata validates, hashes, stores (idempotent) and GET returns the canonical document', async () => {
    const w = world({ rateLimit: 6 });
    const meta = { symbol: 'MIND', name: 'Mind', persona: PERSONA, model: 'claude-haiku-4-5', links: { website: 'https://mind.example' } };
    const post = (body: string, type = 'application/json') => w.app.request('/api/metadata', { method: 'POST', headers: { 'content-type': type }, body });
    const res = await post(JSON.stringify(meta));
    expect(res.status).toBe(200);
    const up = metadataUploadResponseSchema.parse(await res.json());
    expect(up.hash).toBe(metadataHash(meta as Parameters<typeof metadataHash>[0]));
    expect(up.uri).toBe(`runner://metadata/${up.hash}`);
    expect(up.personaHash).toBe(personaHash(PERSONA));
    expect(await (await post(JSON.stringify(meta))).json()).toEqual(up);
    const doc = await w.app.request(`/api/metadata/${up.hash}`);
    expect(doc.headers.get('cache-control')).toContain('immutable');
    expect(await doc.text()).toBe(canonicalJson(meta));
    expect((await w.app.request(`/api/metadata/${'0'.repeat(64)}`)).status).toBe(404);
    expect((await w.app.request('/api/metadata/0xabc')).status).toBe(400);
    const extra = await post(JSON.stringify({ ...meta, extra: true }));
    expect(extra.status).toBe(400);
    expect(await extra.json()).toMatchObject({ error: expect.stringMatching(/invalid metadata/) });
    expect((await post('{not json')).status).toBe(400);
    expect((await post(JSON.stringify(meta), 'text/plain')).status).toBe(400);
    expect((await post(JSON.stringify({ ...meta, persona: 'x'.repeat(40_000) }))).status).toBe(413);
    expect((await post(JSON.stringify(meta))).status).toBe(429); // 7th request in the minute
  });
});

describe('WebSocket /ws (SPEC §6)', () => {
  let server: RunningServer;
  let w: ReturnType<typeof world>;

  beforeAll(async () => {
    w = world();
    await seed(w);
    server = await startServer(w.app, new WsHub(w.repos, w.bus, silentLogger), 0, '127.0.0.1');
  });
  afterAll(() => server.close());

  const open = (query: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws${query}`);
    const messages: WsServerMessage[] = [];
    const waiters: (() => void)[] = [];
    ws.on('message', (d) => {
      messages.push(wsServerMessageSchema.parse(JSON.parse(d.toString())));
      for (const f of waiters.splice(0)) f();
    });
    const next = async (n: number): Promise<WsServerMessage[]> => {
      while (messages.length < n) await new Promise<void>((resolve) => waiters.push(resolve));
      return messages.slice(0, n);
    };
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    return { ws, messages, next, closed };
  };

  it('hello on connect, pong on ping, bus messages forwarded, subscribe switches minds', async () => {
    const c = open(`?token=${TOKEN}`);
    const [hello] = await c.next(1);
    expect(hello).toMatchObject({ type: 'hello', token: TOKEN, status: 'alive', phase: 'bonding' });
    c.ws.send(JSON.stringify({ type: 'ping' }));
    expect((await c.next(2))[1]).toEqual({ type: 'pong' });
    w.bus.publish(TOKEN, { type: 'thought', tickId: 1, kind: 'text', text: 'hi', delta: true, at: new Date(NOW).toISOString() });
    expect((await c.next(3))[2]).toMatchObject({ type: 'thought', text: 'hi' });
    c.ws.send('x'.repeat(2000));
    expect((await c.next(4))[3]).toMatchObject({ type: 'error' });
    c.ws.send('{bad');
    expect((await c.next(5))[4]).toMatchObject({ type: 'error', message: 'invalid JSON' });
    c.ws.send(JSON.stringify({ type: 'subscribe', token: `0x${'99'.repeat(20)}` }));
    expect((await c.next(6))[5]).toEqual({ type: 'error', message: 'unknown token' });
    c.ws.send(JSON.stringify({ type: 'subscribe', token: TOKEN2 }));
    expect((await c.next(7))[6]).toMatchObject({ type: 'hello', token: TOKEN2 });
    w.bus.publish(TOKEN, { type: 'thought', tickId: 1, kind: 'text', text: 'old mind', delta: true, at: new Date(NOW).toISOString() });
    w.bus.publish(TOKEN2, { type: 'thought', tickId: 2, kind: 'text', text: 'new mind', delta: true, at: new Date(NOW).toISOString() });
    expect((await c.next(8))[7]).toMatchObject({ text: 'new mind' });
    c.ws.close();
  });

  it('malformed token → error + 1008; unknown token → error + 4404', async () => {
    const bad = open('?token=nope');
    expect(await bad.closed).toBe(1008);
    expect(bad.messages[0]).toMatchObject({ type: 'error' });
    const unknown = open(`?token=0x${'99'.repeat(20)}`);
    expect(await unknown.closed).toBe(4404);
    expect(unknown.messages[0]).toEqual({ type: 'error', message: 'unknown token' });
  });
});

describe('POST /api/metadata body limit for chunked bodies (finding 7)', () => {
  const validMeta = JSON.stringify({ name: 'Mind', symbol: 'MIND', persona: PERSONA, model: 'claude-opus-5-5' });

  it('a body streamed without Content-Length is cut at 32 KB (in-process request)', async () => {
    const w = world();
    const chunk = new Uint8Array(16 * 1024).fill(32);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 1_000) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const res = await w.app.request('/api/metadata', { method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half' } as RequestInit);
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(10); // stopped right after the limit, never read the 16 MB
    const ok = await w.app.request('/api/metadata', { method: 'POST', headers: { 'content-type': 'application/json' }, body: new Blob([validMeta]).stream(), duplex: 'half' } as RequestInit);
    expect(ok.status).toBe(200);
  });

  it('over HTTP: a chunked 64 MB upload gets 413 early and the server stops reading', async () => {
    const w = world();
    const server = await startServer(w.app, null, 0, '127.0.0.1');
    try {
      const sockets: import('node:net').Socket[] = [];
      server.server.on('connection', (socket: import('node:net').Socket) => void sockets.push(socket));
      const result = await new Promise<{ status: number; sentMiB: number }>((resolve, reject) => {
        let sent = 0;
        const req = http.request({ host: '127.0.0.1', port: server.port, path: '/api/metadata', method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode ?? 0, sentMiB: sent / 1048576 }));
        });
        req.on('error', (err) => (sent > 0 ? undefined : reject(err)));
        const chunk = Buffer.alloc(256 * 1024, 32);
        const pump = (): void => {
          while (sent < 64 * 1048576) {
            sent += chunk.length;
            if (!req.write(chunk)) {
              req.once('drain', pump);
              return;
            }
          }
          req.end();
        };
        pump();
      });
      expect(result.status).toBe(413);
      const received = sockets.reduce((n, so) => n + so.bytesRead, 0);
      expect(received).toBeLessThan(16 * 1048576); // the rest was never read into the process
      const ok = await fetch(`http://127.0.0.1:${server.port}/api/metadata`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: validMeta });
      expect(ok.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});

describe('graceful shutdown (finding 11)', () => {
  it('RunningServer.close() closes WebSocket viewers first instead of hanging', async () => {
    const w = world();
    await seed(w);
    const server = await startServer(w.app, new WsHub(w.repos, w.bus, silentLogger), 0, '127.0.0.1');
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${TOKEN}`);
    await new Promise((resolve) => ws.once('message', resolve));
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    const t0 = Date.now();
    await server.close();
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(await closed).toBe(1001);
  });

  it('app.stop() runs bounded stages and closes the DB last, also with a WebSocket viewer connected', async () => {
    const config = loadConfig({ RPC_URL: 'http://127.0.0.1:1', DB_PATH: ':memory:', PORT: '0', DRY_RUN: 'true' });
    const source = new FakeLogSource();
    source.head = 5n;
    const app = await createRunnerApp(config, { logSource: source, log: silentLogger });
    app.repos.tx(() => applyLogs(app.repos, decodeLaunchpadLogs([mindCreatedLog(TOKEN, 1n)]), () => 1n));
    await app.start();
    await app.indexer.whenLive();
    const ws = new WebSocket(`ws://127.0.0.1:${app.server!.port}/ws?token=${TOKEN}`);
    await new Promise((resolve) => ws.once('message', resolve));
    const t0 = Date.now();
    await Promise.all([app.stop(), app.stop()]); // idempotent
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(ws.readyState).toBe(WebSocket.CLOSED);
    expect(() => app.repos.minds.get(TOKEN)).toThrow(); // database closed
  });
});
