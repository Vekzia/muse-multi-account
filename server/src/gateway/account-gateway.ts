import { createServer, STATUS_CODES, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP, type Socket } from 'node:net';
import { Readable, type Duplex } from 'node:stream';
import { accountSessionCookieName, buildAccountSessionCookie, type AccountSessionManager } from '../auth/token-auth.js';
import type { ReverseProxyReply, ReverseProxyRequest } from '../proxy/reverse-proxy.js';

const DEFAULT_PORT_COUNT = 32;
const MAX_PORT_COUNT = 1_024;
const MAX_LAUNCH_BODY_BYTES = 8 * 1_024;
const MAX_PROXY_BODY_BYTES = 25 * 1_024 * 1_024;
const LAUNCH_PATH = '/__muse/launch';

export interface AccountGatewayContext {
  accountId: number;
  upstreamPath: string;
  localBase: '';
  localOrigin: string;
}

export interface AccountGatewayProxy {
  handle(request: ReverseProxyRequest, reply: ReverseProxyReply, context: AccountGatewayContext): Promise<void>;
  upgrade(socket: Duplex, request: IncomingMessage, head: Buffer, context: AccountGatewayContext): Promise<void>;
}

export interface AccountGatewayOptions {
  host: string;
  basePort: number;
  accessToken: string;
  store: { get(id: number): unknown | Promise<unknown> };
  proxy: AccountGatewayProxy;
  session: Pick<AccountSessionManager, 'consumeLaunch' | 'issueSession' | 'verifySession'>;
  secure?: boolean;
  bindHost?: string;
  publicHost?: string;
  managementOrigin?: string;
  portCount?: number;
  fingerprintPage?: (accountId: number, headers: IncomingMessage['headers']) => string | Promise<string>;
}

function hostname(value: string): string {
  const host = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  if (!host || (!isIP(host) && !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host))) {
    throw new Error('Invalid gateway hostname');
  }
  return host;
}

function configuredOrigin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Invalid gateway management origin');
  }
  return url.origin;
}

function replyAdapter(response: ServerResponse): ReverseProxyReply {
  return {
    raw: response,
    code(status) { response.statusCode = status; return this; },
    headers(headers) {
      for (const [name, value] of Object.entries(headers)) if (value !== undefined) response.setHeader(name, value);
      return this;
    },
    send(body) {
      if (body instanceof Readable) {
        body.once('error', () => response.destroy());
        response.once('close', () => body.destroy());
        body.pipe(response);
      } else response.end(body);
      return this;
    },
  };
}

function errorResponse(response: ServerResponse, status: number, message: string): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', connection: 'close' });
  response.end(message);
}

function upgradeError(socket: Socket, status: number, message: string): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
}

class BodyTooLarge extends Error {
  constructor(readonly limit: number) { super(`Request body exceeds ${limit} bytes`); }
}
function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        request.removeListener('data', onData);
        chunks.length = 0;
        reject(new BodyTooLarge(limit));
        request.resume();
      } else chunks.push(chunk);
    };
    request.on('error', reject);
    request.once('aborted', () => reject(new Error('Request aborted')));
    request.once('end', () => resolve(Buffer.concat(chunks)));
    if (Number(request.headers['content-length']) > limit) {
      request.resume();
      reject(new BodyTooLarge(limit));
      return;
    }
    request.on('data', onData);
  });
}

function limitedStream(request: IncomingMessage, response: ServerResponse, limit: number): Readable {
  let size = 0;
  const stream = new Readable({ read() { request.resume(); } });
  request.on('data', (chunk: Buffer) => {
    if (stream.destroyed) return;
    size += chunk.length;
    if (size > limit) {
      errorResponse(response, 413, `Request body exceeds ${limit} bytes`);
      stream.destroy(new BodyTooLarge(limit));
      request.resume();
    } else if (!stream.push(chunk)) request.pause();
  });
  stream.on('error', () => undefined);
  response.once('close', () => stream.destroy());
  request.once('end', () => stream.push(null));
  request.once('aborted', () => stream.destroy(new Error('Request aborted')));
  request.once('error', (error) => stream.destroy(error));
  return stream;
}

