import { createServer, type IncomingHttpHeaders, type RequestListener, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { localeForCountry, lookupProxyRegion, type RegionObservation } from './region-lookup.js';

const FAILURE = 'Proxy region lookup failed';
const MAX_BYTES = 32 * 1024;
const servers: Server[] = [];
const sockets = new Set<Socket>();
const timers = new Set<ReturnType<typeof setTimeout>>();
const provider = { success: true, ip: '203.0.113.17', country_code: 'DE', timezone: { id: 'Europe/Berlin' } };

function later(callback: () => void, ms: number) {
  const timer = setTimeout(() => { timers.delete(timer); callback(); }, ms);
  timers.add(timer);
}
function track(server: Server) {
  servers.push(server);
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
}
async function listen(server: Server) {
  track(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function endpoint(handler: RequestListener) {
  return `${await listen(createServer(handler))}/region?fixture=1`;
}
async function proxyFixture(target: string, options: { stall?: boolean; reject?: boolean; authorization?: string } = {}) {
  const seen: Array<{ path: string | undefined; headers: IncomingHttpHeaders }> = [];
  const server = createServer((_request, response) => response.writeHead(500).end());
  const destination = new URL(target);
  server.on('connect', (request, client, head) => {
    seen.push({ path: request.url, headers: request.headers });
    if (options.stall) return;
    if (options.reject || (options.authorization && request.headers['proxy-authorization'] !== options.authorization)) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = connect(Number(destination.port), destination.hostname, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  });
  return { url: await listen(server), seen };
}
async function jsonLookup(value: unknown, headers: IncomingHttpHeaders = {}) {
  const url = await endpoint((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', ...headers });
    response.end(typeof value === 'string' ? value : JSON.stringify(value));
  });
  const proxy = await proxyFixture(url);
  return lookupProxyRegion({ proxy: proxy.url, endpoint: url, timeoutMs: 1000 });
}
async function fixedFailure(pending: Promise<unknown>) {
  const error = await pending.then(() => null, failure => failure as Error);
  expect(error).toBeInstanceOf(Error);
  expect(error?.message).toBe(FAILURE);
  expect(error?.cause).toBeUndefined();
}

afterEach(async () => {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe('localeForCountry', () => {
  it('uses curated country defaults rather than claiming an observed native language', () => {
    const expected = {
      US: 'en-US', GB: 'en-GB', DE: 'de-DE', FR: 'fr-FR', JP: 'ja-JP', SG: 'en-SG', NZ: 'en-NZ',
      AU: 'en-AU', CA: 'en-CA', HK: 'zh-HK', TW: 'zh-TW', CN: 'zh-CN', NL: 'nl-NL', BR: 'pt-BR',
      ES: 'es-ES', IT: 'it-IT', IN: 'hi-IN', KR: 'ko-KR', MX: 'es-MX', ZA: 'en-ZA', AE: 'ar-AE',
      SE: 'sv-SE', PL: 'pl-PL', TR: 'tr-TR', VN: 'vi-VN', ID: 'id-ID', TH: 'th-TH', AR: 'es-AR',
    };
    for (const [country, locale] of Object.entries(expected)) expect(localeForCountry(country)).toBe(locale);
    expect(localeForCountry('de')).toBe('de-DE');
    expect(localeForCountry(' de ')).toBe('de-DE');
    for (const country of ['', 'ZZ', 'XX', 'USA', 'constructor', '__proto__', 'AQ']) expect(localeForCountry(country)).toBeNull();
  });
});

describe('lookupProxyRegion', () => {
  it('uses real authenticated CONNECT, JSON/identity headers and only projects the region schema', async () => {
    const targetHeaders: IncomingHttpHeaders[] = [];
    const paths: Array<string | undefined> = [];
    const url = await endpoint((request, response) => {
      targetHeaders.push(request.headers);
      paths.push(request.url);
      response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'PRIVATE_ACCOUNT=secret; Path=/' });
      response.end(JSON.stringify({ ...provider, country: 'PRIVATE_PROVIDER_TEXT', extra: 'PRIVATE_EXTRA', timezone: { ...provider.timezone, utc: 'PRIVATE_TIMEZONE' } }));
    });
    const proxy = await proxyFixture(url, { authorization: 'Basic dXNlcjpwQHNz' });
    const authenticated = proxy.url.replace('://', '://user:p%40ss@');
    const expected: RegionObservation = { ip: provider.ip, countryCode: 'DE', timezone: 'Europe/Berlin', locale: 'de-DE' };
    for (let n = 0; n < 2; n++) expect(await lookupProxyRegion({ proxy: authenticated, endpoint: url, timeoutMs: 1000 })).toEqual(expected);
    expect(proxy.seen).toHaveLength(2);
    for (const request of proxy.seen) {
      expect(request.path).toBe(new URL(url).host);
      expect(request.headers['proxy-authorization']).toBe('Basic dXNlcjpwQHNz');
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers.cookie).toBeUndefined();
    }
    expect(paths).toEqual(['/region?fixture=1', '/region?fixture=1']);
    for (const headers of targetHeaders) {
      expect(headers.accept).toBe('application/json');
      expect(headers['accept-encoding']).toBe('identity');
      expect(headers.authorization).toBeUndefined();
      expect(headers['proxy-authorization']).toBeUndefined();
      expect(headers.cookie).toBeUndefined();
    }
  });

  it('accepts IPv6 and returns null for an unmapped valid country', async () => {
    expect(await jsonLookup({ ...provider, ip: '2001:db8::1234', country_code: 'AQ', timezone: { id: 'Antarctica/McMurdo' } }))
      .toEqual({ ip: '2001:db8::1234', countryCode: 'AQ', timezone: 'Antarctica/McMurdo', locale: null });
  });

  it.each([
    ['provider failure', { success: false, message: 'PRIVATE_PROVIDER_FAILURE' }],
    ['missing success', { ip: provider.ip, country_code: 'DE', timezone: { id: 'Europe/Berlin' } }],
    ['truthy success', { ...provider, success: 'true' }],
    ['malformed IP', { ...provider, ip: '999.0.0.1' }],
    ['missing IP', { ...provider, ip: undefined }],
    ['lowercase country', { ...provider, country_code: 'de' }],
    ['unknown country', { ...provider, country_code: 'ZZ' }],
    ['long country', { ...provider, country_code: 'USA' }],
    ['missing timezone', { ...provider, timezone: {} }],
    ['invalid timezone', { ...provider, timezone: { id: 'PRIVATE/not-a-zone' } }],
    ['date instead of timezone', { ...provider, timezone: { id: '2026-11-17' } }],
    ['offset instead of IANA timezone', { ...provider, timezone: { id: '+01:00' } }],
    ['empty timezone', { ...provider, timezone: { id: '' } }],
    ['whitespace timezone', { ...provider, timezone: { id: ' Europe/Berlin ' } }],
    ['HTML', '<html>PRIVATE_HTML_FAILURE</html>'],
    ['malformed JSON', '{"success":true, PRIVATE_JSON_ERROR'],
    ['array', [provider]],
    ['null', null],
  ])('rejects %s with a fixed error', async (_name, value) => {
    await fixedFailure(jsonLookup(value));
  });

  it('accepts exactly 32 KiB and caps chunked bodies without trusting Content-Length', async () => {
    const prefix = JSON.stringify(provider).slice(0, -1) + ',"padding":"';
    const sized = (size: number) => prefix + 'x'.repeat(size - Buffer.byteLength(prefix) - 2) + '"}';
    expect(Buffer.byteLength(sized(MAX_BYTES))).toBe(MAX_BYTES);
    expect(await jsonLookup(sized(MAX_BYTES))).toMatchObject({ countryCode: 'DE' });
    const url = await endpoint((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write(sized(MAX_BYTES).slice(0, MAX_BYTES - 2));
      response.end('x"}');
    });
    const proxy = await proxyFixture(url);
    await fixedFailure(lookupProxyRegion({ proxy: proxy.url, endpoint: url, timeoutMs: 1000 }));
  });

  it('rejects HTML content types and compressed responses despite valid JSON', async () => {
    await fixedFailure(jsonLookup(provider, { 'content-type': 'text/html' }));
    const compressed = gzipSync(JSON.stringify({ ...provider, padding: 'x'.repeat(MAX_BYTES * 2) }));
    const url = await endpoint((_request, response) => response.writeHead(200, {
      'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': compressed.length,
    }).end(compressed));
    const proxy = await proxyFixture(url);
    await fixedFailure(lookupProxyRegion({ proxy: proxy.url, endpoint: url, timeoutMs: 1000 }));
  });

  it('returns fixed failures for HTTP errors and never follows redirects', async () => {
    let redirectHits = 0;
    const redirected = await endpoint((_request, response) => { redirectHits++; response.end(JSON.stringify(provider)); });
    for (const status of [302, 429, 500]) {
      const url = await endpoint((_request, response) => response.writeHead(status, {
        'content-type': 'application/json', location: redirected,
      }).end(JSON.stringify({ ...provider, message: 'PRIVATE_HTTP_ERROR' })));
      const proxy = await proxyFixture(url);
      await fixedFailure(lookupProxyRegion({ proxy: proxy.url, endpoint: url, timeoutMs: 1000 }));
    }
    expect(redirectHits).toBe(0);
  });

  it('bounds slow response headers by the total deadline', async () => {
    const url = await endpoint((_request, response) => later(() => response.end(JSON.stringify(provider)), 500));
    const proxy = await proxyFixture(url);
    const started = performance.now();
    await fixedFailure(lookupProxyRegion({ proxy: proxy.url, endpoint: url, timeoutMs: 100 }));
    expect(performance.now() - started).toBeLessThan(400);
  });

  it('keeps a single total deadline across headers and an active trickling body', async () => {
    const url = await endpoint((_request, response) => later(() => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"success":true,');
      for (let n = 1; n <= 10; n++) later(() => response.write(' '), n * 30);
      later(() => response.end('"ip":"203.0.113.17","country_code":"DE","timezone":{"id":"Europe/Berlin"}}'), 330);
    }, 70));
    const proxy = await proxyFixture(url);
    const started = performance.now();
    await fixedFailure(lookupProxyRegion({ proxy: proxy.url, endpoint: url, timeoutMs: 140 }));
    expect(performance.now() - started).toBeLessThan(320);
  });

  it('bounds a stalled CONNECT handshake and never reaches the target', async () => {
    let hits = 0;
    const url = await endpoint((_request, response) => { hits++; response.end(JSON.stringify(provider)); });
    const proxy = await proxyFixture(url, { stall: true });
    const started = performance.now();
    await fixedFailure(lookupProxyRegion({ proxy: proxy.url, endpoint: url, timeoutMs: 100 }));
    expect(performance.now() - started).toBeLessThan(400);
    expect(proxy.seen.length).toBeGreaterThan(0);
    expect(hits).toBe(0);
  });

  it('cancels during response consumption and sanitizes the caller abort reason', async () => {
    const controller = new AbortController();
    const url = await endpoint((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{');
      later(() => controller.abort(new Error('PRIVATE_ABORT_REASON')), 20);
    });
    const proxy = await proxyFixture(url);
    await fixedFailure(lookupProxyRegion({ proxy: proxy.url, endpoint: url, signal: controller.signal, timeoutMs: 1000 }));
  });

  it('fails closed for empty, invalid, rejected or unreachable proxies without direct fallback', async () => {
    let hits = 0;
    const url = await endpoint((_request, response) => { hits++; response.end(JSON.stringify(provider)); });
    const proxy = await proxyFixture(url, { reject: true });
    for (const value of ['', '   ', 'not a proxy PRIVATE_INPUT', 'http://PRIVATE_USER:PRIVATE_PASSWORD@127.0.0.1:1', proxy.url]) {
      await fixedFailure(lookupProxyRegion({ proxy: value, endpoint: url, timeoutMs: 100 }));
    }
    expect(hits).toBe(0);
  });

  it('rejects invalid endpoints/timeouts and pre-aborted requests before network activity', async () => {
    let hits = 0;
    const url = await endpoint((_request, response) => { hits++; response.end(JSON.stringify(provider)); });
    const proxy = await proxyFixture(url);
    const controller = new AbortController();
    controller.abort(new Error('PRIVATE_ABORT_REASON'));
    await fixedFailure(lookupProxyRegion({ proxy: proxy.url, endpoint: url, signal: controller.signal }));
    for (const value of ['file:///PRIVATE_PATH', 'http://PRIVATE_USER:PRIVATE_PASSWORD@localhost/', 'not a URL']) {
      await fixedFailure(lookupProxyRegion({ proxy: proxy.url, endpoint: value }));
    }
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await fixedFailure(lookupProxyRegion({ proxy: proxy.url, endpoint: url, timeoutMs }));
    }
    expect(hits).toBe(0);
    expect(proxy.seen).toHaveLength(0);
  });
});
