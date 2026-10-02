/**
 * Page text extraction evaluated inside the page (`docs/SPEC.md` §4.1 `read()`): readable text
 * from `main` / `article` / `body` (≤ 2 MB of DOM text considered, whitespace collapsed, ≤ 6000
 * chars) and up to 60 visible absolute http(s) links, each tagged `data-www-i="<i>"` so
 * `click({ link: i })` can find it again.
 *
 * The in-page function runs in an isolated world when possible (page scripts cannot patch its
 * built-ins), but its result is untrusted either way: {@link sanitizeRead} re-applies every cap in
 * Node (text / title / link count and lengths, URL parsing) and bounds the serialized size.
 *
 * @module browser/extract
 */

/** Limits of {@link extractPage}. */
export interface ExtractLimits {
  maxText: number;
  maxLinks: number;
  maxDomText: number;
}

/** Default limits from the spec. */
export const EXTRACT_LIMITS: ExtractLimits = { maxText: 6_000, maxLinks: 60, maxDomText: 2_000_000 };

/** One link of a read result. */
export interface PageLink {
  i: number;
  text: string;
  href: string;
}

/** What `read()` returns. */
export interface PageRead {
  url: string;
  title: string;
  text: string;
  links: PageLink[];
}

/**
 * The in-page function (serialized by Playwright; must be self-contained).
 * Returns everything except `url`, which the caller takes from the page.
 */
export function extractPage(limits: ExtractLimits): Omit<PageRead, 'url'> {
  const root = document.querySelector('main') ?? document.querySelector('article') ?? document.body;
  let raw = root.innerText;
  if (raw.length > limits.maxDomText) raw = raw.slice(0, limits.maxDomText);
  const text = raw.replace(/\s+/g, ' ').trim().slice(0, limits.maxText);
  for (const el of Array.from(document.querySelectorAll('[data-www-i]'))) el.removeAttribute('data-www-i');
  const links: { i: number; text: string; href: string }[] = [];
  const seen = new Set<string>();
  for (const a of Array.from(document.querySelectorAll('a[href]'))) {
    if (links.length >= limits.maxLinks) break;
    if (!(a instanceof HTMLAnchorElement)) continue;
    const href = a.href;
    if (!/^https?:\/\//i.test(href) || seen.has(href)) continue;
    const rect = a.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const label = (a.innerText || a.getAttribute('aria-label') || a.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (label === '') continue;
    seen.add(href);
    a.setAttribute('data-www-i', String(links.length));
    links.push({ i: links.length, text: label, href });
  }
  return { title: document.title.slice(0, 300), text, links };
}

/** Node-side caps re-applied to every read result. */
export const READ_CAPS = { title: 300, linkText: 120, href: 2_048, url: 2_048, serializedChars: 24_000 } as const;

/** Collapses whitespace runs and caps the length (idempotent on the in-page output). */
const collapse = (raw: string, max: number): string => raw.slice(0, max * 4).replace(/\s+/g, ' ').slice(0, max);

/** Parses an absolute http(s) URL without credentials, or `null`. */
function safeHref(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > READ_CAPS.href) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username !== '' || u.password !== '') return null;
  return u.href.length <= READ_CAPS.href ? u.href : null;
}

/**
 * Re-validates an extraction result in Node: whatever the page (or a page script tampering with
 * the evaluated function) returned, the result has at most `maxText` chars of text, a title of
 * ≤ 300 chars, ≤ `maxLinks` links with integer indexes, ≤ 120-char labels and parsed absolute
 * http(s) hrefs (≤ 2048 chars), and serializes to ≤ 24 000 chars (links dropped from the end).
 */
export function sanitizeRead(raw: unknown, url: string, limits: ExtractLimits = EXTRACT_LIMITS): PageRead {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const text = typeof o['text'] === 'string' ? collapse(o['text'], limits.maxText) : '';
  const title = typeof o['title'] === 'string' ? o['title'].slice(0, READ_CAPS.title) : '';
  const links: PageLink[] = [];
  const seen = new Set<number>();
  const rawLinks = Array.isArray(o['links']) ? (o['links'] as unknown[]).slice(0, limits.maxLinks) : [];
  for (const l of rawLinks) {
    if (typeof l !== 'object' || l === null) continue;
    const { i, text: label, href } = l as Record<string, unknown>;
    if (typeof i !== 'number' || !Number.isSafeInteger(i) || i < 0 || i >= limits.maxLinks || seen.has(i)) continue;
    const h = safeHref(href);
    const t = typeof label === 'string' ? collapse(label, READ_CAPS.linkText) : '';
    if (h === null || t.trim() === '') continue;
    seen.add(i);
    links.push({ i, text: t, href: h });
  }
  const read: PageRead = { url: url.slice(0, READ_CAPS.url), title, text, links };
  while (read.links.length > 0 && JSON.stringify(read).length > READ_CAPS.serializedChars) read.links.pop();
  return read;
}