/** Owns fixed account origins (32 by default); callers POST their own launch tokens. */
export class AccountGateway {
  private readonly bindHost: string;
  private readonly publicHost: string;
  private readonly managementOrigin: string | undefined;
  private readonly portCount: number;
  private readonly servers: Server[] = [];
  private readonly sockets = new Set<Socket>();
  private starting: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private running = false;

  constructor(private readonly options: AccountGatewayOptions) {
    this.portCount = options.portCount ?? DEFAULT_PORT_COUNT;
    if (!Number.isSafeInteger(this.portCount) || this.portCount < 1 || this.portCount > MAX_PORT_COUNT) throw new RangeError('Gateway portCount must be an integer between 1 and 1024');
    if (!Number.isSafeInteger(options.basePort) || options.basePort < 1 || options.basePort + this.portCount - 1 > 65_535) {
      throw new RangeError(`Gateway basePort must reserve ${this.portCount} ports within 1..65535`);
    }
    this.bindHost = hostname(options.bindHost ?? options.host);
    const host = hostname(options.publicHost ?? options.host);
    this.publicHost = isIP(host) === 6 ? `[${host}]` : host;
    this.managementOrigin = options.managementOrigin ? configuredOrigin(options.managementOrigin) : undefined;
  }

  portFor(id: number): number {
    if (!Number.isSafeInteger(id) || id < 1 || id > this.portCount) throw new RangeError(`Gateway account ID must be between 1 and ${this.portCount}`);
    return this.options.basePort + id - 1;
  }

  /** The secret belongs in the POST body, never the returned URL. */
  launch(id: number, _token: string): string {
    const scheme = this.options.secure ? 'https' : 'http';
    return `${scheme}://${this.publicHost}:${this.portFor(id)}${LAUNCH_PATH}`;
  }

