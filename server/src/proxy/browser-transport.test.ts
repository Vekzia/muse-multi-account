import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import http2 from 'node:http2';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { captureHello } from './fixtures/client-hello.js';
import type { AddressInfo, Socket } from 'node:net';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { WebSocketServer } from 'ws';
import * as transport from './browser-transport.js';

const defaults = { profile: 'chrome131', os: 'windows', headers: {} } as const;
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of disposers.splice(0).reverse()) await close(); });
async function serve(handler: http.RequestListener) {
  const sockets = new Set<Socket>();
  const server = http.createServer(handler);
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  disposers.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function bytes(body: Readable) { const chunks: Buffer[] = []; for await (const chunk of body) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); }

describe('browser TLS and HTTP2', () => {
  it('captures reproducible Chrome template invariants distinct from Node despite GREASE', async () => {
    const captures = [];
    for (const profile of ['chrome131', 'chrome142'] as const) {
      for (let n = 0; n < 2; n++) captures.push(await captureHello(port => transport.browserRequest({ ...defaults, profile, url: `https://localhost:${port}`, timeoutMs: 3000 })));
    }
    const native = await captureHello(port => new Promise<void>((resolve) => {
      const socket = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', ALPNProtocols: ['h2', 'http/1.1'] });
      socket.on('error', () => resolve()); socket.on('close', () => resolve());
    }));
    for (const hello of captures) {
      expect(hello.grease).toBe(true);
      expect(hello.alpn).toEqual(['h2', 'http/1.1']);
      expect(hello.ciphers.slice(0, 3)).toEqual([4865, 4866, 4867]);
      expect(hello.extensions).toContain(27); // certificate compression, absent in Node
      expect(hello.extensions).toContain(65037); // encrypted_client_hello GREASE payload
      expect(hello.ciphers).not.toEqual(native.ciphers);
      expect(hello.extensions).not.toEqual(native.extensions);
    }
    expect(captures[0]).toEqual(captures[1]);
    expect(captures[2]).toEqual(captures[3]);
  }, 15_000);

  it('verifies custom CA and hostname through SSL_CERT_FILE and negotiates HTTP2', async () => {
    const ca = fileURLToPath(new URL('./fixtures/transport-ca.pem', import.meta.url));
    const server = http2.createSecureServer({ key: readFileSync(new URL('./fixtures/transport-localhost-key.pem', import.meta.url)), cert: readFileSync(new URL('./fixtures/transport-localhost.pem', import.meta.url)) });
    server.on('session', session => session.on('error', () => undefined));
    server.on('stream', (stream, headers) => { stream.respond({ ':status': 200, 'x-protocol': String((stream.session!.socket as tls.TLSSocket).alpnProtocol), 'set-cookie': ['first=1', 'second=2'] }); stream.end(JSON.stringify({ cookie: headers.cookie })); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    disposers.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const original = process.env.SSL_CERT_FILE;
    try {
      process.env.SSL_CERT_FILE = ca;
      const response = await transport.browserRequest({ ...defaults, profile: 'chrome142', url: `https://localhost:${(server.address() as AddressInfo).port}`, headers: { cookie: 'external=yes' } });
      expect(response.headers['x-protocol']).toBe('h2');
      expect(response.headers['set-cookie']).toEqual(['first=1', 'second=2']);
      expect(JSON.parse((await bytes(response.body)).toString())).toEqual({ cookie: 'external=yes' });
      delete process.env.SSL_CERT_FILE;
      await expect(transport.browserRequest({ ...defaults, url: `https://localhost:${(server.address() as AddressInfo).port}` })).rejects.toThrow(/certificate|issuer/i);
    } finally { if (original === undefined) delete process.env.SSL_CERT_FILE; else process.env.SSL_CERT_FILE = original; }
  });
});

describe('browserWebSocket', () => {
  it('closes a pending handshake socket on timeout without direct fallback', async () => {
    let connected!: () => void;
    const arrived = new Promise<void>(resolve => { connected = resolve; });
    let disconnected!: () => void;
    const left = new Promise<void>(resolve => { disconnected = resolve; });
    const server = http.createServer();
    server.on('upgrade', (_req, socket) => { connected(); socket.on('close', disconnected); socket.on('end', () => socket.destroy()); });
    const sockets = new Set<Socket>();
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    disposers.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const pending = transport.browserWebSocket({ ...defaults, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, timeoutMs: 800 });
    const failure = expect(pending).rejects.toThrow(/timed out/i);
    await arrived;
    await failure;
    await left;
  });
  it('preserves early text/binary frames, protocols, Origin and external Cookie then closes socket', async () => {
    const url = await serve((_req, res) => res.end());
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1', handleProtocols: protocols => [...protocols][0]! });
    await once(server, 'listening');
    disposers.push(async () => { for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
    let requestHeaders: http.IncomingHttpHeaders = {};
    let peerClosed!: () => void;
    const closed = new Promise<void>(resolve => { peerClosed = resolve; });
    server.on('connection', (socket, request) => {
      requestHeaders = request.headers;
      socket.send('welcome'); socket.send(Buffer.from([0, 255, 4]));
      socket.on('message', (data, binary) => socket.send(data, { binary }));
      socket.on('close', peerClosed);
    });
    const connection = await transport.browserWebSocket({ ...defaults, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, headers: { cookie: 'external=only', origin: url }, protocols: ['muse'] });
    expect(connection.socket.protocol).toBe('muse');
    expect(requestHeaders.cookie).toBe('external=only');
    expect(requestHeaders.origin).toBe(url);
    const frames: Array<string | Buffer> = [];
    let done!: () => void;
    const received = new Promise<void>(resolve => { done = resolve; });
    connection.onMessage(event => { frames.push(event.data as string | Buffer); if (frames.length === 4) done(); });
    connection.socket.send('echo'); connection.socket.send(Buffer.from([7, 9]));
    await received;
    expect(frames).toEqual(['welcome', Buffer.from([0, 255, 4]), 'echo', Buffer.from([7, 9])]);
    await connection.close();
    await closed;
  });
});

describe('browser capacity and handshake cancellation', () => {
  it('ignores ambient proxy variables for direct accounts', async () => {
    const url = await serve((_req, res) => res.end('direct'));
    const names = ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy'];
    const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
    try {
      for (const name of names) process.env[name] = name.toLowerCase() === 'no_proxy' ? '' : 'http://127.0.0.1:1';
      const response = await transport.browserRequest({ ...defaults, url });
      expect((await bytes(response.body)).toString()).toBe('direct');
    } finally { for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } }
  });
  it('bounds active HTTP workers, rejects overload, and cancels queued requests', async () => {
    const url = await serve((_req, res) => { res.write('held'); });
    const controllers = Array.from({ length: 40 }, () => new AbortController());
    const requests = controllers.map(controller => transport.browserRequest({ ...defaults, url, timeoutMs: 10_000, signal: controller.signal }).catch(error => error));
    try {
      await expect(transport.browserRequest({ ...defaults, url, timeoutMs: 2000 })).rejects.toThrow(/capacity/i);
      controllers[20]!.abort(new Error('queued cancelled'));
      expect((await requests[20]).message).toBe('queued cancelled');
    } finally { for (const controller of controllers) controller.abort(); await Promise.all(requests); }
  }, 15_000);
});

describe('browserRequest', () => {
  it('routes explicit authenticated HTTP proxy traffic without leaking proxy credentials', async () => {
    let originHits = 0;
    const url = await serve((req, res) => { originHits++; expect(req.headers['proxy-authorization']).toBeUndefined(); res.end('via proxy'); });
    const credentials: Array<string | undefined> = [];
    const proxy = await serve((req, res) => {
      credentials.push(req.headers['proxy-authorization']);
      if (req.headers['proxy-authorization'] !== 'Basic dXNlcjpwYXNz') { res.writeHead(407); res.end(); return; }
      const headers = { ...req.headers }; delete headers['proxy-authorization'];
      const outgoing = http.request(req.url!, { method: req.method, headers }, incoming => { res.writeHead(incoming.statusCode!, incoming.headers); incoming.pipe(res); });
      outgoing.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(outgoing);
    });
    const response = await transport.browserRequest({ ...defaults, url, proxy: proxy.replace('://', '://user:pass@') });
    expect((await bytes(response.body)).toString()).toBe('via proxy');
    const rejected = await transport.browserRequest({ ...defaults, url, proxy: proxy.replace('://', '://user:wrong@') });
    await bytes(rejected.body);
    expect(rejected.statusCode).toBe(407);
    expect(credentials).toEqual(['Basic dXNlcjpwYXNz', 'Basic dXNlcjp3cm9uZw==']);
    expect(originHits).toBe(1);
  });
  it('returns redirects, raw gzip bytes and distinct Set-Cookie without sharing cookies', async () => {
    const compressed = gzipSync('unchanged compressed response');
    const seen: Array<string | undefined> = [];
    const url = await serve((req, res) => {
      seen.push(req.headers.cookie);
      res.writeHead(302, { location: '/next', 'set-cookie': ['one=1; Path=/', 'two=2; Expires=Wed, 21 Oct 2037 07:28:00 GMT'], 'content-encoding': 'gzip', 'content-length': compressed.length });
      res.end(compressed);
    });
    const first = await transport.browserRequest({ ...defaults, url, headers: { cookie: 'external=yes' } });
    expect(first.statusCode).toBe(302);
    expect(first.headers['set-cookie']).toEqual(['one=1; Path=/', 'two=2; Expires=Wed, 21 Oct 2037 07:28:00 GMT']);
    expect(first.headers['content-encoding']).toBe('gzip');
    expect(first.headers['content-length']).toBe(String(compressed.length));
    expect(await bytes(first.body)).toEqual(compressed);
    const second = await transport.browserRequest({ ...defaults, url });
    await bytes(second.body);
    expect(seen).toEqual(['external=yes', undefined]);
  });

  it('normalizes text stream chunks to bytes before upload and recalculates length', async () => {
    const url = await serve(async (req, res) => { res.setHeader('x-upload-length', req.headers['content-length']!); req.pipe(res); });
    const response = await transport.browserRequest({ ...defaults, url, method: 'POST', headers: { 'content-length': '1', 'transfer-encoding': 'chunked' }, body: Readable.from(['你好', Buffer.from([0, 255]), 'fin']) });
    expect(await bytes(response.body)).toEqual(Buffer.concat([Buffer.from('你好'), Buffer.from([0, 255]), Buffer.from('fin')]));
    expect(response.headers['x-upload-length']).toBe('11');
  });

  it('caps buffered uploads at 25 MiB and destroys a stalled upload on abort', async () => {
    const url = await serve((_req, res) => res.end('unexpected'));
    await expect(transport.browserRequest({ ...defaults, url, method: 'POST', body: Buffer.alloc(25 * 1024 * 1024 + 1) })).rejects.toThrow(/25 MiB/);
    const controller = new AbortController();
    const body = new Readable({ read() {} });
    const request = transport.browserRequest({ ...defaults, url, method: 'POST', body, signal: controller.signal });
    controller.abort(new Error('cancel upload'));
    await expect(request).rejects.toThrow('cancel upload');
    expect(body.destroyed).toBe(true);
  });

  it('keeps active streams beyond the timeout but times out an idle response', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: 0\n\n');
      let n = 0;
      const timer = setInterval(() => { res.write(`data: ${++n}\n\n`); if (n === 6) { clearInterval(timer); res.end(); } }, 200);
      res.on('close', () => clearInterval(timer));
    });
    const response = await transport.browserRequest({ ...defaults, url, timeoutMs: 800 });
    expect((await bytes(response.body)).toString()).toContain('data: 6');
    const idleUrl = await serve((_req, res) => { res.writeHead(200); res.write('first'); });
    const idle = await transport.browserRequest({ ...defaults, url: idleUrl, timeoutMs: 800 });
    await expect(bytes(idle.body)).rejects.toThrow(/timed out/i);
  });

  it('closes the upstream stream on downstream destroy and abort after headers', async () => {
    let notifyClose!: () => void;
    let closed = new Promise<void>(resolve => { notifyClose = resolve; });
    const url = await serve((_req, res) => { res.writeHead(200); res.write('first'); res.on('close', () => notifyClose()); });
    const response = await transport.browserRequest({ ...defaults, url });
    response.body.destroy();
    await closed;
    closed = new Promise<void>(resolve => { notifyClose = resolve; });
    const controller = new AbortController();
    const second = await transport.browserRequest({ ...defaults, url, signal: controller.signal });
    const error = once(second.body, 'error');
    controller.abort(new Error('caller disconnected'));
    expect((await error)[0].message).toBe('caller disconnected');
    await closed;
  });

  it('times out pending headers and rejects a malformed proxy without direct fallback', async () => {
    let hits = 0;
    const url = await serve(() => { hits++; });
    await expect(transport.browserRequest({ ...defaults, url, proxy: 'http://secret:pass@bad:port' })).rejects.toThrow('Invalid proxy URL');
    expect(hits).toBe(0);
    await expect(transport.browserRequest({ ...defaults, url, timeoutMs: 100 })).rejects.toThrow(/timed out/i);
  });
});
