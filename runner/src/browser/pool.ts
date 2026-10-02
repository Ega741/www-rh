/**
 * One Chromium per process (relaunched on disconnect) and one `BrowserContext` per mind in an LRU
 * of `2 × MAX_CONCURRENT_MINDS` (`docs/SPEC.md` §4.1 `browser/`). Every context applies the egress
 * filter through `context.route` (with manual redirect validation, since route handlers are not
 * re-invoked for redirect hops) and `context.routeWebSocket`; Chromium additionally sends all
 * traffic through the local {@link EgressProxy}.
 *
 * @module browser/pool
 */
import { chromium, type Browser, type BrowserContext, type Route } from 'playwright';
import { errorMessage, type Logger } from '../log.js';
import type { EgressFilter } from './egress.js';
import { EgressProxy } from './egressProxy.js';
import { MindBrowser, VIEWPORT } from './mindBrowser.js';

/** Options of {@link BrowserPool}. */
export interface BrowserPoolOptions {
  headless: boolean;
  maxContexts: number;
  /** Route Chromium through the egress proxy (default true). */
  useProxy?: boolean;
}

/** Applies the egress filter to every request of `context` (exported for tests). */
export async function installEgressRoutes(context: BrowserContext, egress: EgressFilter, log: Logger): Promise<void> {
  await context.route('**/*', async (route: Route) => {
    const url = route.request().url();
    const verdict = await egress.checkUrl(url);
    if (!verdict.ok) {
      log.debug('request blocked', { url, reason: verdict.reason });
      await route.abort('blockedbyclient').catch(() => undefined);
      return;
    }
    try {
      const response = await route.fetch({ maxRedirects: 0, timeout: 20_000 });
      const status = response.status();
      if (status >= 300 && status < 400) {
        const location = response.headers()['location'];
        if (location !== undefined) {
          const next = await egress.checkUrl(new URL(location, url).toString());
          if (!next.ok) {
            log.debug('redirect blocked', { url, location, reason: next.reason });
            await route.abort('blockedbyclient').catch(() => undefined);
            return;
          }
        }
      }
      await route.fulfill({ response });
    } catch (err) {
      log.debug('request failed', { url, error: errorMessage(err) });
      await route.abort('failed').catch(() => undefined);
    }
  });
  await context.routeWebSocket(/.*/, async (ws) => {
    const verdict = await egress.checkUrl(ws.url().replace(/^ws/i, 'http'));
    if (!verdict.ok) {
      await ws.close({ code: 1008, reason: 'blocked' }).catch(() => undefined);
      return;
    }
    ws.connectToServer();
  });
}

/** Chromium + per-mind contexts. */
export class BrowserPool {
  #browser: Browser | null = null;
  #launching: Promise<Browser> | null = null;
  readonly #sessions = new Map<string, MindBrowser>();
  #proxy: EgressProxy | null = null;
  #closed = false;

  constructor(
    private readonly opts: BrowserPoolOptions,
    private readonly egress: EgressFilter,
    private readonly log: Logger,
  ) {}

  async #launch(): Promise<Browser> {
    if (this.#browser?.isConnected() === true) return this.#browser;
    this.#launching ??= (async () => {
      let proxyUrl: string | null = null;
      if (this.opts.useProxy !== false) {
        this.#proxy ??= new EgressProxy(this.egress, this.log.child('proxy'));
        proxyUrl = this.#proxy.url ?? (await this.#proxy.start());
      }
      const browser = await chromium.launch({
        headless: this.opts.headless,
        ...(proxyUrl !== null ? { proxy: { server: proxyUrl }, args: ['--proxy-bypass-list=<-loopback>'] } : {}),
      });
      browser.on('disconnected', () => {
        this.#browser = null;
        this.#sessions.clear();
        if (!this.#closed) this.log.warn('chromium disconnected; it will be relaunched on the next tick');
      });
      this.#browser = browser;
      return browser;
    })().finally(() => {
      this.#launching = null;
    });
    return this.#launching;
  }

  /** The mind's browser session (created lazily, LRU-refreshed). */
  async session(token: string): Promise<MindBrowser> {
    const key = token.toLowerCase();
    const existing = this.#sessions.get(key);
    if (existing !== undefined && !existing.page.isClosed()) {
      this.#sessions.delete(key);
      this.#sessions.set(key, existing);
      return existing;
    }
    const browser = await this.#launch();
    const context = await browser.newContext({ viewport: VIEWPORT, acceptDownloads: false, serviceWorkers: 'block', permissions: [] });
    await installEgressRoutes(context, this.egress, this.log);
    const page = await context.newPage();
    const session = new MindBrowser(context, page, this.egress, this.log.child(key.slice(0, 10)));
    context.on('page', (p) => {
      if (p !== session.page) void p.close().catch(() => undefined);
    });
    this.#sessions.set(key, session);
    while (this.#sessions.size > this.opts.maxContexts) {
      const [oldestKey, oldest] = this.#sessions.entries().next().value as [string, MindBrowser];
      this.#sessions.delete(oldestKey);
      void oldest.close();
    }
    return session;
  }

  /** Closes and forgets the mind's context (after a timeout); the next tick starts on `about:blank`. */
  async reset(token: string): Promise<void> {
    const key = token.toLowerCase();
    const s = this.#sessions.get(key);
    this.#sessions.delete(key);
    await s?.close();
  }

  /** Closes every context, the browser and the proxy. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const s of this.#sessions.values()) await s.close();
    this.#sessions.clear();
    await this.#browser?.close().catch(() => undefined);
    this.#browser = null;
    await this.#proxy?.close();
  }
}
