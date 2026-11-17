import { createServer, get, type RequestListener, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { gzipSync, brotliCompressSync, deflateSync } from 'node:zlib';
import Fastify, { type FastifyInstance } from 'fastify';
import { CookieJar } from 'tough-cookie';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountCookieJar } from './cookie-jar.js';
import { createReverseProxy, type ReverseProxyDeps, type ProxyContext } from './reverse-proxy.js';
import { isAllowedUpstream, requestUpstream } from './upstream.js';
import { Readable } from 'node:stream';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  cleanups.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture bind failed');
  return `http://127.0.0.1:${address.port}`;
}
async function appFor(origin: string, options: Partial<ReverseProxyDeps> = {}, context?: ProxyContext): Promise<FastifyInstance> {
  const jars = new Map([[1, new CookieJar()], [2, new CookieJar()]]);
  const proxy = createReverseProxy({ accessToken: 'private-token', upstreamOrigin: origin,
    getAccount: (id) => jars.has(id) ? { id, proxy: null } : undefined,
    getCookieJar: async (id) => jars.get(id)!, ...options,
  });
  const app = Fastify();
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  app.all('/*', (request, reply) => proxy.handle(request, reply, context));
  cleanups.push(() => app.close());
  await app.ready();
  return app;
}
const auth = { authorization: 'Bearer private-token' };

