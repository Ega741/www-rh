import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkUrl, classifyIp, createEgressFilter, parseIPv6, type EgressFilter, type Resolver } from '../src/browser/egress.js';
import { EgressProxy } from '../src/browser/egressProxy.js';
import { safeFetchText } from '../src/metadata/safeFetch.js';
import { silentLogger } from './helpers.js';

describe('IP classification', () => {
  it.each([
    ['8.8.8.8', null],
    ['1.1.1.1', null],
    ['172.32.0.1', null],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'link-local'],
    ['100.64.0.1', 'cgnat'],
    ['224.0.0.251', 'multicast'],
    ['0.0.0.0', 'unspecified'],
    ['255.255.255.255', 'broadcast'],
    ['240.0.0.1', 'reserved'],
  ])('IPv4 %s → %s', (ip, expected) => {
    expect(classifyIp(ip)).toBe(expected);
  });

  it.each([
    ['2001:4860:4860::8888', null],
    ['::ffff:8.8.8.8', null],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['::ffff:127.0.0.1', 'ipv4-mapped-loopback'],
    ['::ffff:7f00:1', 'ipv4-mapped-loopback'],
    ['0:0:0:0:0:ffff:a9fe:a9fe', 'ipv4-mapped-link-local'],
    ['::ffff:10.0.0.1', 'ipv4-mapped-private'],
    ['::127.0.0.1', 'ipv4-compatible-loopback'],
    ['64:ff9b::a00:1', 'nat64-private'],
    ['2002:7f00:1::', '6to4-loopback'],
    ['fc00::1', 'private'],
    ['fd12:3456::1', 'private'],
    ['fe80::1%eth0', 'link-local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['2001:0:4136:e378::1', 'teredo'],
  ])('IPv6 %s → %s', (ip, expected) => {
    expect(classifyIp(ip)).toBe(expected);
  });

  it('parses IPv6 forms', () => {
    expect(parseIPv6('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(parseIPv6('[2001:db8::1]')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIPv6('1::2::3')).toBeUndefined();
    expect(parseIPv6('1:2:3')).toBeUndefined();
    expect(classifyIp('example.com')).toBe('not-an-ip');
  });
});

describe('URL checks (stub resolver, no network)', () => {
  const resolver: Resolver = async (host) => {
    const table: Record<string, string[]> = {
      'public.test': ['93.184.216.34'],
      'dual.test': ['93.184.216.34', '10.0.0.7'],
      'internal.test': ['192.168.0.10'],
      'v6private.test': ['fd00::1'],
      'mapped.test': ['::ffff:169.254.169.254'],
    };
    const hit = table[host];
    if (hit === undefined) throw new Error('ENOTFOUND');
    return hit.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };

  it.each([
    ['https://public.test/page', true],
    ['http://public.test:8080/x?y=1', true],
    ['http://dual.test/', false], // ANY private address blocks
    ['http://internal.test/', false],
    ['http://v6private.test/', false],
    ['http://mapped.test/', false],
    ['http://nxdomain.test/', false],
    ['http://127.0.0.1/', false],
    ['http://2130706433/', false], // decimal IPv4 → 127.0.0.1
    ['http://0x7f.1/', false], // hex/short IPv4 → 127.0.0.1
    ['http://[::ffff:127.0.0.1]/', false],
    ['http://[::1]:8545/', false],
    ['http://169.254.169.254/latest/meta-data/', false],
    ['http://localhost:8787/api/health', false],
    ['http://foo.localhost/', false],
    ['http://printer.local/', false],
    ['http://user:pass@public.test/', false],
    ['file:///etc/passwd', false],
    ['ftp://public.test/', false],
    ['javascript:alert(1)', false],
    ['data:text/html,hi', false],
    ['not a url', false],
  ])('%s → allowed=%s', async (url, allowed) => {
    expect((await checkUrl(url, resolver)).ok).toBe(allowed);
  });

  it('reports the blocking reason and the resolved addresses', async () => {
    const blocked = await checkUrl('http://dual.test/', resolver);
    expect(blocked.ok === false && blocked.reason).toMatch(/10\.0\.0\.7 \(private\)/);
    const ok = await checkUrl('https://public.test/', resolver);
    expect(ok.ok === true && ok.addresses).toEqual(['93.184.216.34']);
  });
});

// A policy for local integration tests: only the host "good.test" (served on 127.0.0.1) is allowed.
function localPolicy(): EgressFilter {
  const base = createEgressFilter(async (host) => (host === 'good.test' ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '10.0.0.1', family: 4 }]));
  return {
    checkHost: async (host) => {
      const r = await base.checkHost(host);
      return r.ok ? { ok: true, addresses: ['127.0.0.1'] } : r;
    },
    checkUrl: async (url) => {
      const r = await base.checkUrl(url);
      return r.ok ? { ...r, addresses: ['127.0.0.1'] } : r;
    },
  };
}

describe('redirect hops and tunnels (local servers, simulated hostnames)', () => {
  let server: http.Server;
  let port = 0;
  const hits: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/redirect-evil') res.writeHead(302, { location: `http://evil.test:${port}/secret` }).end();
      else if (req.url === '/redirect-good') res.writeHead(302, { location: `http://good.test:${port}/meta.json` }).end();
      else if (req.url === '/meta.json') res.writeHead(200, { 'content-type': 'application/json' }).end('{"name":"Mind"}');
      else if (req.url === '/big') res.writeHead(200).end('x'.repeat(70_000));
      else res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('safeFetchText re-checks every redirect hop and pins the validated address', async () => {
    const egress = localPolicy();
    await expect(safeFetchText(`http://good.test:${port}/redirect-good`, egress)).resolves.toBe('{"name":"Mind"}');
    await expect(safeFetchText(`http://good.test:${port}/redirect-evil`, egress)).rejects.toThrow(/blocked/);
    expect(hits).not.toContain('/secret');
    await expect(safeFetchText(`http://evil.test:${port}/meta.json`, egress)).rejects.toThrow(/blocked/);
    await expect(safeFetchText(`http://good.test:${port}/big`, egress)).rejects.toThrow(/exceeds/);
  });

  it('the egress proxy blocks plain-HTTP requests and CONNECT tunnels (https / websockets) to blocked hosts', async () => {
    const proxy = new EgressProxy(localPolicy(), silentLogger);
    const proxyUrl = new URL(await proxy.start());
    try {
      const get = (target: string): Promise<number> =>
        new Promise((resolve, reject) => {
          const req = http.request({ host: proxyUrl.hostname, port: Number(proxyUrl.port), path: target, method: 'GET', headers: { host: new URL(target).host } }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          req.on('error', reject);
          req.end();
        });
      expect(await get(`http://good.test:${port}/meta.json`)).toBe(200);
      expect(await get(`http://evil.test:${port}/secret`)).toBe(403);
      expect(hits).not.toContain('/secret');

      const connect = (target: string): Promise<string> =>
        new Promise((resolve, reject) => {
          const socket = net.connect(Number(proxyUrl.port), proxyUrl.hostname, () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
          socket.once('data', (d) => {
            resolve(d.toString('utf8').split('\r\n')[0] ?? '');
            socket.destroy();
          });
          socket.on('error', reject);
        });
      expect(await connect(`good.test:${port}`)).toBe('HTTP/1.1 200 Connection Established');
      expect(await connect('evil.test:443')).toBe('HTTP/1.1 403 Forbidden');
      expect(await connect('127.0.0.1:22')).toBe('HTTP/1.1 403 Forbidden');
    } finally {
      await proxy.close();
    }
  });
});
