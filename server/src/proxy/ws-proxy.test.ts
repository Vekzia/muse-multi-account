import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { CookieJar } from 'tough-cookie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeFingerprint } from '../fingerprint/profile.js';
import * as browserTransport from './browser-transport.js';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import { createReverseProxy, type ReverseProxyDeps, type ProxyContext } from './reverse-proxy.js';

const servers: Server[] = [];
const sockets: WebSocket[] = [];
const tunnels: Socket[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) { socket.on('error', () => undefined); socket.terminate(); }
  for (const tunnel of tunnels.splice(0)) tunnel.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })));
});
function buffer(data: RawData): Buffer { return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer); }
async function bind(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture bind failed');
  return `http://127.0.0.1:${address.port}`;
}
async function fixture(onConnection: (socket: WebSocket, request: IncomingMessage) => void): Promise<string> {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on('headers', (headers) => headers.push('Set-Cookie: wsSession=from-upstream; Path=/'));
  wss.on('connection', (socket, request) => { sockets.push(socket); onConnection(socket, request); });
  return bind(server);
}
async function gateway(origin: string, overrides: Partial<ReverseProxyDeps> = {}, context?: ProxyContext): Promise<string> {
  const jar = new CookieJar();
  await jar.setCookie('session=account-jar; Path=/', origin);
  const proxy = createReverseProxy({ accessToken: 'private-token', upstreamOrigin: origin,
    getAccount: (id) => id === 3 ? { id, proxy: null } : undefined, getCookieJar: async () => jar, ...overrides });
  const server = createServer();
  server.on('upgrade', (request, socket, head) => { void proxy.upgrade(socket, request, head, context); });
  return bind(server);
}
function client(url: string, token = 'private-token', protocols?: string[]): WebSocket {
  const result = new WebSocket(url.replace(/^http:/, 'ws:'), protocols ?? [], { headers: { authorization: `Bearer ${token}`, cookie: 'browser=PRIVATE', origin: 'http://gateway.test' } });
  sockets.push(result); result.on('error', () => undefined); return result;
}

