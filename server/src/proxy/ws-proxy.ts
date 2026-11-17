import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { isAllowedUpstream, createNodeProxyAgent, persistSetCookies, upstreamHeaders } from './upstream.js';
import { authorizeProxy, resolveProxyRoute, type ProxyContext, type ReverseProxyDeps } from './reverse-proxy.js';
import { resolveUpstreamOrigin } from './origin-map.js';
import { fingerprintHeaders } from '../fingerprint/profile.js';
import { browserWebSocket, type BrowserWebSocketConnection } from './browser-transport.js';

export type WebSocketProxyDeps = Omit<ReverseProxyDeps, 'getCookieJar'> & Pick<Partial<ReverseProxyDeps>, 'getCookieJar'>;
export interface WebSocketValidation { ok: boolean; statusCode?: number; accountId?: number; upstreamPath?: string; }
export interface WebSocketProxy {
  validate(path: string | undefined, headers: IncomingMessage['headers']): Promise<WebSocketValidation>;
  upgrade(socket: Duplex, request: IncomingMessage, head?: Buffer, context?: ProxyContext): Promise<void>;
}
function rejectUpgrade(socket: Duplex, status: number): void {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
function relayClose(target: WebSocket, code: number, reason: Buffer): void {
  if (target.readyState === WebSocket.CONNECTING) { target.terminate(); return; }
  if (target.readyState !== WebSocket.OPEN) return;
  if (code === 1005 || code === 1006 || code === 1015) target.close(1011); else target.close(code, reason);
}

const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
function bridgeBrowser(connection: BrowserWebSocketConnection, request: IncomingMessage, socket: Duplex, head: Buffer, cleanup: () => void): void {
  const remote = connection.socket;
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_MESSAGE_BYTES,
    handleProtocols: () => remote.protocol || false });
  if (remote.readyState !== WebSocket.OPEN) throw new Error('Upstream closed before upgrade');
  let accepted = false;
  wss.handleUpgrade(request, socket, head, (client) => {
    accepted = true;
    let unsubscribe = () => {};
    const finish = () => { unsubscribe(); cleanup(); wss.close(); };
    const fail = () => { if (client.readyState === WebSocket.OPEN) client.close(1011); finish(); };
    const close = (code: number) => { client.close(code); remote.close(code); };
    const writable = (destination: { readyState: number; bufferedAmount: number }, size: number) => {
      if (size > MAX_MESSAGE_BYTES) { close(1009); return false; }
      if (destination.bufferedAmount + size > MAX_MESSAGE_BYTES) { close(1013); return false; }
      return destination.readyState === WebSocket.OPEN;
    };
    client.on('message', (data, binary) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      if (!writable(remote, bytes.length)) return;
      try { remote.send(binary ? bytes : bytes.toString()); } catch { fail(); }
    });
    remote.addEventListener('close', (event) => { relayClose(client, event.code, Buffer.from(event.reason)); finish(); });
    remote.addEventListener('error', fail);
    client.on('error', fail);
    client.once('close', (code, reason) => {
      if (remote.readyState === WebSocket.OPEN) remote.close(code === 1005 || code === 1006 || code === 1015 ? 1011 : code, reason.toString());
      finish();
    });
    // Serial conversion also preserves Blob frame order, although wreq uses nodebuffer.
    let pending = Promise.resolve();
    let queuedBytes = 0;
    unsubscribe = connection.onMessage(({ data }) => {
      const size = typeof data === 'string' ? Buffer.byteLength(data) : data instanceof Blob ? data.size : data.byteLength;
      queuedBytes += size;
      if (size > MAX_MESSAGE_BYTES || queuedBytes > MAX_MESSAGE_BYTES) { close(size > MAX_MESSAGE_BYTES ? 1009 : 1013); return; }
      pending = pending.then(async () => {
        const bytes = data instanceof Blob ? Buffer.from(await data.arrayBuffer()) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
        queuedBytes -= size;
        if (writable(client, size)) client.send(bytes, { binary: typeof data !== 'string' }, error => { if (error) fail(); });
      }).catch(fail);
    });
  });
  if (!accepted) { cleanup(); wss.close(); }
}

