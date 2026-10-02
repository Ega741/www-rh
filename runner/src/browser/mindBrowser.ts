/**
 * A mind's browser tab (`docs/SPEC.md` §4.1 `browser/` actions) plus frame capture.
 *
 * Screenshots use CDP `Page.captureScreenshot` (JPEG, quality 55, scale 0.7 → 896×560). The clip
 * origin is the current visual-viewport offset (`Page.getLayoutMetrics`), because CDP clip
 * coordinates are document coordinates: a fixed `(0, 0)` origin would capture blank space once the
 * page is scrolled.
 *
 * Every Playwright / CDP call that has no timeout of its own (`page.evaluate`, `page.$`,
 * `mouse.wheel`, CDP `send`) is raced against an operation timer: a renderer stuck in
 * `while (true) {}` never answers them, and a hung call must not hold the tick. Extraction runs in a
 * CDP isolated world (page scripts cannot patch the built-ins it uses) and its result is re-capped
 * in Node ({@link sanitizeRead}).
 *
 * @module browser/mindBrowser
 */
import type { BrowserContext, CDPSession, Page } from 'playwright';
import type { WsFrameData } from '@www-rh/shared';
import { errorMessage, type Logger } from '../log.js';
import type { EgressFilter } from './egress.js';
import { EXTRACT_LIMITS, extractPage, sanitizeRead, type PageLink, type PageRead } from './extract.js';

/** Viewport of every mind context. */
export const VIEWPORT = { width: 1280, height: 800 } as const;
/** Screenshot scale (896×560 frames). */
export const FRAME_SCALE = 0.7;
/** Default timeout of a single browser operation without a timeout option of its own. */
export const BROWSER_OP_TIMEOUT_MS = 10_000;

/** Browser actions available to the mind's tools. */
export interface MindBrowserApi {
  currentUrl(): string;
  navigate(url: string): Promise<PageRead>;
  read(): Promise<PageRead>;
  click(target: { link: number } | { selector: string }): Promise<PageRead>;
  type(selector: string, text: string, submit: boolean): Promise<PageRead>;
  scroll(direction: 'up' | 'down'): Promise<PageRead>;
  back(): Promise<PageRead>;
  /** JPEG (base64) of the visible viewport. */
  screenshot(): Promise<string>;
}

/** Thrown for expected, user-facing action failures (blocked URL, missing element…). */
export class BrowserActionError extends Error {}

/** A browser operation exceeded its timeout (the page is probably wedged: reset the context). */
export class BrowserTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`browser operation timed out after ${ms} ms: ${label}`);
    this.name = 'BrowserTimeoutError';
  }
}

/** Races `p` against a timer; the timer never keeps the process alive. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BrowserTimeoutError(label, ms)), ms);
    timer.unref();
  });
  p.catch(() => undefined); // a late rejection of the losing promise is not unhandled
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Source of the in-page extraction function, evaluated in an isolated world. */
const EXTRACT_SOURCE = extractPage.toString();

/** Options of {@link MindBrowser}. */
export interface MindBrowserOptions {
  /** Timeout of operations without a timeout option of their own (default {@link BROWSER_OP_TIMEOUT_MS}). */
  opTimeoutMs?: number;
}

/** One mind's tab. */
export class MindBrowser implements MindBrowserApi {
  #page: Page;
  #cdp: CDPSession | null = null;
  /** Execution context of the extraction world in the current document (recreated after navigations). */
  #world: number | null = null;
  #links: PageLink[] = [];
  #frameTimer: NodeJS.Timeout | null = null;
  #capturing = false;
  /** Pages this session is creating right now (the pop-up closer must not close them). */
  #creating = 0;
  #closed = false;
  readonly #opTimeoutMs: number;
  /** When the context was created (recycling). */
  readonly createdAt = Date.now();
  /** Ticks that used this session (recycling). */
  uses = 0;

  constructor(
    readonly context: BrowserContext,
    page: Page,
    private readonly egress: EgressFilter,
    private readonly log: Logger,
    opts: MindBrowserOptions = {},
  ) {
    this.#page = page;
    this.#opTimeoutMs = opts.opTimeoutMs ?? BROWSER_OP_TIMEOUT_MS;
    this.#instrument(page);
  }

  #instrument(page: Page): void {
    page.setDefaultNavigationTimeout(20_000);
    page.setDefaultTimeout(15_000);
    page.on('dialog', (d) => void d.dismiss().catch(() => undefined));
    page.on('crash', () => {
      if (page !== this.#page) return;
      this.log.warn('page crashed; recreating');
      void this.#recreatePage();
    });
  }

