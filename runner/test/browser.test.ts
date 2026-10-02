import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EgressFilter } from '../src/browser/egress.js';
import { BrowserActionError, type MindBrowser } from '../src/browser/mindBrowser.js';
import { BrowserPool } from '../src/browser/pool.js';
import { silentLogger } from './helpers.js';

const canLaunch = await chromium
  .launch({ headless: true })
  .then(async (b) => {
    await b.close();
    return true;
  })
  .catch(() => false);

if (!canLaunch) {
  // eslint-disable-next-line no-console
  console.info('[browser.test] Chromium could not be launched (PLAYWRIGHT_BROWSERS_PATH?) — Playwright tests skipped');
}

/** Test policy: only the loopback test server (by IP literal) is reachable. */
const policy: EgressFilter = {
  checkHost: async (host) => (host === '127.0.0.1' ? { ok: true, addresses: ['127.0.0.1'] } : { ok: false, reason: `blocked host ${host}` }),
  checkUrl: async (raw) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, reason: 'invalid URL' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: `scheme ${url.protocol}` };
    const host = await policy.checkHost(url.hostname);
    return host.ok ? { ok: true, url, addresses: host.addresses } : host;
  },
};

const ARTICLE = `<!doctype html><html><head><title>Robinhood Chain notes</title></head><body>
  <nav><a href="/nav">Navigation link</a></nav>
  <main>
    <h1>Robinhood   Chain</h1>
    <p>An Arbitrum Orbit L2.
       Blocks every 100 ms.</p>
    <a href="/page2">Next page</a>
    <a href="https://example.org/abs">Absolute link</a>
    <a href="javascript:void(0)">Script link</a>
    <a href="/hidden" style="display:none">Hidden link</a>
    <script>document.write('<p>dynamic paragraph</p>')</script>
  </main>
  <footer>footer text</footer>
</body></html>`;

describe.skipIf(!canLaunch)('MindBrowser (Playwright, headless)', () => {
  let server: http.Server;
  let base = '';
  const hits: string[] = [];
  let pool: BrowserPool;
  let mind: MindBrowser;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      const port = (server.address() as AddressInfo).port;
      if (req.url === '/article') res.writeHead(200, { 'content-type': 'text/html' }).end(ARTICLE);
      else if (req.url === '/page2') res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Page 2</title><body><p>second page body</p></body>');
      else if (req.url === '/redirect') res.writeHead(302, { location: `http://localhost:${port}/secret` }).end();
      else if (req.url === '/redirect2') res.writeHead(302, { location: `http://127.0.0.1:${port}/redirect` }).end();
      else if (req.url === '/secret') res.writeHead(200).end('SECRET');
      else res.writeHead(404).end('nope');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    pool = new BrowserPool({ headless: true, maxContexts: 2 }, policy, silentLogger);
    mind = await pool.session('0x1111111111111111111111111111111111111111');
  });

  afterAll(async () => {
    await pool?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('extracts readable text (main element, collapsed whitespace) and visible absolute http(s) links', async () => {
    const read = await mind.navigate(`${base}/article`);
    expect(read.url).toBe(`${base}/article`);
    expect(read.title).toBe('Robinhood Chain notes');
    expect(read.text).toBe('Robinhood Chain An Arbitrum Orbit L2. Blocks every 100 ms. Next page Absolute link Script link dynamic paragraph');
    expect(read.text).not.toContain('footer text');
    expect(read.links).toEqual([
      { i: 0, text: 'Navigation link', href: `${base}/nav` },
      { i: 1, text: 'Next page', href: `${base}/page2` },
      { i: 2, text: 'Absolute link', href: 'https://example.org/abs' },
    ]);
  });

  it('caps text at 6000 characters and links at 60', async () => {
    const links = Array.from({ length: 80 }, (_, i) => `<a href="/l${i}">link ${i}</a>`).join(' ');
    await mind.page.setContent(`<body><main><p>${'word '.repeat(5000)}</p>${links}</main></body>`);
    const read = await mind.read();
    expect(read.text.length).toBe(6000);
    expect(read.links).toHaveLength(60);
  });

  it('clicks a numbered link and reads the next page', async () => {
    await mind.navigate(`${base}/article`);
    const next = await mind.click({ link: 1 });
    expect(next.url).toBe(`${base}/page2`);
    expect(next.text).toBe('second page body');
    await expect(mind.click({ link: 99 })).rejects.toBeInstanceOf(BrowserActionError);
  });

  it('refuses blocked URLs before navigating', async () => {
    await expect(mind.navigate('http://localhost:1/')).rejects.toThrow(/blocked/);
    await expect(mind.navigate('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/blocked/);
    await expect(mind.navigate('file:///etc/passwd')).rejects.toThrow(/blocked/);
  });

  it('blocks redirects to blocked targets, including later hops the route handler never sees', async () => {
    await expect(mind.navigate(`${base}/redirect`)).rejects.toThrow();
    // 1st hop (/redirect2 → /redirect) passes the route handler's Location check; the browser then
    // follows /redirect → localhost/secret on its own, which only the egress proxy can see and block.
    await mind.navigate(`${base}/redirect2`).catch(() => undefined);
    await mind.page.waitForURL(/\/secret/, { timeout: 5_000 }).catch(() => undefined);
    await mind.page.waitForLoadState('domcontentloaded').catch(() => undefined);
    expect(hits).toContain('/redirect');
    expect(hits).not.toContain('/secret');
    expect(await mind.page.content()).not.toContain('SECRET');
  });

  it('blocks websockets to blocked hosts and closes pop-ups', async () => {
    await mind.navigate(`${base}/page2`);
    const result = await mind.page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const ws = new WebSocket('ws://localhost:9/');
          ws.onopen = () => resolve('open');
          ws.onclose = (e) => resolve(`closed ${e.code}`);
          ws.onerror = () => resolve('error');
          setTimeout(() => resolve('timeout'), 5000);
        }),
    );
    expect(result).not.toBe('open');
    await mind.page.evaluate(() => window.open('about:blank', '_blank'));
    await new Promise((r) => setTimeout(r, 300));
    expect(mind.context.pages()).toHaveLength(1);
  });

  it('captures 896x560 JPEG frames of the visible viewport', async () => {
    const b64 = await mind.screenshot();
    const buf = Buffer.from(b64, 'base64');
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xd8);
    let i = 2;
    let size: [number, number] | null = null;
    while (i < buf.length) {
      const marker = buf[i + 1] as number;
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xc2) {
        size = [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
        break;
      }
      i += 2 + len;
    }
    expect(size).toEqual([896, 560]);
  });
});
