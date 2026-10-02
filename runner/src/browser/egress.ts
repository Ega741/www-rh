/**
 * Egress filter (`docs/SPEC.md` §4.1 `browser/`), shared by the browser route handlers, the
 * egress proxy, tool `run` functions and the metadata fetcher.
 *
 * Only `http:` / `https:` URLs without credentials are allowed. IP literals (any notation the
 * WHATWG URL parser normalizes, including IPv4-mapped / -compatible IPv6) are checked directly;
 * hostnames are resolved (`dns.lookup(host, { all: true })`) and blocked when ANY address is
 * loopback, private, link-local, CGNAT, multicast, unspecified, broadcast, reserved/documentation,
 * or an IPv6 form embedding such an IPv4 address. The resolver is injectable for tests.
 *
 * @module browser/egress
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** One resolved address. */
export interface ResolvedAddress {
  address: string;
  family: number;
}

/** Hostname resolver (`dns.lookup(host, { all: true })` by default). */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

/** Default resolver. */
export const dnsResolver: Resolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

/** Result of an egress check. */
export type EgressVerdict = { ok: true; url: URL; addresses: string[] } | { ok: false; reason: string };

interface Cidr4 {
  base: number;
  bits: number;
  label: string;
}

const V4_BLOCKS: readonly Cidr4[] = (
  [
    ['0.0.0.0', 8, 'unspecified'],
    ['10.0.0.0', 8, 'private'],
    ['100.64.0.0', 10, 'cgnat'],
    ['127.0.0.0', 8, 'loopback'],
    ['169.254.0.0', 16, 'link-local'],
    ['172.16.0.0', 12, 'private'],
    ['192.0.0.0', 24, 'reserved'],
    ['192.0.2.0', 24, 'documentation'],
    ['192.88.99.0', 24, 'reserved'],
    ['192.168.0.0', 16, 'private'],
    ['198.18.0.0', 15, 'benchmark'],
    ['198.51.100.0', 24, 'documentation'],
    ['203.0.113.0', 24, 'documentation'],
    ['224.0.0.0', 4, 'multicast'],
    ['255.255.255.255', 32, 'broadcast'],
    ['240.0.0.0', 4, 'reserved'],
  ] as const
).map(([ip, bits, label]) => ({ base: v4ToInt(ip) as number, bits, label }));

/** Parses dotted-quad IPv4 into an unsigned 32-bit integer, or `undefined`. */
function v4ToInt(ip: string): number | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return undefined;
    const v = Number(p);
    if (v > 255) return undefined;
    n = n * 256 + v;
  }
  return n;
}

/** Why an IPv4 address is blocked, or `null` when it is public. */
export function classifyIPv4(ip: string): string | null {
  const n = v4ToInt(ip);
  if (n === undefined) return 'invalid-ipv4';
  for (const b of V4_BLOCKS) {
    const size = 2 ** (32 - b.bits);
    if (n >= b.base && n < b.base + size) return b.label;
  }
  return null;
}

