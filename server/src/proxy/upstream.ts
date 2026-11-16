import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { Readable } from 'node:stream';
import type { Duplex } from 'node:stream';
import { request as undiciRequest, ProxyAgent, type Dispatcher } from 'undici';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { parseProxy, type ParsedProxy } from './proxy-url.js';

export interface CookieJarLike {
  getCookieString(url: string): Promise<string>;
  setCookie(cookie: string, url: string): Promise<unknown>;
  save?: () => Promise<unknown>;
}
export interface UpstreamResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Readable;
}
export interface UpstreamRequestOptions {
  origin: string;
  path: string;
  /** Browser-visible page origin used for Origin/Referer, while origin is target. */
  pageOrigin?: string;
  method?: string;
  headers?: IncomingHttpHeaders;
  body?: Buffer | string | Readable | undefined;
  proxy?: string | ParsedProxy | null | undefined;
  jar?: CookieJarLike;
  timeoutMs?: number;
}

/** Exact origin comparison; neither userinfo nor URL parsing ambiguities expand scope. */
export function isAllowedUpstream(url: string | URL, configuredOrigin: string): boolean {
  try {
    const candidate = new URL(url);
    const configured = new URL(configuredOrigin);
    return ['http:', 'https:'].includes(candidate.protocol) &&
      ['http:', 'https:'].includes(configured.protocol) &&
      !candidate.username && !candidate.password && !configured.username && !configured.password &&
      configured.pathname === '/' && !configured.search && !configured.hash &&
      candidate.origin === configured.origin;
  } catch { return false; }
}

