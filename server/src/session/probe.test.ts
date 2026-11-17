import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probeSession, type SessionRequest, type SessionResponse } from './probe.js';

const EPOCH = Date.parse('2026-11-16T12:00:00Z');
const UUID = '25239ab6-7043-43cf-80dd-d1d22736be0f';
const response = (data: unknown, status = 200, headers: Record<string, string> = {}): SessionResponse => ({
  statusCode: status, headers, body: Readable.from([JSON.stringify(data)]),
});
function fixture(responses: SessionResponse[]) {
  const calls: { method: string; path: string; body: unknown; signal: AbortSignal | undefined }[] = [];
  const request: SessionRequest = async (method, path, body, signal) => {
    calls.push({ method, path, body, signal });
    const next = responses.shift();
    if (!next) throw new Error('Unexpected extra request');
    return next;
  };
  return { request, calls };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(EPOCH); });
afterEach(() => { vi.useRealTimers(); });

describe('probeSession protocol', () => {
  it('checks assigned sessions without exposing VM IDs, cookies or inventing expiry', async () => {
    const f = fixture([response({ status: 'assigned', vm_id: 'private-vm', vm_state: 'RUNNING', token: 'private-token' })]);
    const result = await probeSession({ request: f.request, hasViableCookies: true, wakeVm: false });
    expect(result).toEqual({ state: 'healthy', vmState: 'RUNNING', cookieExpiresAt: null });
    expect(f.calls.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: 'GET', path: '/api/session', body: undefined },
    ]);
    expect(f.calls[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([null, [], 'assigned', {}, { status: 'ready' }, { status: 'assigned', vm_id: 42 }, { status: 'assigned', vm_state: null }])(
    'keeps malformed or unassigned response %j unknown', async (data) => {
      const f = fixture([response(data)]);
      const result = await probeSession({ request: f.request, hasViableCookies: true, wakeVm: true });
      expect(result.state).toBe('unknown');
      expect(f.calls).toHaveLength(1);
    },
  );

  it('does not perform a request without a viable account authentication cookie', async () => {
    const f = fixture([]);
    expect(await probeSession({ request: f.request, hasViableCookies: false, wakeVm: true, cookieExpiresAt: EPOCH - 1 }))
      .toMatchObject({ state: 'auth_expired', error: 'no_viable_cookie', cookieExpiresAt: EPOCH - 1 });
    expect(f.calls).toEqual([]);
  });

  it('reports only actual expiry read after account cookie rotation', async () => {
    let expiry = EPOCH + 30_000;
    const result = await probeSession({ hasViableCookies: true, wakeVm: false, cookieExpiresAt: () => expiry,
      request: async () => { expiry = EPOCH + 90_000; return response({ status: 'assigned' }); },
    });
    expect(result.cookieExpiresAt).toBe(EPOCH + 90_000);
  });

  it('wakes an explicitly opted-in sleeping VM and requires a second assigned RUNNING GET', async () => {
    const f = fixture([
      response({ status: 'assigned', vm_id: 'private-vm', vm_state: 'STOPPED' }),
      response({ success: true }),
      response({ status: 'assigned', vm_id: 'private-vm', vm_state: 'RUNNING' }),
    ]);
    expect(await probeSession({ request: f.request, hasViableCookies: true, wakeVm: true, uuid: () => UUID }))
      .toMatchObject({ state: 'healthy', vmState: 'RUNNING' });
    expect(f.calls.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: 'GET', path: '/api/session', body: undefined },
      { method: 'POST', path: '/api/hatch/vm/wake', body: { vm_id: 'private-vm', retry_count: 0, connect_attempt_id: UUID } },
      { method: 'GET', path: '/api/session', body: undefined },
    ]);
  });

  it.each(['STOPPED', 'STARTING'])('does not equate an accepted wake with confirmed RUNNING (%s)', async (vm_state) => {
    const f = fixture([response({ status: 'assigned', vm_id: 'private-vm', vm_state: 'STOPPED' }), response({}), response({ status: 'assigned', vm_state })]);
    expect(await probeSession({ request: f.request, hasViableCookies: true, wakeVm: true }))
      .toMatchObject({ state: 'unknown', error: 'wake_unconfirmed', vmState: vm_state });
  });

  it.each(['RUNNING', 'DISABLED', 'STARTING', 'private-token', undefined])('does not wake a non-sleeping or unknown VM state %s', async (vm_state) => {
    const f = fixture([response({ status: 'assigned', vm_id: 'private-vm', vm_state })]);
    const result = await probeSession({ request: f.request, hasViableCookies: true, wakeVm: true });
    expect(result.state).toBe('healthy');
    expect(f.calls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it.each([[401, 'auth_expired', 'auth_expired'], [403, 'blocked', 'blocked'], [500, 'error', 'upstream_error'], [302, 'unknown', 'unexpected_status']] as const)(
    'classifies HTTP %i without reflecting body or following redirects', async (status, state, error) => {
      const f = fixture([response({ cookie: 'PRIVATE_COOKIE' }, status, { Location: 'https://private.invalid/' })]);
      expect(await probeSession({ request: f.request, hasViableCookies: true, wakeVm: false }))
        .toEqual({ state, error, cookieExpiresAt: null });
      expect(f.calls).toHaveLength(1);
    },
  );

  it.each([['120', 120_000], ['9999999999999999999999999', 3_600_000], ['Mon, 16 Nov 2026 12:02:00 GMT', 120_000], ['bad', undefined]])(
    'parses and caps Retry-After %s', async (header, retryAfterMs) => {
      const f = fixture([response({}, 429, { 'Retry-After': header })]);
      const result = await probeSession({ request: f.request, hasViableCookies: true, wakeVm: false });
      expect(result).toMatchObject({ state: 'error', error: 'rate_limited' });
      expect(result.retryAfterMs).toBe(retryAfterMs);
    },
  );

  it('supports fetch-style text responses and rejects malformed JSON', async () => {
    const f = fixture([{ status: 200, headers: new Headers(), text: async () => '{broken' }]);
    expect(await probeSession({ request: f.request, hasViableCookies: true, wakeVm: false }))
      .toMatchObject({ state: 'unknown', error: 'invalid_response' });
  });

  it('bounds streamed responses by bytes and destroys oversized streams', async () => {
    const body = Readable.from([Buffer.alloc(65_537, 'a')]);
    const f = fixture([{ statusCode: 200, headers: {}, body }]);
    expect(await probeSession({ request: f.request, hasViableCookies: true, wakeVm: false }))
      .toMatchObject({ state: 'unknown', error: 'response_too_large' });
    expect(body.destroyed).toBe(true);
  });

  it('checks a 64KiB byte limit even on fetch text fallback and multibyte characters', async () => {
    const f = fixture([{ status: 200, headers: {}, text: async () => JSON.stringify({ status: 'assigned', unused: '好'.repeat(23_000) }) }]);
    expect(await probeSession({ request: f.request, hasViableCookies: true, wakeVm: false }))
      .toMatchObject({ state: 'unknown', error: 'response_too_large' });
  });

  it('times out an ignored request after 12 seconds and aborts its signal', async () => {
    let signal: AbortSignal | undefined;
    const pending = probeSession({ hasViableCookies: true, wakeVm: false,
      request: (_method, _path, _body, incoming) => { signal = incoming; return new Promise(() => undefined); },
    });
    await vi.advanceTimersByTimeAsync(11_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ state: 'error', error: 'timeout' });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a stalled stream immediately with no wake request', async () => {
    const controller = new AbortController();
    const body = new Readable({ read() {} });
    const f = fixture([{ statusCode: 200, headers: {}, body }]);
    const pending = probeSession({ request: f.request, hasViableCookies: true, wakeVm: true, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await pending).toMatchObject({ state: 'error', error: 'cancelled' });
    expect(body.destroyed).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not send a sleeping VM wake without the explicit opt-in flag', async () => {
    const f = fixture([response({ status: 'assigned', vm_id: 'private-vm', vm_state: 'STOPPED' })]);
    expect(await probeSession({ request: f.request, hasViableCookies: true, wakeVm: false }))
      .toMatchObject({ state: 'healthy', vmState: 'STOPPED' });
    expect(f.calls).toHaveLength(1);
  });

  it('does not confirm awake from RUNNING on an unassigned session after wake', async () => {
    const f = fixture([response({ status: 'assigned', vm_id: 'private-vm', vm_state: 'STOPPED' }), response({}), response({ status: 'pending', vm_state: 'RUNNING' })]);
    expect(await probeSession({ request: f.request, hasViableCookies: true, wakeVm: true }))
      .toMatchObject({ state: 'unknown', error: 'invalid_response' });
  });

  it('propagates authentication expiry at the wake step without a verification request', async () => {
    const f = fixture([response({ status: 'assigned', vm_id: 'private-vm', vm_state: 'STOPPED' }), response({}, 401)]);
    expect(await probeSession({ request: f.request, hasViableCookies: true, wakeVm: true }))
      .toMatchObject({ state: 'auth_expired', error: 'auth_expired' });
    expect(f.calls).toHaveLength(2);
  });

  it('does no work for a pre-aborted caller signal', async () => {
    const f = fixture([]);
    const controller = new AbortController(); controller.abort();
    expect(await probeSession({ request: f.request, hasViableCookies: true, wakeVm: true, signal: controller.signal }))
      .toMatchObject({ state: 'error', error: 'cancelled' });
    expect(f.calls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('destroys a response that arrives after the request deadline', async () => {
    let resolve!: (response: SessionResponse) => void;
    const pending = probeSession({ request: () => new Promise((done) => { resolve = done; }), hasViableCookies: true, wakeVm: true });
    await vi.advanceTimersByTimeAsync(12_000);
    expect((await pending).error).toBe('timeout');
    const body = new Readable({ read() {} });
    resolve({ statusCode: 200, headers: {}, body });
    await vi.advanceTimersByTimeAsync(0);
    expect(body.destroyed).toBe(true);
  });

  it('accepts a response exactly 64KiB even when UTF-8 bytes are split across chunks', async () => {
    const data = Buffer.from('{"status":"assigned","unused":"好' + 'a'.repeat(65500) + '"}');
    expect(data.byteLength).toBe(65_536);
    const f = fixture([{ statusCode: 200, headers: {}, body: Readable.from([data.subarray(0, 32), data.subarray(32)]) }]);
    expect((await probeSession({ request: f.request, hasViableCookies: true, wakeVm: false })).state).toBe('healthy');
  });

  it('cancels a locked fetch response stream when its caller aborts', async () => {
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const pending = probeSession({ request: async () => new Response(body), hasViableCookies: true, wakeVm: false, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect((await pending).error).toBe('cancelled');
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  it('disposes a forbidden response whose destroy emits an abort error without an uncaught exception', async () => {
    const abortError = Object.assign(new Error('Response body aborted'), { code: 'UND_ERR_ABORTED' });
    const body = new Readable({
      read() {},
      destroy(_error, callback) { callback(abortError); },
    });
    const f = fixture([{ statusCode: 403, headers: {}, body }]);
    expect(await probeSession({ request: f.request, hasViableCookies: true, wakeVm: false }))
      .toEqual({ state: 'blocked', error: 'blocked', cookieExpiresAt: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(body.destroyed).toBe(true);
    expect(body.errored).toBe(abortError);
  });

  it('uses fixed error codes for network failures containing credentials', async () => {
    expect(await probeSession({ request: async () => { throw new Error('https://PRIVATE_TOKEN:PRIVATE_COOKIE@proxy'); }, hasViableCookies: true, wakeVm: false }))
      .toEqual({ state: 'error', error: 'network_error', cookieExpiresAt: null });
  });
});
