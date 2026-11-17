import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionMaintenance, type MaintenanceAccount, type ProbeContext, type SessionMaintenanceOptions } from './maintenance.js';
import type { SessionProbeResult } from './probe.js';

const EPOCH = 1_800_000_000_000;
const MINUTE = 60_000;
function account(id: number, enabled = true, intervalMinutes = 30, wakeVm = false): MaintenanceAccount {
  return { id, keepAlive: { enabled, intervalMinutes, wakeVm } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const instances: SessionMaintenance[] = [];
function setup(accounts: MaintenanceAccount[], probeAccount: SessionMaintenanceOptions['probeAccount'], options: Partial<SessionMaintenanceOptions> = {}) {
  const records = new Map(accounts.map((a) => [a.id, a]));
  const maintenance = new SessionMaintenance({
    listAccounts: () => [...records.values()], getAccount: (id) => records.get(id), probeAccount,
    now: () => Date.now(), jitter: () => 0, ...options,
  });
  instances.push(maintenance);
  return { maintenance, records };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(EPOCH); });
afterEach(() => { for (const instance of instances.splice(0)) instance.stop(); vi.useRealTimers(); });

describe('SessionMaintenance scheduling', () => {
  it('defaults to disabled and never schedules accounts without explicit opt-in', async () => {
    const seen: number[] = [];
    const { maintenance } = setup([{ id: 1 }, account(2, false)], async (a) => { seen.push(a.id); return { state: 'healthy' }; });
    maintenance.start();
    maintenance.start();
    await vi.advanceTimersByTimeAsync(24 * 60 * MINUTE);
    expect(seen).toEqual([]);
    expect(maintenance.status(1)).toEqual({ state: 'disabled', lastCheck: null, lastSuccess: null, nextCheck: null, lastError: null, vmState: null, cookieExpiresAt: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts at the opted-in interval and reads viable cookies in the probe stage', async () => {
    const seen: number[] = [];
    const { maintenance } = setup([account(1)], async (a) => { seen.push(a.id); return { state: 'auth_expired', error: 'no_viable_cookie', cookieExpiresAt: EPOCH - 1 }; });
    maintenance.start();
    expect(maintenance.status(1).nextCheck).toBe(EPOCH + 30 * MINUTE);
    await vi.advanceTimersByTimeAsync(30 * MINUTE - 1);
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual([1]);
    expect(maintenance.status(1)).toMatchObject({ state: 'auth_expired', nextCheck: null, lastCheck: EPOCH + 30 * MINUTE, cookieExpiresAt: EPOCH - 1 });
  });

  it('uses a six-hour fallback interval and bounds persisted out-of-range preferences', () => {
    const { maintenance } = setup([account(1, true, NaN), account(2, true, 1), account(3, true, 9999)], async () => ({ state: 'healthy' }));
    maintenance.start();
    expect(maintenance.status(1).nextCheck).toBe(EPOCH + 360 * MINUTE);
    expect(maintenance.status(2).nextCheck).toBe(EPOCH + 30 * MINUTE);
    expect(maintenance.status(3).nextCheck).toBe(EPOCH + 1440 * MINUTE);
  });

  it('deduplicates manual and scheduled work and never exceeds two active accounts', async () => {
    const jobs = new Map<number, ReturnType<typeof deferred<SessionProbeResult>>>();
    const seen: number[] = [];
    const { maintenance } = setup([account(1), account(2), account(3)], (a) => {
      seen.push(a.id); const job = deferred<SessionProbeResult>(); jobs.set(a.id, job); return job.promise;
    });
    maintenance.start();
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(seen).toEqual([1, 2]);
    expect(maintenance.status(1).state).toBe('checking');
    const duplicate = maintenance.check(1);
    expect(maintenance.check(1)).toBe(duplicate);
    const queued = maintenance.check(3);
    jobs.get(1)!.resolve({ state: 'healthy', vmState: 'RUNNING' });
    await duplicate;
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([1, 2, 3]);
    jobs.get(2)!.resolve({ state: 'healthy' });
    jobs.get(3)!.resolve({ state: 'healthy' });
    await queued;
    expect(maintenance.status(1).lastSuccess).toBe(EPOCH + 30 * MINUTE);
  });

  it('allows manual disabled checks but passes only the stored explicit wake flag', async () => {
    const seen: boolean[] = [];
    const { maintenance } = setup([account(1, false), account(2, false, 30, true)], async (_a, context) => { seen.push(context.wakeVm); return { state: 'healthy' }; });
    maintenance.start();
    expect((await maintenance.check(1)).state).toBe('healthy');
    expect((await maintenance.check(2)).state).toBe('healthy');
    expect(seen).toEqual([false, true]);
    expect(maintenance.status(1).nextCheck).toBeNull();
  });

  it('suspends 401 across stop/start until manual check or configuration resumes it', async () => {
    let checks = 0;
    const { maintenance } = setup([account(1)], async () => { checks++; return { state: 'auth_expired', error: 'auth_expired' }; });
    maintenance.start();
    await maintenance.check(1);
    maintenance.stop(); maintenance.start();
    await vi.advanceTimersByTimeAsync(24 * 60 * MINUTE);
    expect(checks).toBe(1);
    expect(maintenance.status(1).nextCheck).toBeNull();
    await maintenance.check(1);
    expect(checks).toBe(2);
    maintenance.configure(1);
    expect(maintenance.status(1).state).toBe('unknown');
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(checks).toBe(3);
  });

  it('backs off exponentially to one hour and resets after success', async () => {
    let checks = 0;
    const { maintenance } = setup([account(1)], async () => (++checks <= 8 ? { state: 'error', error: 'upstream_error' } : { state: 'healthy' }));
    maintenance.start();
    await maintenance.check(1);
    for (const delay of [1, 2, 4, 8, 16, 32, 60, 60]) {
      expect(maintenance.status(1).nextCheck).toBe(Date.now() + delay * MINUTE);
      await vi.advanceTimersByTimeAsync(delay * MINUTE);
    }
    expect(maintenance.status(1)).toMatchObject({ state: 'healthy', nextCheck: Date.now() + 30 * MINUTE, lastError: null });
  });

  it('respects capped Retry-After even when jitter would otherwise shorten the delay', async () => {
    let retryAfterMs = 120_000;
    const { maintenance } = setup([account(1)], async () => ({ state: 'error', error: 'rate_limited', retryAfterMs }), { jitter: () => -1 });
    maintenance.start();
    await maintenance.check(1);
    expect(maintenance.status(1).nextCheck).toBe(Date.now() + 120_000);
    retryAfterMs = 99_000_000;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(maintenance.status(1).nextCheck).toBe(Date.now() + 3_600_000);
  });

  it('does not let repeated manual checks bypass an upstream Retry-After window', async () => {
    let checks = 0;
    const { maintenance } = setup([account(1, false)], async () => { checks++; return { state: 'error', error: 'rate_limited', retryAfterMs: 120_000 }; });
    await maintenance.check(1);
    await maintenance.check(1);
    expect(checks).toBe(1);
    await vi.advanceTimersByTimeAsync(120_000);
    await maintenance.check(1);
    expect(checks).toBe(2);
  });

  it.each([undefined, 0])('rate-limits manual checks by fallback backoff when Retry-After is %s', async (retryAfterMs) => {
    let checks = 0;
    const { maintenance } = setup([account(1, false)], async () => {
      checks++;
      return { state: 'error', error: 'rate_limited', ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
    });
    await maintenance.check(1);
    await maintenance.check(1);
    expect(checks).toBe(1);
    await vi.advanceTimersByTimeAsync(MINUTE);
    await maintenance.check(1);
    expect(checks).toBe(2);
    await vi.advanceTimersByTimeAsync(MINUTE);
    await maintenance.check(1);
    expect(checks).toBe(2);
    await vi.advanceTimersByTimeAsync(MINUTE);
    await maintenance.check(1);
    expect(checks).toBe(3);
  });

  it('keeps the last successful timestamp when a later probe is blocked', async () => {
    let success = true;
    const { maintenance } = setup([account(1)], async () => success ? { state: 'healthy', cookieExpiresAt: EPOCH + MINUTE } : { state: 'blocked', error: 'blocked' });
    await maintenance.check(1);
    success = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await maintenance.check(1)).toMatchObject({ state: 'blocked', lastCheck: EPOCH + 1000, lastSuccess: EPOCH, cookieExpiresAt: null });
  });

  it('a late old generation cannot replace the status from its replacement probe', async () => {
    const first = deferred<SessionProbeResult>();
    let checks = 0;
    const { maintenance } = setup([account(1)], async () => ++checks === 1 ? first.promise : { state: 'healthy', vmState: 'RUNNING' });
    const old = maintenance.check(1);
    maintenance.invalidate(1);
    await old;
    expect((await maintenance.check(1)).state).toBe('healthy');
    first.resolve({ state: 'auth_expired', error: 'auth_expired' });
    await vi.advanceTimersByTimeAsync(0);
    expect(maintenance.status(1)).toMatchObject({ state: 'healthy', vmState: 'RUNNING' });
  });

  it('keeps forbidden responses blocked with backoff instead of suspending as expired', async () => {
    const { maintenance } = setup([account(1)], async () => ({ state: 'blocked', error: 'blocked' }));
    maintenance.start();
    await maintenance.check(1);
    expect(maintenance.status(1)).toMatchObject({ state: 'blocked', nextCheck: EPOCH + MINUTE, lastSuccess: null });
  });

  it('guards cancelled generations so clear/import/delete never publish late state or cookie writes', async () => {
    const job = deferred<SessionProbeResult>();
    let captured: ProbeContext | undefined;
    let simulatedCookieWrites = 0;
    const { maintenance, records } = setup([account(1)], async (_a, context) => {
      captured = context;
      const result = await job.promise;
      if (context.isCurrent() && !context.signal.aborted) simulatedCookieWrites++;
      return result;
    });
    maintenance.start();
    const pending = maintenance.check(1);
    maintenance.invalidate(1);
    expect(captured!.signal.aborted).toBe(true);
    expect(captured!.isCurrent()).toBe(false);
    expect(maintenance.status(1)).toMatchObject({ state: 'unknown', nextCheck: null, lastCheck: null });
    records.delete(1);
    maintenance.invalidate(1);
    expect(maintenance.status(1).state).toBe('disabled');
    await pending;
    job.resolve({ state: 'healthy', cookieExpiresAt: EPOCH + 999999 });
    await vi.advanceTimersByTimeAsync(0);
    expect(simulatedCookieWrites).toBe(0);
    expect(maintenance.status(1)).toMatchObject({ state: 'disabled', cookieExpiresAt: null, lastSuccess: null });
  });

  it('cancels disable while checking and drains a queued different account', async () => {
    let oldSignal: AbortSignal | undefined;
    const seen: number[] = [];
    const { maintenance, records } = setup([account(1), account(2)], (a, context) => {
      seen.push(a.id);
      if (a.id === 1) { oldSignal = context.signal; return new Promise(() => undefined); }
      return Promise.resolve({ state: 'healthy' });
    }, { maxConcurrent: 1 });
    maintenance.start();
    const first = maintenance.check(1);
    const second = maintenance.check(2);
    records.set(1, account(1, false));
    maintenance.configure(1);
    expect(oldSignal!.aborted).toBe(true);
    await first; await second;
    expect(seen).toEqual([1, 2]);
    expect(maintenance.status(1).state).toBe('disabled');
  });

  it('skips deleted queued accounts before they reach probeAccount', async () => {
    const job = deferred<SessionProbeResult>();
    const seen: number[] = [];
    const { maintenance, records } = setup([account(1), account(2)], (a) => { seen.push(a.id); return job.promise; }, { maxConcurrent: 1 });
    const first = maintenance.check(1), second = maintenance.check(2);
    records.delete(2); maintenance.invalidate(2);
    job.resolve({ state: 'healthy' });
    await first; await second;
    expect(seen).toEqual([1]);
  });

  it('bounds an uncooperative operation, frees its slot, and makes late writes stale', async () => {
    const job = deferred<SessionProbeResult>();
    let oldContext: ProbeContext | undefined;
    const { maintenance } = setup([account(1), account(2)], (a, context) => {
      if (a.id === 1) { oldContext = context; return job.promise; }
      return Promise.resolve({ state: 'healthy' });
    }, { maxConcurrent: 1, operationTimeoutMs: 500 });
    const first = maintenance.check(1), second = maintenance.check(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(await first).toMatchObject({ state: 'error', lastError: 'Session check timed out' });
    expect((await second).state).toBe('healthy');
    expect(oldContext!.signal.aborted).toBe(true);
    expect(oldContext!.isCurrent()).toBe(false);
    job.resolve({ state: 'healthy' });
    await vi.advanceTimersByTimeAsync(0);
    expect(maintenance.status(1).state).toBe('error');
  });

  it('stops all timers and cancels in-flight and queued work without restarting', async () => {
    const signals: AbortSignal[] = [];
    const { maintenance } = setup([account(1), account(2), account(3)], (_a, context) => { signals.push(context.signal); return new Promise(() => undefined); });
    maintenance.start();
    const promises = [maintenance.check(1), maintenance.check(2), maintenance.check(3)];
    maintenance.stop();
    await Promise.all(promises);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(signals).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * 60 * MINUTE);
    expect(signals).toHaveLength(2);
    expect(maintenance.status(1).nextCheck).toBeNull();
  });

  it('unrefs scheduler and operation timers so they do not hold the process alive', async () => {
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    const { maintenance } = setup([account(1)], () => new Promise(() => undefined));
    maintenance.start();
    const pending = maintenance.check(1);
    expect(timerSpy.mock.results.length).toBeGreaterThanOrEqual(2);
    for (const result of timerSpy.mock.results) expect(result.value.hasRef()).toBe(false);
    maintenance.stop(); await pending;
    timerSpy.mockRestore();
  });

  it('sanitizes callback errors and arbitrary VM labels at the public status boundary', async () => {
    const { maintenance } = setup([account(1)], async () => ({ state: 'error', error: 'PRIVATE_TOKEN' as never, vmState: 'PRIVATE_VM', cookieExpiresAt: Infinity }));
    const result = await maintenance.check(1);
    expect(result).toMatchObject({ state: 'error', lastError: 'Session check failed', vmState: null, cookieExpiresAt: null });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    result.state = 'healthy';
    expect(maintenance.status(1).state).toBe('error');
  });

  it('notifies final/configured/invalidated states once without emitting on reads or entering checks', async () => {
    const changes: { id: number; state: string; nextCheck: number | null }[] = [];
    const job = deferred<SessionProbeResult>();
    const { maintenance } = setup([account(1)], () => job.promise, {
      onChange: (id, status) => { changes.push({ id, state: status.state, nextCheck: status.nextCheck }); status.state = 'error'; },
    });
    maintenance.start();
    maintenance.configure(1);
    expect(changes).toEqual([{ id: 1, state: 'unknown', nextCheck: EPOCH + 30 * MINUTE }]);
    maintenance.status(1);
    const pending = maintenance.check(1);
    expect(changes).toHaveLength(1);
    job.resolve({ state: 'healthy' });
    await pending;
    expect(changes).toHaveLength(2);
    expect(changes[1]!.state).toBe('healthy');
    expect(maintenance.status(1).state).toBe('healthy');
    maintenance.invalidate(1);
    expect(changes).toHaveLength(3);
    expect(changes[2]).toEqual({ id: 1, state: 'unknown', nextCheck: null });
  });

  it('isolates notification failures from status updates and promise completion', async () => {
    const { maintenance } = setup([account(1)], async () => ({ state: 'healthy' }), {
      onChange: () => { throw new Error('subscriber failed'); },
    });
    maintenance.start();
    expect(() => maintenance.configure(1)).not.toThrow();
    expect((await maintenance.check(1)).state).toBe('healthy');
    expect(() => maintenance.invalidate(1)).not.toThrow();
  });

  it('preserves the upstream cooldown through explicit config changes and invalidation', async () => {
    let checks = 0;
    const { maintenance } = setup([account(1)], async () => { checks++; return { state: 'error', error: 'rate_limited', retryAfterMs: 3_600_000 }; });
    maintenance.start();
    await maintenance.check(1);
    maintenance.invalidate(1);
    maintenance.configure(1);
    expect(maintenance.status(1).nextCheck).toBe(EPOCH + 3_600_000);
    await maintenance.check(1);
    expect(checks).toBe(1);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(checks).toBe(2);
  });

  it('turns thrown callback errors into fixed public errors', async () => {
    const { maintenance } = setup([account(1)], async () => { throw new Error('https://PRIVATE_USER:PRIVATE_PASSWORD@proxy'); });
    expect(await maintenance.check(1)).toMatchObject({ state: 'error', lastError: 'Session check failed' });
  });
});
