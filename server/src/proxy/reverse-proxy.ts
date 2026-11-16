import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import type { IncomingMessage, IncomingHttpHeaders, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Readable, type Duplex } from 'node:stream';
import { isAllowedUpstream, persistSetCookies, requestUpstream, type CookieJarLike } from './upstream.js';
import { filterResponseHeaders, isTextContentType, charsetFromContentType, rewriteMuseText, type AdditionalOrigins } from './response-rewriter.js';
import { resolveUpstreamOrigin, validateOrigins } from './origin-map.js';
import { injectBrowserBridge } from './browser-bridge.js';
import type { Fingerprint } from '../types.js';
import { fingerprintHeaders } from '../fingerprint/profile.js';
import { injectFingerprint } from '../fingerprint/script.js';
import { createWebSocketProxy } from './ws-proxy.js';
import type { ParsedProxy } from './proxy-url.js';

export interface ReverseProxyRequest {
  method?: string | undefined;
  url?: string | undefined;
  headers: IncomingHttpHeaders;
  body?: unknown;
  raw?: IncomingMessage;
}
export interface ReverseProxyReply {
  code(statusCode: number): unknown;
  headers(headers: IncomingHttpHeaders): unknown;
  send(body: Buffer | string | Readable): unknown;
  raw?: ServerResponse;
  hijack?(): unknown;
}
export interface ReverseProxyAccount { id: number; proxy?: string | ParsedProxy | null; fp?: Fingerprint; }
export interface ProxyContext { accountId: number; upstreamPath?: string; localBase?: string; localOrigin?: string; }
export interface ProxyRoute { id: number; upstreamPath: string; localBase: string; localOrigin?: string; }
export interface ReverseProxyDeps {
  accessToken: string;
  upstreamOrigin: string;
  getAccount(id: number): ReverseProxyAccount | undefined | Promise<ReverseProxyAccount | undefined>;
  getCookieJar(id: number): CookieJarLike | Promise<CookieJarLike>;
  saveCookieJar?(id: number, jar: CookieJarLike): Promise<unknown>;
  authorize?(request: ReverseProxyRequest, id: number): boolean | Promise<boolean>;
  resolveRoute?(request: ReverseProxyRequest): ProxyRoute | undefined;
  timeoutMs?: number;
  maxRewriteBytes?: number;
  additionalOrigins?: AdditionalOrigins;
}
export interface ReverseProxy {
  handle(request: ReverseProxyRequest, reply: ReverseProxyReply, context?: ProxyContext): Promise<void>;
  upgrade(socket: Duplex, request: IncomingMessage, head?: Buffer, context?: ProxyContext): Promise<void>;
}

