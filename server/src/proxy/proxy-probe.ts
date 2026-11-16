import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Agent, Pool, ProxyAgent, request as undiciRequest } from 'undici';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { parseProxy, type ParsedProxy } from './proxy-url.js';

export interface ProxyProbeResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  error?: string;
}

/** Probe only the supplied endpoint; never follow redirects or store response cookies. */
export async function probeProxy(
  proxy: string | ParsedProxy | undefined | null,
  endpoint = 'https://www.gstatic.com/generate_204',
  timeoutMs = 10_000,
): Promise<ProxyProbeResult> {
  const started = performance.now();
  const elapsed = () => Math.max(0, Math.round(performance.now() - started));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    return { ok: false, latencyMs: elapsed(), error: 'Invalid probe timeout' };
  }
  let target: URL;
  try {
    target = new URL(endpoint);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error();
  } catch {
    return { ok: false, latencyMs: elapsed(), error: 'Invalid probe endpoint' };
  }
  let parsed: ParsedProxy | undefined;
  if (proxy) {
    try {
      parsed = parseProxy(typeof proxy === 'string' ? proxy : proxy.url);
    } catch {
      return { ok: false, latencyMs: elapsed(), error: 'Invalid proxy configuration' };
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const status = parsed?.protocol === 'socks5:'
      ? await requestThroughSocks(parsed, target, controller.signal, timeoutMs)
      : await requestThroughUndici(parsed, target, controller.signal);
    return status >= 200 && status < 300
      ? { ok: true, status, latencyMs: elapsed() }
      : { ok: false, status, latencyMs: elapsed(), error: `Proxy probe returned HTTP ${status}` };
  } catch {
    return {
      ok: false, latencyMs: elapsed(),
      error: controller.signal.aborted ? 'Proxy probe timed out' : 'Proxy probe failed',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function requestThroughUndici(proxy: ParsedProxy | undefined, target: URL, signal: AbortSignal): Promise<number> {
  let proxyClient: Pool | undefined;
  const dispatcher = proxy ? new ProxyAgent({
    uri: proxy.url,
    ...(proxy.username !== undefined ? {
      token: `Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64')}`,
    } : {}),
    clientFactory: (origin, options) => {
      proxyClient = new Pool(origin, options);
      return proxyClient;
    },
  }) : new Agent();
  // Undici's outer request signal does not cancel an in-progress CONNECT.
  // Terminate its proxy pool directly so a stalled handshake obeys our deadline.
  const abortProxy = () => { void proxyClient?.destroy().catch(() => undefined); };
  signal.addEventListener('abort', abortProxy, { once: true });
  if (signal.aborted) abortProxy();
  try {
    const response = await undiciRequest(target, { method: 'GET', dispatcher, signal, maxRedirections: 0 });
    // Only response headers matter. Destroy even an unbounded response body.
    response.body.on('error', () => undefined);
    response.body.destroy();
    return response.statusCode;
  } finally {
    signal.removeEventListener('abort', abortProxy);
    await proxyClient?.destroy();
    await dispatcher.destroy();
  }
}

async function requestThroughSocks(proxy: ParsedProxy, target: URL, signal: AbortSignal, timeoutMs: number): Promise<number> {
  const agent = new SocksProxyAgent(proxy.url, { timeout: timeoutMs });
  try {
    return await new Promise<number>((resolve, reject) => {
      const requestFn = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const request = requestFn(target, { method: 'GET', agent, signal }, (response) => {
        response.on('error', () => undefined);
        response.destroy();
        resolve(response.statusCode ?? 0);
      });
      request.once('error', reject);
      request.end();
    });
  } finally {
    agent.destroy();
  }
}