  /** Whether `page` belongs to this session (anything else in the context is a pop-up). */
  ownsPage(page: Page): boolean {
    return page === this.#page || this.#creating > 0;
  }

  /** Closes every page of the context that is not the mind's own (`context.on('page')`). */
  installPopupCloser(): void {
    this.context.on('page', (p) => {
      if (!this.ownsPage(p)) void p.close().catch(() => undefined);
    });
  }

  async #recreatePage(): Promise<void> {
    if (this.#closed) return;
    this.#cdp = null;
    this.#world = null;
    this.#links = [];
    this.#creating++;
    let page: Page;
    try {
      page = await this.context.newPage();
    } catch (err) {
      this.log.warn('could not recreate the page', { error: errorMessage(err) });
      return;
    } finally {
      this.#creating--;
    }
    this.#instrument(page);
    const old = this.#page;
    this.#page = page;
    await old.close().catch(() => undefined);
    // a pop-up opened while the new page was being created was spared by the closer: close it now
    for (const p of this.context.pages()) if (p !== page) void p.close().catch(() => undefined);
  }

  /** The page owned by this mind (other pages are pop-ups and get closed). */
  get page(): Page {
    return this.#page;
  }

  /** Whether {@link close} was called. */
  get closed(): boolean {
    return this.#closed;
  }

  currentUrl(): string {
    return this.#page.url();
  }

  #op<T>(p: Promise<T>, label: string): Promise<T> {
    return withTimeout(p, this.#opTimeoutMs, label);
  }