describe('browser WebSocket bridge', () => {
  it.each(['chrome131', 'chrome142'] as const)('uses %s for early frames, account cookies, subprotocol and text/binary echo', async (profile) => {
    const selected = vi.spyOn(browserTransport, 'browserWebSocket'); // Call through to real wreq/local WS.
    let observed: IncomingMessage | undefined;
    let peer: WebSocket | undefined;
    const origin = await fixture((socket, request) => {
      observed = request; peer = socket;
      socket.send('welcome'); socket.send(Buffer.from([0, 255, 4]));
      socket.on('message', (data, binary) => socket.send(data, { binary }));
    });
    const jar = new CookieJar();
    await jar.setCookie('session=account-jar; Path=/', origin);
    let saves = 0;
    const local = await gateway(origin, { getCookieJar: async () => jar, saveCookieJar: async () => { saves++; },
      getAccount: id => ({ id, proxy: null, fp: normalizeFingerprint({ enabled: true, uaMode: 'windows', tlsProfile: profile }, id) }) });
    const connection = client(`${local}/muse/3/socket`, 'private-token', ['chat']);
    const frames: Array<[Buffer, boolean]> = [];
    const received = new Promise<void>(resolve => connection.on('message', (data, binary) => {
      frames.push([buffer(data), binary]); if (frames.length === 4) resolve();
    }));
    await once(connection, 'open');
    connection.send('echo'); connection.send(Buffer.from([7, 9]));
    await received;
    expect(frames).toEqual([[Buffer.from('welcome'), false], [Buffer.from([0, 255, 4]), true], [Buffer.from('echo'), false], [Buffer.from([7, 9]), true]]);
    expect(observed?.headers.cookie).toBe('session=account-jar');
    expect(observed?.headers.authorization).toBeUndefined();
    expect(observed?.headers.origin).toBe(origin);
    expect(connection.protocol).toBe('chat');
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({ profile, os: 'windows', url: origin.replace('http:', 'ws:') + '/socket' }));
    // wreq has no raw 101 headers: browser-mode cookie refresh is HTTP-only.
    expect(await jar.getCookieString(origin)).toBe('session=account-jar');
    expect(saves).toBe(0);
    const closed = once(connection, 'close'); peer!.close(4001, 'upstream done');
    expect(await closed).toEqual([4001, Buffer.from('upstream done')]);
  });

  it('relays client close code and reason to the browser upstream', async () => {
    let peer!: WebSocket;
    const origin = await fixture(socket => { peer = socket; });
    const local = await gateway(origin, { getAccount: id => ({ id, fp: normalizeFingerprint({ enabled: true, tlsProfile: 'chrome131' }, id) }) });
    const connection = client(`${local}/muse/3/socket`);
    await once(connection, 'open');
    const closed = once(peer, 'close');
    connection.close(4002, 'client done');
    expect(await closed).toEqual([4002, Buffer.from('client done')]);
  });

  it('closes the downstream when the browser upstream drops without a close frame', async () => {
    let peer!: WebSocket;
    const origin = await fixture(socket => { peer = socket; });
    const local = await gateway(origin, { getAccount: id => ({ id, fp: normalizeFingerprint({ enabled: true, tlsProfile: 'chrome131' }, id) }) });
    const connection = client(`${local}/muse/3/socket`);
    await once(connection, 'open');
    const closed = once(connection, 'close'); peer.terminate();
    expect((await closed)[0]).toBe(1011);
  });

  it('returns 502 without Node retry when a browser upgrade is rejected', async () => {
    let hits = 0;
    const origin = await bind(createServer((_request, response) => { hits++; response.writeHead(403).end(); }));
    const selected = vi.spyOn(browserTransport, 'browserWebSocket');
    const local = await gateway(origin, { getAccount: id => ({ id, fp: normalizeFingerprint({ enabled: true, tlsProfile: 'chrome142' }, id) }) });
    const connection = client(`${local}/muse/3/socket`);
    const status = await new Promise<number>(resolve => connection.once('unexpected-response', (_request, response) => {
      resolve(response.statusCode!); response.destroy(); connection.terminate();
    }));
    expect(status).toBe(502); expect(hits).toBe(1); expect(selected).toHaveBeenCalledOnce();
  });

  it('aborts a pending browser handshake when the downstream disconnects', async () => {
    let arrived!: () => void;
    let peerClosed!: () => void;
    const started = new Promise<void>(resolve => { arrived = resolve; });
    const closed = new Promise<void>(resolve => { peerClosed = resolve; });
    const upstream = createServer();
    upstream.on('upgrade', (_request, socket) => {
      tunnels.push(socket as Socket); socket.on('close', peerClosed); socket.on('end', () => socket.destroy()); arrived();
    });
    const origin = await bind(upstream);
    const selected = vi.spyOn(browserTransport, 'browserWebSocket');
    const local = await gateway(origin, { timeoutMs: 30_000,
      getAccount: id => ({ id, fp: normalizeFingerprint({ enabled: true, tlsProfile: 'chrome131' }, id) }) });
    const connection = client(`${local}/muse/3/socket`);
    await started;
    connection.terminate();
    await closed;
    expect(selected.mock.calls[0]![0].signal?.aborted).toBe(true);
  });

  it('cleans up an already-open browser upstream when the client upgrade is invalid', async () => {
    let peerClosed!: () => void;
    const closed = new Promise<void>(resolve => { peerClosed = resolve; });
    const origin = await fixture(socket => { socket.on('close', peerClosed); });
    const local = new URL(await gateway(origin, {
      getAccount: id => ({ id, fp: normalizeFingerprint({ enabled: true, tlsProfile: 'chrome131' }, id) }) }));
    const connection = connect(Number(local.port), local.hostname);
    tunnels.push(connection);
    connection.write('GET /muse/3/socket HTTP/1.1\r\nHost: gateway.test\r\nAuthorization: Bearer private-token\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 12\r\n\r\n');
    expect((await once(connection, 'data'))[0].toString()).toContain('HTTP/1.1 400');
    await closed;
  });

  it('limits downstream browser messages to 16 MiB', async () => {
    let forwarded = false;
    const origin = await fixture(socket => socket.on('message', () => { forwarded = true; }));
    const local = await gateway(origin, { getAccount: id => ({ id, fp: normalizeFingerprint({ enabled: true, tlsProfile: 'chrome131' }, id) }) });
    const connection = client(`${local}/muse/3/socket`);
    await once(connection, 'open');
    const closed = once(connection, 'close'); connection.send(Buffer.alloc(16 * 1024 * 1024 + 1));
    expect((await closed)[0]).toBe(1009);
    expect(forwarded).toBe(false);
  });

  it.each([{ enabled: false, tlsProfile: 'chrome142' }, { enabled: true, tlsProfile: 'native' }] as const)('keeps native WS when profile is $tlsProfile and enabled=$enabled', async (fp) => {
    const selected = vi.spyOn(browserTransport, 'browserWebSocket');
    const origin = await fixture(socket => socket.send('native welcome'));
    const jar = new CookieJar();
    const local = await gateway(origin, { getCookieJar: () => jar, getAccount: id => ({ id, fp: normalizeFingerprint(fp, id) }) });
    const connection = client(`${local}/muse/3/socket`);
    expect(buffer((await once(connection, 'message'))[0]).toString()).toBe('native welcome');
    expect(await jar.getCookieString(origin)).toContain('wsSession=from-upstream');
    expect(selected).not.toHaveBeenCalled();
  });
});

