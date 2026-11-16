import type { IncomingHttpHeaders } from 'node:http';
import { stripHopHeaders } from './upstream.js';
import { ORIGIN_PREFIX, type AdditionalOrigins } from './origin-map.js';
export type { AdditionalOrigins } from './origin-map.js';
export type HeaderMap = IncomingHttpHeaders;

function cleanBase(value: string): string {
  if (value === '' || value === '/') return '';
  if (!/^\/(?!\/)[^?#\\]*$/.test(value)) throw new Error('Invalid local proxy base');
  return value.replace(/\/$/, '');
}
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function rootBase(base: string): string { const i = base.indexOf(ORIGIN_PREFIX); return i < 0 ? base : base.slice(0, i); }
function localPath(base: string, path: string): string {
  return base && (path === base || path.startsWith(base + '/')) ? path : base + path;
}
function entries(base: string, current: string, additional: AdditionalOrigins): Map<string, string> {
  const root = rootBase(base);
  const map = new Map<string, string>([['https://muse.ai', root], ['https://www.muse.ai', root]]);
  for (const [alias, origin] of Object.entries(additional)) map.set(new URL(origin).origin, root + ORIGIN_PREFIX + alias);
  map.set(new URL(current).origin, base);
  return map;
}

/** Rewrite only known URL literals; external links remain external and never gain proxy access. */
export function rewriteMuseText(body: string, localBase: string, upstreamOrigin: string, localOrigin?: string, additionalOrigins: AdditionalOrigins = {}): string {
  const base = cleanBase(localBase);
  const local = localOrigin ? new URL(localOrigin).origin : '';
  const map = entries(base, upstreamOrigin, additionalOrigins);
  let result = body.replace(/(["'`(])\/(?!\/)([^"'`<>\s)]*)/g,
    (_m, prefix: string, path: string) => prefix + localPath(base, '/' + path));
  const alternatives = [...map.keys()].flatMap(origin => {
    const u = new URL(origin);
    return [origin, (u.protocol === 'https:' ? 'wss://' : 'ws://') + u.host, '//' + u.host];
  }).sort((a, b) => b.length - a.length);
  const pattern = new RegExp('(["\'`(])(' + alternatives.map(escapeRegExp).join('|') + ')(?=[/?#"\'`\\s)])', 'g');
  const replace = (match: string, prefix: string, origin: string, offset: number, input: string) => {
    const ws = origin.startsWith('ws:') || origin.startsWith('wss:');
    let normalized = origin.startsWith('//') ? new URL(origin, upstreamOrigin).origin : origin.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
    const target = map.get(normalized);
    if (target === undefined) return match;
    const leading = ws && local ? local.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:') : local;
    const next = input[offset + match.length];
    const slash = next === '/' || (leading && !target && next !== '?' && next !== '#') ? '' : '/';
    return prefix + leading + target + slash;
  };
  result = result.replace(pattern, replace);
  // JSON escaped URLs are replaced in isolation, without unescaping surrounding source.
  for (const [origin, target] of map) {
    const escaped = origin.replaceAll('/', '\\/');
    result = result.replaceAll(escaped + '\\/', (local + target).replaceAll('/', '\\/') + '\\/');
  }
  return result;
}

export function rewriteLocation(value: string | undefined, localBase: string, upstreamOrigin: string, localOrigin?: string, additionalOrigins: AdditionalOrigins = {}): string | undefined {
  if (!value || /[\x00-\x1f\x7f\\]/.test(value)) return undefined;
  const base = cleanBase(localBase);
  try {
    if (!value.startsWith('/') && !/^[a-z][a-z\d+.-]*:/i.test(value)) return value;
    const url = new URL(value, upstreamOrigin);
    if (url.username || url.password) return undefined;
    const target = entries(base, upstreamOrigin, additionalOrigins).get(url.origin);
    if (target === undefined) return undefined;
    return `${localOrigin ? new URL(localOrigin).origin : ''}${localPath(target, url.pathname + url.search + url.hash)}`;
  } catch { return undefined; }
}
export function filterResponseHeaders(headers: HeaderMap, localBase: string, upstreamOrigin: string, localOrigin?: string, additionalOrigins: AdditionalOrigins = {}): HeaderMap {
  const output = stripHopHeaders(headers);
  delete output['set-cookie'];
  // Client-origin policies from the upstream refer to its origin, not the gateway.
  for (const name of ['alt-svc','report-to','nel']) delete output[name];
  const type = String(output['content-type'] ?? '').toLowerCase();
  if (type.startsWith('text/html') || type.startsWith('application/xhtml+xml')) {
    delete output['content-security-policy']; delete output['content-security-policy-report-only']; delete output['x-frame-options'];
  }
  if (output.location) {
    const location = rewriteLocation(output.location, localBase, upstreamOrigin, localOrigin, additionalOrigins);
    delete output.location;
    if (location !== undefined) output.location = location;
  }
  return output;
}
export function isTextContentType(contentType: string | undefined): boolean {
  const mime = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  return ['text/html','application/xhtml+xml','text/javascript','application/javascript','application/x-javascript','text/css','application/json','image/svg+xml'].includes(mime);
}
export function charsetFromContentType(contentType: string | undefined): string {
  return contentType?.match(/(?:^|;)\s*charset\s*=\s*["']?([^;"']+)/i)?.[1]?.trim().toLowerCase() || 'utf-8';
}
