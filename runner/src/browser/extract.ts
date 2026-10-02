/**
 * Page text extraction evaluated inside the page (`docs/SPEC.md` §4.1 `read()`): readable text
 * from `main` / `article` / `body` (≤ 2 MB of DOM text considered, whitespace collapsed, ≤ 6000
 * chars) and up to 60 visible absolute http(s) links, each tagged `data-www-i="<i>"` so
 * `click({ link: i })` can find it again.
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