describe('HTTP proxy fixtures', () => {
  it.each([false, true])('cancels browser transport when the client disconnects before streaming (buffering=%s)', async buffering => {
    let started!: () => void, closed!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const ended = new Promise<void>(resolve => { closed = resolve; });
    const origin = await fixture((_req, res) => { res.once('close', closed); if (buffering) { res.writeHead(200, { 'content-type': 'text/html' }); res.write('<head>'); } started(); });
    const app = await appFor(origin, { timeoutMs: 30_000, getAccount: id => ({ id, fp: { enabled:true,tlsProfile:'chrome131',uaMode:'windows',uaCustom:'',timezone:'',locale:'',noise:false,webrtc:false,webdriver:false } }) });
    await app.listen({ host:'127.0.0.1', port:0 });
    const request = get(`http://127.0.0.1:${(app.server.address() as {port:number}).port}/muse/1/`, { headers: auth });
    request.on('error', () => undefined);
    await began; request.destroy();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([ended, new Promise<never>((_resolve,reject) => { timer=setTimeout(()=>reject(new Error('Upstream was not cancelled')),1500); })]); }
    finally { if (timer) clearTimeout(timer); }
  });
  it.each([
    ['text/html; charset=windows-1252', undefined, 'plain', 128],
    ['text/html', undefined, '<html>' + 'x'.repeat(300) + '</html>', 128],
    ['text/html', 'unsupported', 'encoded', 128],
  ])('reports unsupported fingerprint HTML instead of silently sending a native page: %s/%s', async (type, encoding, body, limit) => {
    const origin = await fixture((_req, res) => { res.setHeader('Content-Type', type!); if (encoding) res.setHeader('Content-Encoding', encoding); res.end(body); });
    const app = await appFor(origin, { maxRewriteBytes: Number(limit), getAccount: id => ({ id, fp: { enabled: true, seed: 12, uaMode: 'windows', uaCustom: '', timezone:'',locale:'',webdriver:false,noise:false,webrtc:false } }) }, {accountId:1,localOrigin:'http://gateway.test',localBase:''});
    const result = await app.inject({url:'/',headers:auth});
    expect(result.statusCode).toBe(502); expect(result.body).toContain('指纹'); expect(result.headers['cache-control']).toContain('no-store');
  });
  it('removes conditional document validators when fingerprint configuration is enabled', async () => {
    let observed: import('node:http').IncomingHttpHeaders = {};
    const origin = await fixture((req, res) => { observed=req.headers; res.setHeader('Content-Type','text/html'); res.end('<head></head>'); });
    const app = await appFor(origin, {getAccount:id=>({id,fp:{enabled:true,seed:22,uaMode:'windows',uaCustom:'',timezone:'',locale:'',webdriver:false,noise:false,webrtc:false}})}, {accountId:1,localOrigin:'http://gateway.test',localBase:''});
    const result=await app.inject({url:'/',headers:{...auth,'if-none-match':'old','if-modified-since':'yesterday'}});
    expect(observed['if-none-match']).toBeUndefined(); expect(observed['if-modified-since']).toBeUndefined();
    expect(result.statusCode).toBe(200);expect(result.body).toContain('data-muse-fingerprint');
  });
  it('routes configured API aliases through the account jar and preserves the page Origin', async () => {
    const primary = await fixture((_req,res) => { res.end('primary'); });
    let receivedOrigin = '', receivedCookie = '', receivedPath = '';
    const api = await fixture((req,res) => {
      receivedOrigin=req.headers.origin ?? ''; receivedCookie=req.headers.cookie ?? ''; receivedPath=req.url ?? '';
      res.writeHead(200, {'Content-Type':'application/json','Set-Cookie':'api_session=kept; Path=/'});
      res.end(JSON.stringify({ next: `${primary}/home`, api: 'https://api.muse.ai/check' }));
    });
    const jar=new CookieJar(); await jar.setCookie('api_session=old; Path=/',api);
    const app=await appFor(primary,{additionalOrigins:{api},getCookieJar:async()=>jar});
    const result=await app.inject({url:'/muse/1/__muse/origin/api/echo?return=https://muse.ai/home',headers:{...auth,origin:'http://gateway.test',cookie:'browser-secret=wrong'}});
    expect(result.statusCode).toBe(200); expect(receivedOrigin).toBe(primary);
    expect(receivedCookie).toContain('api_session=old'); expect(receivedCookie).not.toContain('browser-secret');
    expect(receivedPath).toBe('/echo?return=https://muse.ai/home');
    expect(await jar.getCookieString(api)).toContain('api_session=kept');
    expect((await app.inject({url:'/muse/1/__muse/origin/unknown/echo',headers:auth})).statusCode).toBe(404);
  });
  it('sends a readable request body through to the configured origin', async () => {
    let received = '';
    const origin = await fixture((request, response) => { const chunks: Buffer[] = []; request.on('data', (chunk) => chunks.push(chunk)); request.on('end', () => { received = Buffer.concat(chunks).toString(); response.end('ok'); }); });
    const response = await requestUpstream({ origin, path: '/stream', method: 'POST', body: Readable.from(['stream-', 'body']), headers: { 'content-type': 'text/plain' } });
    expect(received).toBe('stream-body');
    const chunks: Buffer[] = []; for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('ok');
  });

  it('maps path/query, persists Set-Cookie per account and removes client credentials/hop headers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'task4-jars-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const jars = new AccountCookieJar(directory);
    let observed: { url: string | undefined; cookie: string | undefined; authorization: string | undefined; private: string | undefined } = { url: undefined, cookie: undefined, authorization: undefined, private: undefined };
    const origin = await fixture((request, response) => {
      observed = { url: request.url, cookie: request.headers.cookie, authorization: request.headers.authorization,
        private: request.headers['x-private'] as string | undefined };
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': ['session=server; Path=/', 'section=yes; Path=/private'],
        connection: 'close, x-secret', 'x-secret': 'hidden', 'content-security-policy': "default-src 'none'", 'x-frame-options': 'DENY' });
      response.end('<a href="https://muse.ai/dashboard">dashboard</a>');
    });
    await (await jars.get(1)).setCookie('session=account-one; Path=/', origin);
    const app = await appFor(origin, { getCookieJar: (id) => jars.get(id), saveCookieJar: (id, jar) => jars.save(id, jar as CookieJar) });
    const result = await app.inject({ url: '/muse/1/dashboard?tab=1', headers: { ...auth, cookie: 'browser=wrong', connection: 'x-private', 'x-private': 'hidden' } });
    expect(observed).toEqual({ url: '/dashboard?tab=1', cookie: 'session=account-one', authorization: undefined, private: undefined });
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('<a href="/muse/1/dashboard">dashboard</a>');
    for (const name of ['set-cookie', 'x-secret', 'content-security-policy', 'x-frame-options']) expect(result.headers[name]).toBeUndefined();
    expect(await (await new AccountCookieJar(directory).get(1)).getCookieString(origin)).toBe('session=server');
    expect(await (await jars.get(2)).getCookieString(origin)).toBe('');
  });

  it.each(['gzip', 'deflate', 'br'])('rewrites %s text with consistent bytes and length', async (encoding) => {
    const text = '<script src="https://muse.ai/app.js"></script>';
    const compressed = ({ gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync })[encoding]!(Buffer.from(text));
    const origin = await fixture((_req, res) => { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': encoding, 'content-length': compressed.length, etag: 'old' }); res.end(compressed); });
    const app = await appFor(origin);
    const result = await app.inject({ url: '/muse/1/', headers: auth });
    expect(result.body).toBe('<script src="/muse/1/app.js"></script>');
    expect(result.headers['content-encoding']).toBeUndefined();
    expect(result.headers.etag).toBeUndefined();
    expect(Number(result.headers['content-length'])).toBe(result.rawPayload.length);
  });

  it.each([
    ['image/png', 'gzip'], ['text/html; charset=shift_jis', 'identity'], ['text/html', 'zstd'],
  ])('preserves unsupported bytes %s / %s', async (type, encoding) => {
    const bytes = Buffer.from([0, 255, 1, 2, 3, 0]);
    const origin = await fixture((_req, res) => { res.writeHead(200, { 'content-type': type, 'content-encoding': encoding, 'content-length': bytes.length }); res.end(bytes); });
    const app = await appFor(origin);
    const result = await app.inject({ url: '/muse/1/file', headers: auth });
    expect(result.statusCode).toBe(200);
    expect(result.rawPayload).toEqual(bytes);
    expect(result.headers['content-encoding']).toBe(encoding);
  });

  it('passes a binary POST body intact and rewrites a redirect without following it', async () => {
    let received = Buffer.alloc(0);
    const origin = await fixture((req, res) => { const chunks: Buffer[] = []; req.on('data', (chunk) => chunks.push(chunk)); req.on('end', () => { received = Buffer.concat(chunks); res.writeHead(302, { location: '/next' }); res.end(); }); });
    const app = await appFor(origin);
    const bytes = Buffer.from([0, 255, 100, 1]);
    const result = await app.inject({ method: 'POST', url: '/muse/1/upload', payload: bytes, headers: { ...auth, 'content-type': 'application/octet-stream' } });
    expect(received).toEqual(bytes);
    expect(result.statusCode).toBe(302);
    expect(result.headers.location).toBe('/muse/1/next');
  });

  it('supports gateway root context and authorizer', async () => {
    const origin = await fixture((req, res) => { res.setHeader('content-type', 'text/html'); res.end(`<a href="https://muse.ai${req.url}">go</a>`); });
    const app = await appFor(origin, { authorize: (request, id) => id === 2 && request.headers.cookie === 'account=session' }, { accountId: 2, localBase: '', localOrigin: 'http://localhost:9002' });
    const result = await app.inject({ url: '/root?q=1', headers: { cookie: 'account=session' } });
    expect(result.statusCode).toBe(200);
    expect(result.body).toContain('<a href="http://localhost:9002/root?q=1">go</a>');
    expect(result.body).toContain('data-muse-gateway');
  });

  it('streams SSE before upstream completes and closes source on client disconnect', async () => {
    let closedResolve!: () => void;
    const closed = new Promise<void>((resolve) => { closedResolve = resolve; });
    const origin = await fixture((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: first\n\n'); res.once('close', closedResolve); });
    const app = await appFor(origin);
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve, reject) => {
      const request = get(`${url}/muse/1/events`, { headers: auth }, (response) => {
        response.once('data', (chunk) => { expect(chunk.toString()).toBe('data: first\n\n'); response.destroy(); resolve(); });
      });
      request.once('error', reject);
    });
    await closed;
  });

  it('falls back to original bytes when text exceeds rewrite limit', async () => {
    const text = '"https://muse.ai/x"'.repeat(20);
    const origin = await fixture((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(text); });
    const app = await appFor(origin, { maxRewriteBytes: 20 });
    const result = await app.inject({ url: '/muse/1/large', headers: auth });
    expect(result.body).toBe(text);
  });

  it('rejects credentials, missing accounts, ambiguous routes and arbitrary origins', async () => {
    const app = await appFor('http://127.0.0.1:1');
    expect((await app.inject('/muse/1/x')).statusCode).toBe(401);
    expect((await app.inject({ url: '/muse/99/x', headers: auth })).statusCode).toBe(404);
    for (const url of ['/muse/1/https://evil.test/x', '/muse/1//evil.test/x', '/muse/1/\\evil.test']) {
      expect((await app.inject({ url, headers: auth })).statusCode).toBe(400);
    }
    expect(isAllowedUpstream('http://evil.test/', 'https://muse.ai')).toBe(false);
    expect(isAllowedUpstream('https://private@muse.ai/', 'https://muse.ai')).toBe(false);
    expect(isAllowedUpstream('https://muse.ai:444/', 'https://muse.ai')).toBe(false);
    expect(isAllowedUpstream('https://muse.ai/a', 'https://muse.ai')).toBe(true);
  });

  it('retains the upstream Referer path and never rewrites partial response ranges', async () => {
    let referer = '';
    const body = '"https://muse.ai/range"';
    const origin = await fixture((request, response) => {
      referer = request.headers.referer ?? '';
      response.writeHead(206, { 'content-type': 'application/javascript', 'content-range': 'bytes 0-22/100' });
      response.end(body);
    });
    const app = await appFor(origin, {}, { accountId: 1, localBase: '' });
    const result = await app.inject({ url: '/part.js', headers: { ...auth, referer: 'http://gateway.test/folder/page?q=1' } });
    expect(referer).toBe(`${origin}/folder/page?q=1`);
    expect(result.statusCode).toBe(206);
    expect(result.body).toBe(body);
    expect(result.headers['content-range']).toBe('bytes 0-22/100');
  });

  it('uses an authenticated account HTTP CONNECT proxy for HTTP requests', async () => {
    const origin = await fixture((_request, response) => { response.setHeader('content-type', 'application/json'); response.end('{"proxied":true}'); });
    const server = createServer();
    const connections: import('node:stream').Duplex[] = [];
    let connectAuthorization = '';
    server.on('connect', (request, downstream, head) => {
      connectAuthorization = request.headers['proxy-authorization'] ?? '';
      const target = new URL(origin);
      const upstream = connect(Number(target.port), target.hostname, () => {
        downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        downstream.pipe(upstream); upstream.pipe(downstream);
      });
      upstream.on('error', () => downstream.destroy());
      connections.push(upstream, downstream);
    });
    cleanups.push(() => new Promise<void>((resolve) => { connections.forEach((socket) => socket.destroy()); server.close(() => resolve()); }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as import('node:net').AddressInfo;
    const app = await appFor(origin, { getAccount: (id) => ({ id, proxy: `http://user:pass@127.0.0.1:${address.port}` }) });
    const result = await app.inject({ url: '/muse/1/api', headers: auth });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ proxied: true });
    expect(connectAuthorization).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`);
  });

  it('bounds a stalled HTTP CONNECT proxy with a hard header deadline', async () => {
    const server = createServer();
    const connections: import('node:stream').Duplex[] = [];
    server.on('connect', (_request, socket) => { connections.push(socket); });
    cleanups.push(() => new Promise<void>((resolve) => { connections.forEach((socket) => socket.destroy()); server.close(() => resolve()); }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as import('node:net').AddressInfo;
    const app = await appFor('http://127.0.0.1:1', { timeoutMs: 50, getAccount: (id) => ({ id, proxy: `http://127.0.0.1:${address.port}` }) });
    const started = Date.now();
    const result = await app.inject({ url: '/muse/1/', headers: auth });
    expect(result.statusCode).toBe(502);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('returns sanitized 502 for upstream and cookie persistence failures', async () => {
    const app = await appFor('http://127.0.0.1:1');
    const result = await app.inject({ url: '/muse/1/x', headers: auth });
    expect(result.statusCode).toBe(502); expect(result.body).toBe('Upstream request failed');
    const origin = await fixture((_req, res) => { res.setHeader('set-cookie', 'session=PRIVATE'); res.end('private'); });
    const failedSave = await appFor(origin, { saveCookieJar: async () => { throw new Error('PRIVATE'); } });
    expect((await failedSave.inject({ url: '/muse/1/', headers: auth })).statusCode).toBe(502);
  });
});