export function createWebSocketProxy(deps: WebSocketProxyDeps): WebSocketProxy {
  async function validate(path: string | undefined, headers: IncomingMessage['headers']): Promise<WebSocketValidation> {
    const input = { url: path, headers };
    const route = resolveProxyRoute(input, deps);
    if (!route) return { ok: false, statusCode: 400 };
    if (!await authorizeProxy(input, route.id, deps)) return { ok: false, statusCode: 401 };
    if (!await deps.getAccount(route.id)) return { ok: false, statusCode: 404 };
    const selected = resolveUpstreamOrigin(route.upstreamPath, deps.upstreamOrigin, deps.additionalOrigins);
    if (!selected) return { ok: false, statusCode: 404 };
    if (!isAllowedUpstream(new URL(selected.path, selected.origin), selected.origin)) return { ok: false, statusCode: 400 };
    return { ok: true, accountId: route.id, upstreamPath: selected.path };
  }
  async function upgrade(socket: Duplex, request: IncomingMessage, head = Buffer.alloc(0), context?: ProxyContext): Promise<void> {
    let upstream: WebSocket | undefined;
    let agent: ReturnType<typeof createNodeProxyAgent> | undefined;
    try {
      const route = resolveProxyRoute(request, deps, context);
      if (!route) { rejectUpgrade(socket, 400); return; }
      if (!await authorizeProxy(request, route.id, deps)) { rejectUpgrade(socket, 401); return; }
      const account = await deps.getAccount(route.id);
      if (!account) { rejectUpgrade(socket, 404); return; }
      const selected = resolveUpstreamOrigin(route.upstreamPath, deps.upstreamOrigin, deps.additionalOrigins);
      if (!selected) { rejectUpgrade(socket, 404); return; }
      const target = new URL(selected.path, selected.origin);
      if (!isAllowedUpstream(target, selected.origin)) { rejectUpgrade(socket, 400); return; }
      const jar = await deps.getCookieJar?.(route.id);
      const headers = upstreamHeaders(fingerprintHeaders(request.headers, account.fp), deps.upstreamOrigin);
      for (const name of Object.keys(headers)) if (name.startsWith('sec-websocket-')) delete headers[name];
      if (jar) { const cookie = await jar.getCookieString(target.href); if (cookie) headers.cookie = cookie; }
      const protocols = request.headers['sec-websocket-protocol']?.split(',').map((part) => part.trim()).filter(Boolean) ?? [];
      const websocketUrl = new URL(target);
      websocketUrl.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
      const profile = account.fp?.enabled ? account.fp.tlsProfile : 'native';
      if (profile && profile !== 'native') {
        const controller = new AbortController();
        let connection: BrowserWebSocketConnection | undefined;
        const cleanup = () => {
          socket.removeListener('close', abort);
          socket.removeListener('end', abort);
          socket.removeListener('error', abort);
          void connection?.close().catch(() => undefined);
        };
        const abort = () => { controller.abort(); cleanup(); };
        socket.once('close', abort); socket.once('end', abort); socket.once('error', abort);
        try {
          if (socket.destroyed) controller.abort();
          const mode = account.fp?.uaMode;
          connection = await browserWebSocket({ url: websocketUrl.href, headers, protocols, profile,
            os: mode === 'windows' || mode === 'macos' || mode === 'android' ? mode : 'linux',
            ...(account.proxy ? { proxy: typeof account.proxy === 'string' ? account.proxy : account.proxy.url } : {}),
            timeoutMs: deps.timeoutMs ?? 10_000, signal: controller.signal });
          if (socket.destroyed || controller.signal.aborted) { cleanup(); return; }
          // After upgrade the WebSocket close event carries the peer's code/reason.
          socket.removeListener('close', abort); socket.removeListener('end', abort); socket.removeListener('error', abort);
          // wreq exposes no raw 101 headers; browser-mode cookie refresh is HTTP-only.
          bridgeBrowser(connection, request, socket, head, cleanup);
        } catch (error) { cleanup(); throw error; }
        return;
      }
      if (account.proxy) agent = createNodeProxyAgent(account.proxy, target, deps.timeoutMs);
      const remote = upstream = new WebSocket(websocketUrl, protocols, {
        headers, ...(agent ? { agent } : {}), handshakeTimeout: deps.timeoutMs ?? 10_000,
        followRedirects: false, perMessageDeflate: false, maxPayload: 16 * 1024 * 1024,
      });
      const abort = () => remote.terminate();
      socket.once('close', abort);
      remote.on('error', () => undefined);
      let handshakeHeaders: IncomingMessage['headers'] = {};
      remote.once('upgrade', (response) => { handshakeHeaders = response.headers; });
      await new Promise<void>((resolve, reject) => {
        remote.once('open', () => { remote.pause(); resolve(); });
        remote.once('error', reject);
        remote.once('unexpected-response', (_request, response) => {
          response.destroy(); remote.terminate(); reject(new Error('Upstream upgrade failed'));
        });
      });
      if (jar && await persistSetCookies({ headers: handshakeHeaders }, target.href, jar) && deps.saveCookieJar) await deps.saveCookieJar(route.id, jar);
      if (socket.destroyed) { remote.terminate(); agent?.destroy(); return; }
      const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 16 * 1024 * 1024,
        handleProtocols: () => remote.protocol || false,
      });
      wss.handleUpgrade(request, socket, head, (client) => {
        const send = (targetSocket: WebSocket) => (data: import('ws').RawData, binary: boolean) => {
          if (targetSocket.readyState !== WebSocket.OPEN) return;
          if (targetSocket.bufferedAmount > 8 * 1024 * 1024) { client.close(1013); remote.close(1013); return; }
          targetSocket.send(data, { binary }, (error) => { if (error) { client.terminate(); remote.terminate(); } });
        };
        client.on('message', send(remote)); remote.on('message', send(client));
        for (const [source, destination] of [[client, remote], [remote, client]] as const) {
          source.on('ping', (data) => { if (destination.readyState === WebSocket.OPEN) destination.ping(data); });
          source.on('pong', (data) => { if (destination.readyState === WebSocket.OPEN) destination.pong(data); });
          source.once('close', (code, reason) => relayClose(destination, code, reason));
          source.on('error', () => { client.terminate(); remote.terminate(); });
        }
        client.once('close', () => { socket.removeListener('close', abort); wss.close(); });
        remote.once('close', () => agent?.destroy());
        remote.resume();
      });
    } catch { upstream?.terminate(); agent?.destroy(); rejectUpgrade(socket, 502); }
  }
  return { validate, upgrade };
}
export function attachWebSocketProxy(server: Server, proxy: WebSocketProxy): void {
  server.on('upgrade', (request, socket, head) => { void proxy.upgrade(socket, request, head); });
}