export function resolveProxyRoute(request: ReverseProxyRequest, deps: Pick<ReverseProxyDeps, 'resolveRoute'>, context?: ProxyContext): ProxyRoute | undefined {
  let route: ProxyRoute | undefined;
  if (context) route = { id: context.accountId, upstreamPath: context.upstreamPath ?? request.url ?? '/', localBase: context.localBase ?? '', ...(context.localOrigin ? { localOrigin: context.localOrigin } : {}) };
  else if (deps.resolveRoute) route = deps.resolveRoute(request);
  else {
    const match = (request.url ?? '').match(/^\/muse\/([1-9]\d*)(\/[^#]*)?(\?[^#]*)?$/);
    if (match) route = { id: Number(match[1]), upstreamPath: (match[2] || '/') + (match[3] || ''), localBase: `/muse/${match[1]}` };
  }
  if (!route || !Number.isSafeInteger(route.id) || route.id < 1) return undefined;
  const path = route.upstreamPath;
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\x00-\x20#]/.test(path) || path.split('?')[0]!.includes('://')) return undefined;
  if (route.localBase !== '' && !/^\/(?!\/)[^?#\\]*$/.test(route.localBase)) return undefined;
  return route;
}
export async function authorizeProxy(request: ReverseProxyRequest, id: number, deps: Pick<ReverseProxyDeps, 'accessToken' | 'authorize'>): Promise<boolean> {
  if (deps.authorize) return deps.authorize(request, id);
  const supplied = request.headers.authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!supplied || !deps.accessToken) return false;
  const actual = Buffer.from(supplied), expected = Buffer.from(deps.accessToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function requestBody(request: ReverseProxyRequest): Buffer | string | Readable | undefined {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  if (Buffer.isBuffer(request.body) || typeof request.body === 'string' || request.body instanceof Readable) return request.body;
  if (request.body !== undefined) return JSON.stringify(request.body);
  return request.raw;
}
function decodeBody(body: Buffer, encoding: string | undefined, maxOutputLength: number): Buffer | undefined {
  try {
    switch (encoding?.toLowerCase()) {
      case undefined: case 'identity': return body;
      case 'gzip': return gunzipSync(body, { maxOutputLength });
      case 'deflate': return inflateSync(body, { maxOutputLength });
      case 'br': return brotliDecompressSync(body, { maxOutputLength });
      default: return undefined;
    }
  } catch { return undefined; }
}
/** Bounded lookahead; a large text body falls back to the original byte stream. */
async function boundedBody(body: Readable, limit: number): Promise<Buffer | Readable> {
  const chunks: Buffer[] = [];
  const iterator = body[Symbol.asyncIterator]();
  let size = 0;
  while (true) {
    const next = await iterator.next();
    if (next.done) return Buffer.concat(chunks);
    const chunk = Buffer.from(next.value as Uint8Array);
    chunks.push(chunk); size += chunk.length;
    if (size > limit) {
      return Readable.from((async function* () {
        try {
          yield* chunks;
          while (true) { const item = await iterator.next(); if (item.done) break; yield item.value; }
        } finally { body.destroy(); }
      })());
    }
  }
}

export function createReverseProxy(deps: ReverseProxyDeps): ReverseProxy {
  validateOrigins(deps.additionalOrigins ?? {});
  const websocket = createWebSocketProxy(deps);
  async function handle(input: ReverseProxyRequest, reply: ReverseProxyReply, context?: ProxyContext): Promise<void> {
    const fail = (status: number, message: string) => { reply.code(status); reply.send(message); };
    const route = resolveProxyRoute(input, deps, context);
    if (!route) { fail(400, 'Invalid Muse route'); return; }
    const selectedUpstream = resolveUpstreamOrigin(route.upstreamPath, deps.upstreamOrigin, deps.additionalOrigins);
    if (!selectedUpstream) { fail(404, 'Unknown upstream origin'); return; }
    const upstreamPath = selectedUpstream.path;
    const upstreamOrigin = selectedUpstream.origin;
    let body: Readable | undefined;
    try {
      if (!await authorizeProxy(input, route.id, deps)) { fail(401, 'Unauthorized'); return; }
      const account = await deps.getAccount(route.id);
      if (!account) { fail(404, 'Account not found'); return; }
      const target = new URL(upstreamPath, upstreamOrigin);
      if (!isAllowedUpstream(target, upstreamOrigin)) { fail(400, 'Blocked upstream origin'); return; }
      const jar = await deps.getCookieJar(route.id);
      const requestHeaders = fingerprintHeaders(input.headers, account.fp);
      if (account.fp?.enabled) {
        // A 304 could reuse a document generated with another fingerprint revision.
        for (const key of Object.keys(requestHeaders)) {
          if (['if-none-match', 'if-modified-since', 'if-range'].includes(key.toLowerCase())) delete requestHeaders[key];
        }
      }
      const upstream = await requestUpstream({
        origin: upstreamOrigin, path: upstreamPath, pageOrigin: deps.upstreamOrigin, method: input.method ?? 'GET',
        headers: requestHeaders, body: requestBody(input), proxy: account.proxy, jar,
        ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
      });
      body = upstream.body;
      body.on('error', () => undefined);
      // Persistence must finish before exposing the response to the account page.
      if (await persistSetCookies(upstream, target.href, jar) && deps.saveCookieJar) await deps.saveCookieJar(route.id, jar);
      const resourceBase = route.localBase + selectedUpstream.prefix;
      const headers = filterResponseHeaders(upstream.headers, resourceBase, upstreamOrigin, route.localOrigin, deps.additionalOrigins);
      let output: Readable | Buffer = body;
      const htmlDocument = /^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(String(headers['content-type'] ?? ''));
      const fingerprintRequired = Boolean(account.fp?.enabled && input.method !== 'HEAD' && htmlDocument && upstream.statusCode >= 200 && upstream.statusCode < 300);
      let fingerprintApplied = false;
      const charset = charsetFromContentType(headers['content-type']);
      const encoding: BufferEncoding | undefined = ({ 'utf-8': 'utf8', utf8: 'utf8', 'us-ascii': 'ascii', ascii: 'ascii', 'iso-8859-1': 'latin1', latin1: 'latin1', 'utf-16le': 'utf16le' } as Record<string, BufferEncoding>)[charset];
      if (input.method !== 'HEAD' && upstream.statusCode !== 206 && !headers['content-range'] && encoding && isTextContentType(headers['content-type'])) {
        const limit = deps.maxRewriteBytes ?? 4 * 1024 * 1024;
        output = await boundedBody(body, limit);
        if (Buffer.isBuffer(output)) {
          const decoded = decodeBody(output, headers['content-encoding'], limit);
          if (decoded) {
            let text = rewriteMuseText(decoded.toString(encoding), resourceBase, upstreamOrigin, route.localOrigin, deps.additionalOrigins);
            if (htmlDocument) {
              if (route.localOrigin) text = injectBrowserBridge(text, deps.upstreamOrigin, route.localOrigin, deps.additionalOrigins);
              if (account.fp) {
                text = injectFingerprint(text, account.fp);
                fingerprintApplied = account.fp.enabled === true;
              }
              headers['cache-control'] = 'private, no-store';
              delete headers['last-modified'];
            }
            output = Buffer.from(text, encoding);
            delete headers['content-encoding']; delete headers.etag; delete headers['content-md5'];
            headers['content-length'] = String(output.length);
          }
        }
      }
      if (fingerprintRequired && !fingerprintApplied) {
        body.destroy();
        if (output instanceof Readable) { output.on('error', () => undefined); output.destroy(); }
        reply.headers({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', 'x-muse-fingerprint': 'unsupported' });
        reply.code(502);
        reply.send('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>指纹注入未完成</title><body><h1>此页面未应用指纹配置</h1><p>页面编码、压缩格式、分段响应或大小超出当前指纹注入支持范围。为避免请求头与页面身份不一致，已停止展示原始页面。</p><p>请返回工作台调整配置，或关闭指纹覆写后重新打开。</p></body></html>');
        return;
      }
      if (output instanceof Readable && reply.raw) {
        const stream = output;
        const source = body;
        const raw = reply.raw;
        raw.once('close', () => { stream.destroy(); source.destroy(); });
        stream.once('error', () => { source.destroy(); if (!raw.destroyed) raw.destroy(); });
        reply.hijack?.();
        raw.writeHead(upstream.statusCode, headers);
        stream.pipe(raw);
        return;
      }
      reply.headers(headers); reply.code(upstream.statusCode); reply.send(output);
    } catch {
      body?.destroy();
      fail(502, 'Upstream request failed');
    }
  }
  return { handle, upgrade: websocket.upgrade };
}
