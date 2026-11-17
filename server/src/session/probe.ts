import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';

export const SESSION_REQUEST_TIMEOUT_MS = 12_000;
export const MAX_SESSION_RESPONSE_BYTES = 64 * 1024;
export const MAX_RETRY_AFTER_MS = 60 * 60_000;
export type SessionProbeState = 'unknown' | 'healthy' | 'auth_expired' | 'blocked' | 'error';
export type SessionProbeError = 'no_viable_cookie' | 'auth_expired' | 'blocked' | 'rate_limited'
  | 'upstream_error' | 'unexpected_status' | 'invalid_response' | 'response_too_large'
  | 'wake_unconfirmed' | 'network_error' | 'timeout' | 'cancelled';
export interface SessionProbeResult {
  state: SessionProbeState;
  error?: SessionProbeError;
  vmState?: string;
  /** Unix milliseconds copied from the real account jar, never a derived extension. */
  cookieExpiresAt?: number | null;
  retryAfterMs?: number;
}
export type SessionHeaders = { get(name: string): string | null } | Record<string, string | string[] | number | undefined>;
export type SessionResponse = {
  headers: SessionHeaders;
  body?: AsyncIterable<Uint8Array | string> | null;
  text?: () => Promise<string>;
} & ({ statusCode: number; status?: number } | { status: number; statusCode?: number });
export type SessionRequest = (
  method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, signal?: AbortSignal,
) => Promise<SessionResponse>;
export interface SessionProbeOptions {
  /** Adapter owns account jar, Origin, Referer /thread/new, no redirects and guarded Set-Cookie. */
  request: SessionRequest;
  hasViableCookies: boolean;
  wakeVm: boolean;
  signal?: AbortSignal;
  cookieExpiresAt?: number | null | (() => number | null);
  now?: () => number;
  uuid?: () => string;
}

const VM_STATES = new Set(['RUNNING', 'STOPPED', 'SLEEPING', 'SUSPENDED', 'STARTING', 'STOPPING', 'DISABLED', 'PENDING', 'UNKNOWN']);
const SLEEPING_STATES = new Set(['STOPPED', 'SLEEPING', 'SUSPENDED']);

/** Only known state labels cross the public boundary; arbitrary upstream strings may contain secrets. */
export function publicVmState(value: unknown): string | undefined {
  return typeof value === 'string' && VM_STATES.has(value) ? value : undefined;
}

/** Protocol only: no transport, jar mutation, login, or fabricated cookie lifetime. */
export async function probeSession(options: SessionProbeOptions): Promise<SessionProbeResult> {
  let result: SessionProbeResult;
  try {
    if (options.signal?.aborted) throw new ProbeFailure('cancelled');
    if (!options.hasViableCookies) result = { state: 'auth_expired', error: 'no_viable_cookie' };
    else result = await inspectSession(options);
  } catch (error) {
    const code = error instanceof ProbeFailure ? error.code : 'network_error';
    result = { state: code === 'invalid_response' || code === 'response_too_large' ? 'unknown' : 'error', error: code };
  }
  let expiry: unknown = null;
  try { expiry = typeof options.cookieExpiresAt === 'function' ? options.cookieExpiresAt() : options.cookieExpiresAt; } catch { /* No expiry is preferable to invented data. */ }
  return { ...result, cookieExpiresAt: typeof expiry === 'number' && Number.isFinite(expiry) && expiry >= 0 ? expiry : null };
}

async function inspectSession(options: SessionProbeOptions): Promise<SessionProbeResult> {
  const first = await exchange(options, 'GET', '/api/session');
  const failure = classifyResponse(first, options.now ?? Date.now);
  if (failure) return failure;
  const session = assignedSession(first.text);
  const vmState = publicVmState(session.vm_state);
  const healthy: SessionProbeResult = { state: 'healthy', ...(vmState ? { vmState } : {}) };
  if (!options.wakeVm || !session.vm_id || !vmState || !SLEEPING_STATES.has(vmState)) return healthy;
  const wake = await exchange(options, 'POST', '/api/hatch/vm/wake', {
    vm_id: session.vm_id, retry_count: 0, connect_attempt_id: (options.uuid ?? randomUUID)(),
  });
  const wakeFailure = classifyResponse(wake, options.now ?? Date.now, true);
  if (wakeFailure) return { ...wakeFailure, vmState };
  const verified = await exchange(options, 'GET', '/api/session');
  const verifyFailure = classifyResponse(verified, options.now ?? Date.now);
  if (verifyFailure) return verifyFailure;
  const final = assignedSession(verified.text);
  const finalVmState = publicVmState(final.vm_state);
  return final.vm_state === 'RUNNING'
    ? { state: 'healthy', vmState: 'RUNNING' }
    : { state: 'unknown', error: 'wake_unconfirmed', ...(finalVmState ? { vmState: finalVmState } : {}) };
}

