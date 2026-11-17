import { MAX_RETRY_AFTER_MS, publicVmState, type SessionProbeError, type SessionProbeResult, type SessionProbeState } from './probe.js';

export interface KeepAlivePreferences { enabled: boolean; intervalMinutes: number; wakeVm: boolean }
export interface MaintenanceAccount { readonly id: number; keepAlive?: KeepAlivePreferences }
export interface ProbeContext {
  signal: AbortSignal;
  wakeVm: boolean;
  /** Check again immediately before committing any jar changes; abort alone is not a write guard. */
  isCurrent(): boolean;
}
export interface SessionStatus {
  state: SessionProbeState | 'disabled' | 'checking';
  lastCheck: number | null;
  lastSuccess: number | null;
  nextCheck: number | null;
  lastError: string | null;
  vmState: string | null;
  cookieExpiresAt: number | null;
}
export interface SessionMaintenanceOptions<A extends MaintenanceAccount = MaintenanceAccount> {
  listAccounts(): readonly A[];
  getAccount(id: number): A | undefined;
  probeAccount(account: A, context: ProbeContext): Promise<SessionProbeResult>;
  now?: () => number;
  /** Fractional jitter in [-1,1], multiplied by 10% of the delay; zero is deterministic. */
  jitter?: () => number;
  /** Clamped to 1..2. */
  maxConcurrent?: number;
  /** Bounds the complete GET / optional POST / verification GET operation. Default 38s. */
  operationTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Completion/configuration/invalidation only; observer failures never interrupt maintenance. */
  onChange?: (id: number, status: SessionStatus) => void;
}
interface Entry { generation: number; failures: number; suspended: boolean; retryNotBefore: number; status: SessionStatus }
interface Job {
  id: number;
  generation: number;
  manual: boolean;
  active: boolean;
  finished: boolean;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout> | undefined;
  promise: Promise<SessionStatus>;
  resolve: (status: SessionStatus) => void;
}
const MINUTE = 60_000;
export const SESSION_ERROR_MESSAGES: Readonly<Record<SessionProbeError, string>> = Object.freeze({
  no_viable_cookie: 'No viable authentication cookie', auth_expired: 'Session authentication expired',
  blocked: 'Upstream access blocked; authentication unconfirmed', rate_limited: 'Upstream rate limited',
  upstream_error: 'Upstream session service failed', unexpected_status: 'Unexpected upstream session status',
  invalid_response: 'Session response was not assigned or was malformed', response_too_large: 'Session response exceeded size limit',
  wake_unconfirmed: 'VM wake was not confirmed', network_error: 'Session check failed',
  timeout: 'Session check timed out', cancelled: 'Session check cancelled',
});

/** In-memory lifecycle owner. Persistence, account changes and network transport remain injected. */
export class SessionMaintenance<A extends MaintenanceAccount = MaintenanceAccount> {
  private readonly entries = new Map<number, Entry>();
  private readonly jobs = new Map<number, Job>();
  private readonly queue: Job[] = [];
  private readonly now: () => number;
  private readonly jitter: () => number;
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private stopped = false;
  private active = 0;

  constructor(private readonly options: SessionMaintenanceOptions<A>) {
    this.now = options.now ?? Date.now;
    this.jitter = options.jitter ?? (() => Math.random() * 2 - 1);
    this.concurrency = bounded(options.maxConcurrent, 2, 1, 2);
    this.timeoutMs = bounded(options.operationTimeoutMs, 38_000, 1, 120_000);
    this.backoffMaxMs = bounded(options.backoffMaxMs, MAX_RETRY_AFTER_MS, 1, MAX_RETRY_AFTER_MS);
    this.backoffBaseMs = bounded(options.backoffBaseMs, MINUTE, 1, this.backoffMaxMs);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    for (const account of this.options.listAccounts()) {
      const entry = this.entry(account.id);
      const prefs = preferences(account);
      if (prefs.enabled && !entry.suspended && !this.jobs.has(account.id)) {
        entry.status.nextCheck = Math.max(entry.retryNotBefore, this.now() + this.delay(prefs.intervalMinutes * MINUTE));
      }
    }
    this.arm();
  }