describe('WebSocket bridge fixtures', () => {
  it('relays text/binary, subprotocol, ping and close through a separate proxy listener', async () => {
    let observed: IncomingMessage | undefined;
    let upstreamSocket: WebSocket | undefined;
    const origin = await fixture((socket, request) => {
      observed = request; upstreamSocket = socket;
      socket.on('message', (data, binary) => socket.send(data, { binary }));
    });
    const jar = new CookieJar();
    await jar.setCookie('session=account-jar; Path=/', origin);
    let saves = 0;
    const local = await gateway(origin, { getCookieJar: async () => jar, saveCookieJar: async () => { saves++; } });
    const connection = client(`${local}/muse/3/socket?room=1`, 'private-token', ['chat']);
    await once(connection, 'open');
    expect(observed?.url).toBe('/socket?room=1');
    expect(observed?.headers.cookie).toBe('session=account-jar');
    expect(observed?.headers.authorization).toBeUndefined();
    expect(observed?.headers.origin).toBe(origin);
    expect(connection.protocol).toBe('chat');
    expect(await jar.getCookieString(origin)).toContain('wsSession=from-upstream');
    expect(saves).toBe(1);
    const textMessage = once(connection, 'message');
    connection.send('hello');
    const [text, textBinary] = await textMessage;
    expect(buffer(text).toString()).toBe('hello'); expect(textBinary).toBe(false);
    const binaryMessage = once(connection, 'message');
    connection.send(Buffer.from([0, 255, 1]));
    const [data, binary] = await binaryMessage;
    expect(buffer(data)).toEqual(Buffer.from([0, 255, 1])); expect(binary).toBe(true);
    const ping = once(upstreamSocket!, 'ping');
    connection.ping('probe');
    expect((await ping)[0].toString()).toBe('probe');
    const close = once(connection, 'close');
    upstreamSocket!.close(1000, 'finished');
    const [code, reason] = await close;
    expect(code).toBe(1000); expect(reason.toString()).toBe('finished');
  });

  it('returns HTTP 401/404 before opening upstream connections', async () => {
    let connections = 0;
    const origin = await fixture(() => { connections++; });
    const local = await gateway(origin);
    for (const [path, token, expected] of [['/muse/3/x', 'wrong', 401], ['/muse/99/x', 'private-token', 404]] as const) {
      const connection = client(`${local}${path}`, token);
      const status = await new Promise<number>((resolve) => connection.once('unexpected-response', (_request, response) => { resolve(response.statusCode!); response.destroy(); connection.terminate(); }));
      expect(status).toBe(expected);
    }
    expect(connections).toBe(0);
  });

  it('returns 502 for a failed upstream upgrade without hanging downstream', async () => {
    const origin = await bind(createServer((_req, response) => response.writeHead(403).end('PRIVATE')));
    const local = await gateway(origin);
    const connection = client(`${local}/muse/3/x`);
    const status = await new Promise<number>((resolve) => connection.once('unexpected-response', (_request, response) => { resolve(response.statusCode!); response.destroy(); connection.terminate(); }));
    expect(status).toBe(502);
  });

  it('bounds a stalled account CONNECT proxy by its handshake deadline', async () => {
    const tunnelServer = createServer();
    tunnelServer.on('connect', (_request, downstream) => { tunnels.push(downstream as Socket); });
    const proxyUrl = await bind(tunnelServer);
    const local = await gateway('http://127.0.0.1:1', { timeoutMs: 50, getAccount: (id) => ({ id, proxy: proxyUrl }) });
    const connection = client(`${local}/muse/3/socket`);
    const start = Date.now();
    const status = await new Promise<number>((resolve) => connection.once('unexpected-response', (_request, response) => { resolve(response.statusCode!); response.destroy(); connection.terminate(); }));
    expect(status).toBe(502);
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it('uses the account HTTP CONNECT proxy and supports root gateway context', async () => {
    let connects = 0;
    let observedPath = '';
    const origin = await fixture((socket, request) => { observedPath = request.url!; socket.on('message', (data, binary) => socket.send(data, { binary })); });
    const tunnelServer = createServer();
    tunnelServer.on('connect', (request, downstream, head) => {
      connects++;
      expect(request.url).toBe(new URL(origin).host);
      const target = new URL(origin);
      const upstream = connect(Number(target.port), target.hostname, () => {
        downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        downstream.pipe(upstream); upstream.pipe(downstream);
      });
      tunnels.push(upstream, downstream as Socket);
      upstream.on('error', () => downstream.destroy());
    });
    const proxyUrl = await bind(tunnelServer);
    const local = await gateway(origin, { getAccount: (id) => ({ id, proxy: proxyUrl }), authorize: (_req, id) => id === 3 }, { accountId: 3, localBase: '' });
    const connection = client(`${local}/root/socket`);
    await once(connection, 'open');
    const message = once(connection, 'message'); connection.send('via proxy');
    expect(buffer((await message)[0]).toString()).toBe('via proxy');
    expect(observedPath).toBe('/root/socket'); expect(connects).toBe(1);
    const close = once(connection, 'close'); connection.close(); await close;
  });
});