interface AssignedSession { status: 'assigned'; vm_id?: string; vm_state?: string }
function assignedSession(text: string): AssignedSession {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ProbeFailure('invalid_response'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('status' in value) || value.status !== 'assigned'
    || ('vm_id' in value && typeof value.vm_id !== 'string') || ('vm_state' in value && typeof value.vm_state !== 'string')) {
    throw new ProbeFailure('invalid_response');
  }
  return value as AssignedSession;
}

interface Reply { status: number; headers: SessionHeaders; text: string }
function classifyResponse(reply: Reply, now: () => number, wake = false): SessionProbeResult | undefined {
  if (reply.status === 200 || (wake && reply.status >= 200 && reply.status < 300)) return undefined;
  if (reply.status === 401) return { state: 'auth_expired', error: 'auth_expired' };
  if (reply.status === 403) return { state: 'blocked', error: 'blocked' };
  if (reply.status === 429) {
    const retryAfterMs = retryAfter(reply.headers, now());
    return { state: 'error', error: 'rate_limited', ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  }
  return reply.status >= 500 && reply.status <= 599
    ? { state: 'error', error: 'upstream_error' }
    : { state: 'unknown', error: 'unexpected_status' };
}

function header(headers: SessionHeaders, name: string): string | undefined {
  if ('get' in headers && typeof headers.get === 'function') return headers.get(name) ?? undefined;
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  return Array.isArray(value) ? value[0] : value === undefined ? undefined : String(value);
}
function retryAfter(headers: SessionHeaders, now: number): number | undefined {
  const value = header(headers, 'retry-after')?.trim();
  if (!value) return undefined;
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isNaN(ms) ? undefined : Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms));
}

class ProbeFailure extends Error {
  constructor(readonly code: SessionProbeError) { super(code); }
}

async function exchange(options: SessionProbeOptions, method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<Reply> {
  if (options.signal?.aborted) throw new ProbeFailure('cancelled');
  const controller = new AbortController();
  let reply: SessionResponse | undefined;
  let failure: SessionProbeError = 'cancelled';
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { failure = 'timeout'; controller.abort(); }, SESSION_REQUEST_TIMEOUT_MS);
  timer.unref?.();
  let onAbort: () => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => { dispose(reply); reject(new ProbeFailure(failure)); };
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const operation = (async () => {
    reply = await options.request(method, path, body, controller.signal);
    if (controller.signal.aborted) { dispose(reply); throw new ProbeFailure(failure); }
    const status = reply.statusCode ?? reply.status ?? 0;
    // Error/redirect bodies are untrusted and irrelevant; never buffer or reflect them.
    if (status !== 200 && !(method === 'POST' && status >= 200 && status < 300)) {
      dispose(reply);
      return { status, headers: reply.headers, text: '' };
    }
    const text = await boundedText(reply, controller.signal);
    if (controller.signal.aborted) throw new ProbeFailure(failure);
    return { status, headers: reply.headers, text };
  })();
  try { return await Promise.race([operation, cancelled]); }
  finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

async function boundedText(response: SessionResponse, signal: AbortSignal): Promise<string> {
  const declaredLength = Number(header(response.headers, 'content-length'));
  if (declaredLength > MAX_SESSION_RESPONSE_BYTES) { dispose(response); throw new ProbeFailure('response_too_large'); }
  if (response.body && 'getReader' in response.body && typeof response.body.getReader === 'function') {
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const abort = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener('abort', abort, { once: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      if (signal.aborted) throw new ProbeFailure('cancelled');
      for (;;) {
        const { done, value } = await reader.read();
        if (signal.aborted) throw new ProbeFailure('cancelled');
        if (done) break;
        const data = Buffer.from(value);
        bytes += data.byteLength;
        if (bytes > MAX_SESSION_RESPONSE_BYTES) throw new ProbeFailure('response_too_large');
        chunks.push(data);
      }
      return Buffer.concat(chunks, bytes).toString('utf8');
    } catch (error) {
      void reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      reader.releaseLock();
    }
  }
  if (response.body && Symbol.asyncIterator in response.body) {
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        if (signal.aborted) throw new ProbeFailure('cancelled');
        const data = Buffer.from(chunk);
        bytes += data.byteLength;
        if (bytes > MAX_SESSION_RESPONSE_BYTES) throw new ProbeFailure('response_too_large');
        chunks.push(data);
      }
      return Buffer.concat(chunks, bytes).toString('utf8');
    } catch (error) { dispose(response); throw error; }
  }
  const text = response.text ? await response.text() : '';
  if (Buffer.byteLength(text, 'utf8') > MAX_SESSION_RESPONSE_BYTES) throw new ProbeFailure('response_too_large');
  return text;
}

function dispose(response: SessionResponse | undefined): void {
  const stream = response?.body as (Partial<Readable> & { cancel?: () => Promise<void> }) | null | undefined;
  if (stream?.destroy) {
    // Undici emits UND_ERR_ABORTED when an unread body is destroyed. Consume only
    // this disposed stream's terminal error; the HTTP/probe classification stays intact.
    stream.once?.('error', () => undefined);
    stream.destroy();
  } else if (stream?.cancel) void stream.cancel().catch(() => undefined);
}