  async #ensureAllowed(url: string): Promise<void> {
    const verdict = await this.egress.checkUrl(url);
    if (!verdict.ok) throw new BrowserActionError(`blocked: ${verdict.reason}`);
  }

  async #session(): Promise<CDPSession> {
    if (this.#cdp === null) {
      this.#cdp = await this.#op(this.context.newCDPSession(this.#page), 'newCDPSession');
      this.#world = null;
    }
    return this.#cdp;
  }

  async #createWorld(cdp: CDPSession): Promise<number> {
    const tree = (await this.#op(cdp.send('Page.getFrameTree'), 'Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
    const world = (await this.#op(cdp.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'www-rh-extract' }), 'Page.createIsolatedWorld')) as { executionContextId: number };
    this.#world = world.executionContextId;
    return world.executionContextId;
  }

  /**
   * Runs the extraction in a CDP isolated world of the main frame: same DOM, but separate JS
   * globals and prototypes, so page scripts cannot patch what the function uses. The world is
   * reused within a document and recreated when its context is gone (navigation).
   */
  async #extractIsolated(): Promise<unknown> {
    const cdp = await this.#session();
    const evaluate = async (contextId: number) =>
      (await this.#op(
        cdp.send('Runtime.evaluate', {
          expression: `(${EXTRACT_SOURCE})(${JSON.stringify(EXTRACT_LIMITS)})`,
          contextId,
          returnByValue: true,
          timeout: this.#opTimeoutMs,
        }),
        'Runtime.evaluate',
      )) as { result: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
    let res;
    try {
      res = await evaluate(this.#world ?? (await this.#createWorld(cdp)));
    } catch (err) {
      if (err instanceof BrowserTimeoutError) throw err;
      res = await evaluate(await this.#createWorld(cdp)); // the cached context died with the previous document
    }
    if (res.exceptionDetails !== undefined) throw new Error(`extraction failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'exception'}`);
    return res.result.value;
  }

  async read(): Promise<PageRead> {
    let raw: unknown;
    try {
      raw = await this.#extractIsolated();
    } catch (err) {
      if (err instanceof BrowserTimeoutError) throw err;
      // no isolated world (e.g. the CDP session went away mid-navigation): main world, still capped in Node
      this.#cdp = null;
      this.#world = null;
      raw = await this.#op(this.#page.evaluate(extractPage, EXTRACT_LIMITS), 'page.evaluate(extract)');
    }
    const read = sanitizeRead(raw, this.#page.url());
    this.#links = read.links;
    return read;
  }

  async navigate(url: string): Promise<PageRead> {
    await this.#ensureAllowed(url);
    await this.#page.goto(url, { waitUntil: 'domcontentloaded' });
    return this.read();
  }

  /** Best-effort navigation without reading (restoring the URL of a recycled context). */
  async restore(url: string): Promise<void> {
    await this.#ensureAllowed(url);
    await this.#page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10_000 });
  }

  async click(target: { link: number } | { selector: string }): Promise<PageRead> {
    if ('link' in target) {
      const link = this.#links.find((l) => l.i === target.link);
      if (link === undefined) throw new BrowserActionError(`no link #${target.link} in the last read (call browse_read first)`);
      await this.#ensureAllowed(link.href);
      const handle = await this.#op(this.#page.$(`[data-www-i="${target.link}"]`), 'page.$');
      if (handle !== null) {
        await Promise.all([this.#page.waitForLoadState('domcontentloaded').catch(() => undefined), handle.click({ timeout: 10_000 })]);
      } else {
        await this.#page.goto(link.href, { waitUntil: 'domcontentloaded' });
      }
    } else {
      const el = await this.#op(this.#page.$(target.selector), 'page.$');
      if (el === null) throw new BrowserActionError(`no element matches ${target.selector}`);
      await el.click({ timeout: 10_000 });
      await this.#page.waitForLoadState('domcontentloaded').catch(() => undefined);
    }
    return this.read();
  }

  async type(selector: string, text: string, submit: boolean): Promise<PageRead> {
    const el = await this.#op(this.#page.$(selector), 'page.$');
    if (el === null) throw new BrowserActionError(`no element matches ${selector}`);
    const type = await this.#op(el.getAttribute('type'), 'getAttribute');
    if (type !== null && ['password', 'email', 'tel', 'file'].includes(type.toLowerCase())) {
      throw new BrowserActionError(`refusing to type into a ${type} field`);
    }
    await el.fill(text, { timeout: 10_000 });
    if (submit) {
      await el.press('Enter', { timeout: 10_000 });
      await this.#page.waitForLoadState('domcontentloaded').catch(() => undefined);
    }
    return this.read();
  }

  async scroll(direction: 'up' | 'down'): Promise<PageRead> {
    await this.#op(this.#page.mouse.wheel(0, direction === 'down' ? VIEWPORT.height * 0.8 : -VIEWPORT.height * 0.8), 'mouse.wheel');
    await this.#op(this.#page.waitForTimeout(250), 'waitForTimeout');
    return this.read();
  }

  async back(): Promise<PageRead> {
    await this.#page.goBack({ waitUntil: 'domcontentloaded' });
    return this.read();
  }

  async screenshot(): Promise<string> {
    const cdp = await this.#session();
    const metrics = (await this.#op(cdp.send('Page.getLayoutMetrics'), 'Page.getLayoutMetrics')) as { cssVisualViewport?: { pageX?: number; pageY?: number } };
    const x = metrics.cssVisualViewport?.pageX ?? 0;
    const y = metrics.cssVisualViewport?.pageY ?? 0;
    const shot = (await this.#op(
      cdp.send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 55,
        clip: { x, y, width: VIEWPORT.width, height: VIEWPORT.height, scale: FRAME_SCALE },
      }),
      'Page.captureScreenshot',
    )) as { data: string };
    return shot.data;
  }

  /** Captures one frame (skipped while another capture is in flight). */
  async captureFrame(): Promise<WsFrameData | null> {
    if (this.#capturing || this.#closed) return null;
    this.#capturing = true;
    try {
      const jpegBase64 = await this.screenshot();
      return { jpegBase64, url: this.#page.url(), at: new Date().toISOString() };
    } catch (err) {
      this.log.debug('frame capture failed', { error: errorMessage(err) });
      return null;
    } finally {
      this.#capturing = false;
    }
  }

  /** Captures frames at `fps` until {@link stopFrames} (no-op for `fps <= 0`). */
  startFrames(fps: number, onFrame: (frame: WsFrameData) => void): void {
    this.stopFrames();
    if (fps <= 0) return;
    this.#frameTimer = setInterval(() => {
      void this.captureFrame().then((f) => {
        if (f !== null) onFrame(f);
      });
    }, Math.max(100, Math.round(1000 / fps)));
    this.#frameTimer.unref();
  }

  stopFrames(): void {
    if (this.#frameTimer !== null) clearInterval(this.#frameTimer);
    this.#frameTimer = null;
  }

  /** Closes the context (bounded: a wedged browser must not hold the caller). */
  async close(): Promise<void> {
    this.#closed = true;
    this.stopFrames();
    await withTimeout(this.context.close(), 10_000, 'context.close').catch(() => undefined);
  }
}
