/**
 * A mind's browser tab (`docs/SPEC.md` §4.1 `browser/` actions) plus frame capture.
 *
 * Screenshots use CDP `Page.captureScreenshot` (JPEG, quality 55, scale 0.7 → 896×560). The clip
 * origin is the current visual-viewport offset (`Page.getLayoutMetrics`), because CDP clip
 * coordinates are document coordinates: a fixed `(0, 0)` origin would capture blank space once the
 * page is scrolled.
 *
 * @module browser/mindBrowser
 */
import type { BrowserContext, CDPSession, Page } from 'playwright';
import type { WsFrameData } from '@www-rh/shared';
import { errorMessage, type Logger } from '../log.js';
import type { EgressFilter } from './egress.js';
import { EXTRACT_LIMITS, extractPage, type PageLink, type PageRead } from './extract.js';

/** Viewport of every mind context. */
export const VIEWPORT = { width: 1280, height: 800 } as const;
/** Screenshot scale (896×560 frames). */
export const FRAME_SCALE = 0.7;

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

/** One mind's tab. */
export class MindBrowser implements MindBrowserApi {
  #page: Page;
  #cdp: CDPSession | null = null;
  #links: PageLink[] = [];
  #frameTimer: NodeJS.Timeout | null = null;
  #capturing = false;

  constructor(
    readonly context: BrowserContext,
    page: Page,
    private readonly egress: EgressFilter,
    private readonly log: Logger,
  ) {
    this.#page = page;
    this.#instrument(page);
  }

  #instrument(page: Page): void {
    page.setDefaultNavigationTimeout(20_000);
    page.setDefaultTimeout(15_000);
    page.on('dialog', (d) => void d.dismiss().catch(() => undefined));
    page.on('crash', () => {
      this.log.warn('page crashed; recreating');
      void this.#recreatePage();
    });
  }

  async #recreatePage(): Promise<void> {
    this.#cdp = null;
    const page = await this.context.newPage();
    this.#instrument(page);
    const old = this.#page;
    this.#page = page;
    await old.close().catch(() => undefined);
  }

  /** The page owned by this mind (other pages are pop-ups and get closed). */
  get page(): Page {
    return this.#page;
  }

  currentUrl(): string {
    return this.#page.url();
  }

  async #ensureAllowed(url: string): Promise<void> {
    const verdict = await this.egress.checkUrl(url);
    if (!verdict.ok) throw new BrowserActionError(`blocked: ${verdict.reason}`);
  }

  async read(): Promise<PageRead> {
    const extracted = await this.#page.evaluate(extractPage, EXTRACT_LIMITS);
    this.#links = extracted.links;
    return { url: this.#page.url(), ...extracted };
  }

  async navigate(url: string): Promise<PageRead> {
    await this.#ensureAllowed(url);
    await this.#page.goto(url, { waitUntil: 'domcontentloaded' });
    return this.read();
  }

  async click(target: { link: number } | { selector: string }): Promise<PageRead> {
    if ('link' in target) {
      const link = this.#links.find((l) => l.i === target.link);
      if (link === undefined) throw new BrowserActionError(`no link #${target.link} in the last read (call browse_read first)`);
      await this.#ensureAllowed(link.href);
      const handle = await this.#page.$(`[data-www-i="${target.link}"]`);
      if (handle !== null) {
        await Promise.all([this.#page.waitForLoadState('domcontentloaded').catch(() => undefined), handle.click({ timeout: 10_000 })]);
      } else {
        await this.#page.goto(link.href, { waitUntil: 'domcontentloaded' });
      }
    } else {
      const el = await this.#page.$(target.selector);
      if (el === null) throw new BrowserActionError(`no element matches ${target.selector}`);
      await el.click({ timeout: 10_000 });
      await this.#page.waitForLoadState('domcontentloaded').catch(() => undefined);
    }
    return this.read();
  }

  async type(selector: string, text: string, submit: boolean): Promise<PageRead> {
    const el = await this.#page.$(selector);
    if (el === null) throw new BrowserActionError(`no element matches ${selector}`);
    const type = await el.getAttribute('type');
    if (type !== null && ['password', 'email', 'tel', 'file'].includes(type.toLowerCase())) {
      throw new BrowserActionError(`refusing to type into a ${type} field`);
    }
    await el.fill(text, { timeout: 10_000 });
    if (submit) {
      await el.press('Enter');
      await this.#page.waitForLoadState('domcontentloaded').catch(() => undefined);
    }
    return this.read();
  }

  async scroll(direction: 'up' | 'down'): Promise<PageRead> {
    await this.#page.mouse.wheel(0, direction === 'down' ? VIEWPORT.height * 0.8 : -VIEWPORT.height * 0.8);
    await this.#page.waitForTimeout(250);
    return this.read();
  }

  async back(): Promise<PageRead> {
    await this.#page.goBack({ waitUntil: 'domcontentloaded' });
    return this.read();
  }

  async screenshot(): Promise<string> {
    this.#cdp ??= await this.context.newCDPSession(this.#page);
    const metrics = (await this.#cdp.send('Page.getLayoutMetrics')) as { cssVisualViewport?: { pageX?: number; pageY?: number } };
    const x = metrics.cssVisualViewport?.pageX ?? 0;
    const y = metrics.cssVisualViewport?.pageY ?? 0;
    const shot = (await this.#cdp.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 55,
      clip: { x, y, width: VIEWPORT.width, height: VIEWPORT.height, scale: FRAME_SCALE },
    })) as { data: string };
    return shot.data;
  }

  /** Captures one frame (skipped while another capture is in flight). */
  async captureFrame(): Promise<WsFrameData | null> {
    if (this.#capturing) return null;
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

  /** Closes the context. */
  async close(): Promise<void> {
    this.stopFrames();
    await this.context.close().catch(() => undefined);
  }
}