export const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection',
]);
export function stripHopHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const named = String(normalized.connection ?? '').split(',').map((part) => part.trim().toLowerCase());
  return Object.fromEntries(Object.entries(normalized).filter(([key, value]) => value !== undefined && !HOP_HEADERS.has(key) && !named.includes(key)));
}
export function upstreamHeaders(headers: IncomingHttpHeaders, origin: string): IncomingHttpHeaders {
  const clean = stripHopHeaders(headers);
  for (const name of ['authorization', 'cookie', 'host', 'content-length', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']) delete clean[name];
  if (clean.origin) clean.origin = new URL(origin).origin;
  if (clean.referer) {
    try {
      const referer = new URL(String(clean.referer));
      clean.referer = `${new URL(origin).origin}${referer.pathname}${referer.search}${referer.hash}`;
    } catch {
      clean.referer = `${new URL(origin).origin}/`;
    }
  }
  return clean;
}

/** Node Agent needed by ws and SOCKS; HTTP(S) proxies use CONNECT. */
export function createNodeProxyAgent(proxy: string | ParsedProxy, target: URL, timeoutMs = 10_000): http.Agent {
  const parsed = parseProxy(typeof proxy === 'string' ? proxy : proxy.url);
  if (parsed.protocol === 'socks5:') return new SocksProxyAgent(parsed.url, { timeout: timeoutMs });
  const secure = target.protocol === 'https:' || target.protocol === 'wss:';
  const agent = secure ? new https.Agent() : new http.Agent();
  agent.createConnection = (_options, callback) => {
    const headers: Record<string, string> = { host: `${target.hostname}:${target.port || (secure ? 443 : 80)}` };
    if (parsed.username !== undefined) headers['proxy-authorization'] = `Basic ${Buffer.from(`${parsed.username}:${parsed.password ?? ''}`).toString('base64')}`;
    const transport = parsed.protocol === 'https:' ? https : http;
    const connect = transport.request({ hostname: parsed.hostname, port: parsed.port, method: 'CONNECT', path: headers.host, headers });
    connect.setTimeout(timeoutMs, () => connect.destroy(new Error('Proxy connection timed out')));
    connect.once('error', (error) => callback?.(error, undefined as unknown as Duplex));
    connect.once('connect', (response, socket, head) => {
      connect.setTimeout(0);
      if (response.statusCode !== 200) { socket.destroy(); callback?.(new Error('Proxy connection failed'), undefined as unknown as Duplex); return; }
      if (head.length) socket.unshift(head);
      if (!secure) { callback?.(null, socket); return; }
      const secured = tls.connect({ socket, servername: target.hostname.replace(/^\[|\]$/g, '') });
      secured.once('secureConnect', () => callback?.(null, secured));
      secured.once('error', (error) => callback?.(error, undefined as unknown as Duplex));
    });
    connect.end();
    return undefined;
  };
  return agent;
}

export async function requestUpstream(options: UpstreamRequestOptions): Promise<UpstreamResponse> {
  const target = new URL(options.path, options.origin);
  if (!options.path.startsWith('/') || options.path.startsWith('//') || options.path.includes('\\') || !isAllowedUpstream(target, options.origin)) throw new Error('Blocked upstream origin');
  const headers = upstreamHeaders(options.headers ?? {}, options.pageOrigin ?? options.origin);
  if (options.jar) {
    const cookie = await options.jar.getCookieString(target.href);
    if (cookie) headers.cookie = cookie;
  }
  const proxy = options.proxy ? parseProxy(typeof options.proxy === 'string' ? options.proxy : options.proxy.url) : undefined;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (proxy?.protocol === 'socks5:') {
    return new Promise((resolve, reject) => {
      const agent = createNodeProxyAgent(proxy, target, timeoutMs);
      const transport = target.protocol === 'https:' ? https : http;
      const request = transport.request(target, { method: options.method ?? 'GET', headers, agent }, (response) => {
        response.once('close', () => agent.destroy());
        resolve({ statusCode: response.statusCode ?? 502, headers: response.headers, body: response });
      });
      request.setTimeout(timeoutMs, () => request.destroy(new Error('Upstream timed out')));
      request.once('error', (error) => { agent.destroy(); reject(error); });
      if (options.body instanceof Readable) options.body.pipe(request); else request.end(options.body);
    });
  }
  const dispatcher = proxy ? new ProxyAgent({ uri: proxy.url,
    ...(proxy.username !== undefined ? { token: `Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64')}` } : {}),
    proxyTls: { timeout: timeoutMs }, requestTls: { timeout: timeoutMs } }) : undefined;
  const controller = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const requestPromise = undiciRequest(target, {
    signal: controller.signal,
    method: (options.method ?? 'GET') as Dispatcher.HttpMethod,
    headers: headers as Record<string, string | string[]>,
    ...(options.body !== undefined ? { body: options.body } : {}),
    ...(dispatcher ? { dispatcher } : {}),
    maxRedirections: 0, headersTimeout: timeoutMs, bodyTimeout: timeoutMs,
  });
  requestPromise.catch(() => undefined);
  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => {
        controller.abort();
        void dispatcher?.destroy();
        reject(new Error('Upstream request timed out'));
      }, timeoutMs);
      deadline.unref();
    });
    const response = await Promise.race([requestPromise, timeoutPromise]);
    if (deadline) clearTimeout(deadline);
    if (dispatcher) response.body.once('close', () => { void dispatcher.close(); });
    return { statusCode: response.statusCode, headers: response.headers, body: response.body };
  } catch (error) {
    if (deadline) clearTimeout(deadline);
    controller.abort();
    void dispatcher?.destroy();
    throw error;
  }
}

export async function persistSetCookies(response: Pick<UpstreamResponse, 'headers'>, targetUrl: string, jar: CookieJarLike): Promise<boolean> {
  const values = response.headers['set-cookie'];
  const cookies = Array.isArray(values) ? values : values ? [values] : [];
  for (const cookie of cookies) {
    // A malformed cookie must not discard other valid cookies in the response.
    await jar.setCookie(cookie, targetUrl).catch(() => undefined);
  }
  if (cookies.length && jar.save) await jar.save();
  return cookies.length > 0;
}