  stop(): void {
    this.running = false;
    this.stopped = true;
    this.clearTimer();
    for (const entry of this.entries.values()) {
      entry.generation++;
      entry.status.nextCheck = null;
      if (entry.status.state === 'checking') entry.status.state = 'unknown';
    }
    for (const job of [...this.jobs.values()]) this.cancel(job);
    this.queue.length = 0;
  }

  status(id: number): SessionStatus {
    validId(id);
    if (!this.options.getAccount(id)) return emptyStatus(false);
    return { ...this.entry(id).status };
  }

  /** Manual work bypasses enabled/suspended, but never the stored wake preference or concurrency cap. */
  check(id: number): Promise<SessionStatus> {
    validId(id);
    return this.enqueue(id, true);
  }

  /** Call after a persisted preference update (or deliberate resume); does not mutate the store. */
  configure(id: number): SessionStatus {
    this.reset(id);
    const account = this.options.getAccount(id);
    const entry = this.entry(id);
    if (this.running && account && preferences(account).enabled) {
      entry.status.nextCheck = Math.max(entry.retryNotBefore, this.now() + this.delay(preferences(account).intervalMinutes * MINUTE));
    }
    this.arm();
    this.notify(id);
    return this.status(id);
  }

  /** Call before clearing/deleting/importing a jar or account. Reconfigure after replacement to resume. */
  invalidate(id: number): SessionStatus {
    this.reset(id);
    this.arm();
    this.notify(id);
    return this.status(id);
  }

  private reset(id: number): void {
    validId(id);
    const old = this.entries.get(id);
    this.entries.set(id, { generation: (old?.generation ?? 0) + 1, failures: 0, suspended: false, retryNotBefore: old?.retryNotBefore ?? 0,
      status: emptyStatus(preferences(this.options.getAccount(id)).enabled) });
    const job = this.jobs.get(id);
    if (job) this.cancel(job);
  }

  private notify(id: number): void {
    try { this.options.onChange?.(id, this.status(id)); } catch { /* Observers do not own the maintenance lifecycle. */ }
  }