/** Expands an IPv6 address (optionally with a dotted IPv4 tail and/or `%zone`) to 8 hextets. */
export function parseIPv6(input: string): number[] | undefined {
  let ip = input.replace(/^\[|\]$/g, '');
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  const lastColon = ip.lastIndexOf(':');
  if (lastColon < 0) return undefined;
  const last = ip.slice(lastColon + 1);
  if (last.includes('.')) {
    const n = v4ToInt(last);
    if (n === undefined) return undefined;
    ip = `${ip.slice(0, lastColon + 1)}${Math.floor(n / 65536).toString(16)}:${(n % 65536).toString(16)}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return undefined;
  const parse = (s: string): number[] | undefined => {
    if (s === '') return [];
    const out: number[] = [];
    for (const h of s.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(h)) return undefined;
      out.push(parseInt(h, 16));
    }
    return out;
  };
  const head = parse(halves[0] as string);
  const rest = halves.length === 2 ? parse(halves[1] as string) : [];
  if (head === undefined || rest === undefined) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const fill = 8 - head.length - rest.length;
  if (fill < 1) return undefined;
  return [...head, ...new Array<number>(fill).fill(0), ...rest];
}

function embeddedV4(h: number[], from: number): string {
  const a = h[from] as number;
  const b = h[from + 1] as number;
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
}

/** Why an IPv6 address is blocked, or `null` when it is public. */
export function classifyIPv6(ip: string): string | null {
  const h = parseIPv6(ip);
  if (h === undefined) return 'invalid-ipv6';
  const [h0, h1, h2, h3, h4, h5, h6, h7] = h as [number, number, number, number, number, number, number, number];
  const zeros = (...xs: number[]): boolean => xs.every((x) => x === 0);
  if (zeros(h0, h1, h2, h3, h4, h5, h6, h7)) return 'unspecified';
  if (zeros(h0, h1, h2, h3, h4, h5, h6) && h7 === 1) return 'loopback';
  if (zeros(h0, h1, h2, h3, h4) && h5 === 0xffff) {
    const inner = classifyIPv4(embeddedV4(h, 6));
    return inner === null ? null : `ipv4-mapped-${inner}`;
  }
  if (zeros(h0, h1, h2, h3, h4, h5)) {
    const inner = classifyIPv4(embeddedV4(h, 6)); // IPv4-compatible (deprecated)
    return inner === null ? null : `ipv4-compatible-${inner}`;
  }
  if (h0 === 0x64 && h1 === 0xff9b && zeros(h2, h3, h4, h5)) {
    const inner = classifyIPv4(embeddedV4(h, 6)); // NAT64
    return inner === null ? null : `nat64-${inner}`;
  }
  if (h0 === 0x2002) {
    const inner = classifyIPv4(embeddedV4(h, 1)); // 6to4
    return inner === null ? null : `6to4-${inner}`;
  }
  if (h0 === 0x2001 && h1 === 0) return 'teredo';
  if (h0 === 0x2001 && h1 === 0x0db8) return 'documentation';
  if (h0 === 0x0100 && zeros(h1, h2, h3)) return 'discard';
  if ((h0 & 0xfe00) === 0xfc00) return 'private';
  if ((h0 & 0xffc0) === 0xfe80) return 'link-local';
  if ((h0 & 0xffc0) === 0xfec0) return 'site-local';
  if ((h0 & 0xff00) === 0xff00) return 'multicast';
  return null;
}

/** Why an IP literal (v4 or v6) is blocked, or `null` when public. */
export function classifyIp(ip: string): string | null {
  const bare = ip.replace(/^\[|\]$/g, '');
  const kind = isIP(bare.split('%')[0] as string);
  if (kind === 4) return classifyIPv4(bare);
  if (kind === 6) return classifyIPv6(bare);
  return 'not-an-ip';
}

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

/** Checks a hostname (IP literal or DNS name) and returns its allowed addresses. */
export async function checkHost(hostname: string, resolve: Resolver = dnsResolver): Promise<{ ok: true; addresses: string[] } | { ok: false; reason: string }> {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === '') return { ok: false, reason: 'empty host' };
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare.split('%')[0] as string) !== 0) {
    const reason = classifyIp(bare);
    return reason === null ? { ok: true, addresses: [bare] } : { ok: false, reason: `blocked address ${bare} (${reason})` };
  }
  if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) return { ok: false, reason: `blocked host ${host}` };
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolve(host);
  } catch (err) {
    return { ok: false, reason: `cannot resolve ${host}: ${(err as Error).message}` };
  }
  if (addresses.length === 0) return { ok: false, reason: `cannot resolve ${host}` };
  for (const a of addresses) {
    const reason = classifyIp(a.address);
    if (reason !== null) return { ok: false, reason: `${host} resolves to blocked address ${a.address} (${reason})` };
  }
  return { ok: true, addresses: addresses.map((a) => a.address) };
}

/** Checks a URL against the egress policy. */
export async function checkUrl(raw: string, resolve: Resolver = dnsResolver): Promise<EgressVerdict> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: `scheme ${url.protocol} not allowed` };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials in URL not allowed' };
  const host = await checkHost(url.hostname, resolve);
  return host.ok ? { ok: true, url, addresses: host.addresses } : { ok: false, reason: host.reason };
}

/** A configured egress filter (policy + resolver). */
export interface EgressFilter {
  checkUrl(url: string): Promise<EgressVerdict>;
  checkHost(hostname: string): ReturnType<typeof checkHost>;
}

/** Creates an {@link EgressFilter} using `resolve`. */
export function createEgressFilter(resolve: Resolver = dnsResolver): EgressFilter {
  return { checkUrl: (url) => checkUrl(url, resolve), checkHost: (host) => checkHost(host, resolve) };
}