  start(): Promise<void> {
    if (this.stopping) return this.stopping.then(() => this.start());
    if (this.starting) return this.starting;
    if (this.running) return Promise.resolve();
    this.starting = this.openListeners().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      await this.starting?.catch(() => undefined);
      await this.closeListeners();
      this.running = false;
    })().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  private async openListeners(): Promise<void> {
    try {
      for (let id = 1; id <= this.portCount; id++) {
        const server = createServer((request, response) => {
          void this.handle(id, request, response).catch((error: unknown) => {
            errorResponse(response, error instanceof BodyTooLarge ? 413 : 502, error instanceof BodyTooLarge ? error.message : 'Account gateway request failed');
          });
        });
        server.requestTimeout = 30_000;
        server.headersTimeout = 15_000;
        server.on('connection', (socket) => {
          this.sockets.add(socket);
          socket.once('close', () => this.sockets.delete(socket));
          socket.on('error', () => undefined);
        });
        server.on('upgrade', (request, socket, head) => {
          void this.upgrade(id, request, socket as Socket, head).catch(() => upgradeError(socket as Socket, 502, 'Account gateway upgrade failed'));
        });
        this.servers.push(server);
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(this.portFor(id), this.bindHost, () => {
            server.removeListener('error', reject);
            resolve();
          });
        });
      }
      this.running = true;
    } catch (error) {
      await this.closeListeners();
      throw error;
    }
  }

  private async closeListeners(): Promise<void> {
    const closing = this.servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())));
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await Promise.all(closing);
  }

  private authenticated(request: IncomingMessage, accountId: number): boolean {
    const name = `${accountSessionCookieName(accountId)}=`;
    const cookies = request.headers.cookie?.split(';').map((part) => part.trim()).filter((part) => part.startsWith(name));
    return cookies?.length === 1 && this.options.session.verifySession(cookies[0]!.slice(name.length), accountId);
  }

  private expectedOrigin(accountId: number): string { return `${this.options.secure ? 'https' : 'http'}://${this.publicHost}:${this.portFor(accountId)}`; }

  private originAllowed(accountId: number, request: IncomingMessage, launch = false): boolean {
    const origin = request.headers.origin;
    if (!origin) return true;
    try {
      const supplied = new URL(origin).origin;
      return launch ? supplied === this.managementOrigin : supplied === this.expectedOrigin(accountId);
    } catch { return false; }
  }

  private context(accountId: number, request: IncomingMessage): AccountGatewayContext {
    return { accountId, upstreamPath: request.url ?? '/', localBase: '', localOrigin: this.expectedOrigin(accountId) };
  }

  private async handle(accountId: number, request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (!await this.options.store.get(accountId)) { errorResponse(response, 404, 'Account not found'); return; }
    const path = (request.url ?? '/').split('?')[0];
    if (path === LAUNCH_PATH || path === LAUNCH_PATH + '/fingerprint') {
      await this.handleLaunch(accountId, request, response);
      return;
    }
    if (request.headers.origin && !this.originAllowed(accountId, request)) { errorResponse(response, 403, 'Origin is not valid for this account port'); return; }
    if (!this.authenticated(request, accountId)) { errorResponse(response, 401, 'Account session missing or expired. Launch this account again.'); return; }
    if (path === '/__muse/fingerprint' && this.options.fingerprintPage) {
      if (request.method !== 'GET') { response.setHeader('Allow','GET'); errorResponse(response,405,'Selfcheck requires GET'); return; }
      const html = await this.options.fingerprintPage(accountId, request.headers);
      response.writeHead(200, { 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'private, no-store', 'Referrer-Policy':'no-referrer', 'X-Content-Type-Options':'nosniff' });
      response.end(html);
      return;
    }
    if (Number(request.headers['content-length']) > MAX_PROXY_BODY_BYTES) { request.resume(); throw new BodyTooLarge(MAX_PROXY_BODY_BYTES); }
    const body = limitedStream(request, response, MAX_PROXY_BODY_BYTES);
    await this.options.proxy.handle({
      method: request.method ?? 'GET', url: request.url ?? '/', headers: request.headers, raw: request, body,
    }, replyAdapter(response), this.context(accountId, request));
  }

  private async handleLaunch(accountId: number, request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      errorResponse(response, 405, 'Launch requires POST');
      return;
    }
    if (request.url?.includes('?')) { errorResponse(response, 400, 'Launch token must be submitted in the request body'); return; }
    if (!this.originAllowed(accountId, request, true)) { errorResponse(response, 403, 'Launch origin is not valid'); return; }
    const type = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/json' && type !== 'application/x-www-form-urlencoded') { errorResponse(response, 415, 'Use a JSON or form launch body'); return; }
    const body = await readBody(request, MAX_LAUNCH_BODY_BYTES);
    let token: unknown;
    try {
      if (type === 'application/json') {
        const input: unknown = JSON.parse(body.toString('utf8'));
        if (input && typeof input === 'object' && !Array.isArray(input)) token = (input as { token?: unknown }).token;
      } else {
        const input = new URLSearchParams(body.toString('utf8'));
        if (input.getAll('token').length === 1) token = input.get('token');
      }
    } catch { /* Treat parser details and body content as private. */ }
    if (typeof token !== 'string' || !token) { errorResponse(response, 400, 'Invalid launch body'); return; }
    if (!this.options.session.consumeLaunch(token, accountId)) { errorResponse(response, 401, 'Launch token invalid or expired'); return; }
    const session = this.options.session.issueSession(accountId);
    const cookie = buildAccountSessionCookie(accountId, session.token, this.options.secure ?? false, undefined, { name: accountSessionCookieName(accountId), path: '/' });
    const destination = request.url === LAUNCH_PATH + '/fingerprint' ? '/__muse/fingerprint' : '/';
    response.writeHead(302, { location: destination, 'set-cookie': cookie, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    response.end();
  }

  private async upgrade(accountId: number, request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    if (request.headers.host?.toLowerCase() !== `${this.publicHost}:${this.portFor(accountId)}`.toLowerCase()) { upgradeError(socket, 403, 'Host is not valid for this account port'); return; }
    if (!this.originAllowed(accountId, request)) { upgradeError(socket, 403, 'Origin is not valid for this account port'); return; }
    if (!await this.options.store.get(accountId)) { upgradeError(socket, 404, 'Account not found'); return; }
    if (!this.authenticated(request, accountId)) { upgradeError(socket, 401, 'Account session missing or expired'); return; }
    await this.options.proxy.upgrade(socket, request, head, this.context(accountId, request));
  }
}
