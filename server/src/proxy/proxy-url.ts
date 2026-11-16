import { isIP } from 'node:net';

export interface ParsedProxy {
  url: string;
  protocol: 'http:' | 'https:' | 'socks5:';
  hostname: string;
  port: number;
  username?: string;
  password?: string;
}

/** Validate before handing the URL (including its credentials) to a connector. */
export function parseProxy(raw: string): ParsedProxy {
  try {
    if (typeof raw !== 'string') throw new Error();
    const input = raw.trim();
    if (!/^(https?|socks5):\/\/[^/]/i.test(input) || /[\x00-\x20\x7f\\?#]/.test(input)) throw new Error();
    const url = new URL(input);
    if (!['http:', 'https:', 'socks5:'].includes(url.protocol) || (url.pathname && url.pathname !== '/')) throw new Error();
    const authority = input.slice(input.indexOf('://') + 3).replace(/\/$/, '');
    if (authority.endsWith(':')) throw new Error();
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const labels = hostname.replace(/\.$/, '').split('.');
    if (!isIP(hostname) && (hostname.length > 253 || !labels.every((label) =>
      label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)))) throw new Error();
    const protocol = url.protocol as ParsedProxy['protocol'];
    const port = url.port ? Number(url.port) : { 'http:': 80, 'https:': 443, 'socks5:': 1080 }[protocol];
    if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    if (/[\x00-\x1f\x7f]/.test(username + password)) throw new Error();
    return {
      url: url.href, protocol, hostname, port,
      ...(url.username || url.password ? { username, password } : {}),
    };
  } catch {
    // Never retain the URL parser's input-bearing message or cause.
    throw new Error('Invalid proxy URL');
  }
}

/** A diagnostic representation; malformed input is never echoed. */
export function redactProxy(proxy: string | ParsedProxy): string {
  try {
    const parsed = parseProxy(typeof proxy === 'string' ? proxy : proxy.url);
    const host = parsed.hostname.includes(':') ? `[${parsed.hostname}]` : parsed.hostname;
    const credentials = parsed.username !== undefined ? '***:***@' : '';
    return `${parsed.protocol}//${credentials}${host}:${parsed.port}`;
  } catch {
    return '[invalid proxy]';
  }
}