  private entry(id: number): Entry {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { generation: 0, failures: 0, suspended: false, retryNotBefore: 0, status: emptyStatus(preferences(this.options.getAccount(id)).enabled) };
      this.entries.set(id, entry);
    }
    return entry;
  }

  private enqueue(id: number, manual: boolean): Promise<SessionStatus> {
    const existing = this.jobs.get(id);
    if (existing) return existing.promise;
    const account = this.options.getAccount(id);
    const entry = this.entry(id);
    if (this.stopped || !account || entry.retryNotBefore > this.now() || (!manual && (!this.running || !preferences(account).enabled || entry.suspended))) {
      return Promise.resolve(this.status(id));
    }
    if (manual) entry.suspended = false;
    entry.status.nextCheck = null;
    let resolve!: (status: SessionStatus) => void;
    const promise = new Promise<SessionStatus>((done) => { resolve = done; });
    const job: Job = { id, generation: entry.generation, manual, active: false, finished: false,
      controller: new AbortController(), timer: undefined, promise, resolve };
    this.jobs.set(id, job);
    this.queue.push(job);
    this.drain();
    this.arm();
    return promise;
  }

  private drain(): void {
    while (!this.stopped && this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      if (job.finished) continue;
      const account = this.options.getAccount(job.id);
      if (!account || !this.current(job) || (!job.manual && (!this.running || !preferences(account).enabled))) {
        this.finish(job);
        continue;
      }
      job.active = true;
      this.active++;
      this.entry(job.id).status.state = 'checking';
      const context: ProbeContext = { signal: job.controller.signal, wakeVm: preferences(account).wakeVm,
        isCurrent: () => this.current(job) && !job.controller.signal.aborted && Boolean(this.options.getAccount(job.id)) };
      job.timer = setTimeout(() => {
        job.controller.abort();
        this.finish(job, { state: 'error', error: 'timeout' });
      }, this.timeoutMs);
      job.timer.unref?.();
      try {
        void this.options.probeAccount(account, context).then(
          (result) => this.finish(job, result),
          () => this.finish(job, { state: 'error', error: 'network_error' }),
        );
      } catch { this.finish(job, { state: 'error', error: 'network_error' }); }
    }
  }

  private current(job: Job): boolean {
    return !job.finished && this.entries.get(job.id)?.generation === job.generation && this.jobs.get(job.id) === job;
  }

  private cancel(job: Job): void {
    job.controller.abort();
    this.finish(job);
  }

  private finish(job: Job, result?: SessionProbeResult): void {
    if (job.finished) return;
    const entry = this.entry(job.id);
    const account = this.options.getAccount(job.id);
    const updated = Boolean(result && this.current(job) && account && (job.manual || preferences(account).enabled));
    if (updated) this.apply(entry, account!, result!);
    job.finished = true;
    if (job.timer !== undefined) clearTimeout(job.timer);
    if (job.active) this.active--;
    if (this.jobs.get(job.id) === job) this.jobs.delete(job.id);
    job.resolve(this.status(job.id));
    if (updated) this.notify(job.id);
    this.drain();
    this.arm();
  }

  private apply(entry: Entry, account: A, result: SessionProbeResult): void {
    const state = ['healthy', 'auth_expired', 'blocked', 'unknown', 'error'].includes(result?.state) ? result.state : 'error';
    const checkedAt = this.now();
    entry.status.state = state;
    entry.status.lastCheck = checkedAt;
    if (state === 'healthy') entry.status.lastSuccess = checkedAt;
    entry.status.lastError = state === 'healthy' ? null
      : result.error && Object.hasOwn(SESSION_ERROR_MESSAGES, result.error) ? SESSION_ERROR_MESSAGES[result.error] : 'Session check failed';
    entry.status.vmState = publicVmState(result.vmState) ?? null;
    entry.status.cookieExpiresAt = typeof result.cookieExpiresAt === 'number' && Number.isFinite(result.cookieExpiresAt) && result.cookieExpiresAt >= 0
      ? result.cookieExpiresAt : null;
    entry.failures = state === 'healthy' ? 0 : Math.min(entry.failures + 1, 32);
    entry.suspended = state === 'auth_expired';
    const retryAfterMs = state !== 'healthy' && typeof result.retryAfterMs === 'number' && Number.isFinite(result.retryAfterMs)
      ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, result.retryAfterMs)) : 0;
    const prefs = preferences(account);
    const delay = state === 'healthy' ? this.delay(prefs.intervalMinutes * MINUTE)
      : Math.max(retryAfterMs, this.delay(Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** (entry.failures - 1)), this.backoffMaxMs));
    // A 429 without a usable Retry-After still imposes the same fallback delay
    // on manual checks, including accounts whose automatic maintenance is off.
    entry.retryNotBefore = checkedAt + (result.error === 'rate_limited' ? delay : retryAfterMs);
    entry.status.nextCheck = null;
    if (!this.running || !prefs.enabled || entry.suspended) return;
    entry.status.nextCheck = checkedAt + delay;
  }

  private delay(base: number, cap = 1440 * MINUTE * 1.1): number {
    const sample = this.jitter();
    const jitter = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
    return Math.max(1, Math.min(cap, Math.round(base * (1 + 0.1 * jitter))));
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(): void {
    this.clearTimer();
    if (!this.running) return;
    let earliest = Infinity;
    for (const [id, entry] of this.entries) {
      if (entry.status.nextCheck === null || this.jobs.has(id)) continue;
      const account = this.options.getAccount(id);
      if (!account || !preferences(account).enabled || entry.suspended) {
        entry.status.nextCheck = null;
        continue;
      }
      earliest = Math.min(earliest, entry.status.nextCheck);
    }
    if (!Number.isFinite(earliest)) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const due = [...this.entries].filter(([, entry]) => entry.status.nextCheck !== null && entry.status.nextCheck <= this.now());
      for (const [id, entry] of due) { entry.status.nextCheck = null; void this.enqueue(id, false); }
      this.arm();
    }, Math.max(0, earliest - this.now()));
    this.timer.unref?.();
  }
}

function preferences(account: MaintenanceAccount | undefined): KeepAlivePreferences {
  return { enabled: account?.keepAlive?.enabled === true,
    intervalMinutes: bounded(account?.keepAlive?.intervalMinutes, 360, 30, 1440), wakeVm: account?.keepAlive?.wakeVm === true };
}
function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}
function emptyStatus(enabled: boolean): SessionStatus {
  return { state: enabled ? 'unknown' : 'disabled', lastCheck: null, lastSuccess: null, nextCheck: null, lastError: null, vmState: null, cookieExpiresAt: null };
}
function validId(id: number): void {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid account ID');
}
