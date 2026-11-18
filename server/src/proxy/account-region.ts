import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { JsonStore } from '../storage/json-store.js';
import type { Account, Fingerprint } from '../types.js';
import { localeForCountry, type RegionObservation } from './region-lookup.js';

export interface RegionStatus {
  state: 'disabled' | 'no_proxy' | 'unknown' | 'checking' | 'ready' | 'error';
  checkedAt: number | null;
  ip: string | null;
  countryCode: string | null;
  timezone: string | null;
  locale: string | null;
  error: 'lookup_failed' | 'unsupported_country' | null;
  stale: boolean;
}

export interface AccountRegionManagerOptions {
  getAccount(id: number): Account | undefined;
  dataDir?: string;
  lookup(account: Account, signal: AbortSignal): Promise<RegionObservation>;
  onChange?: (id: number, status: RegionStatus) => void;
  now?: () => number;
}

type RegionMode = 'proxy' | 'manual' | 'native';
// Keep the manager buildable independently of the shared profile schema change.
type RegionFingerprint = Fingerprint & { localeMode?: RegionMode; timezoneMode?: RegionMode };
interface Entry {
  proxyHash: string | null;
  observation: RegionObservation | null;
  observedAt: number | null;
  checkedAt: number | null;
  error: 'lookup_failed' | null;
  retryNotBefore: number;
}
interface Job {
  id: number;
  entry: Entry;
  proxyHash: string;
  controller: AbortController;
  active: boolean;
  finished: boolean;
  promise: Promise<RegionStatus>;
  resolve(status: RegionStatus): void;
}
interface SnapshotRow extends RegionObservation { id: number; proxyHash: string; checkedAt: number }
interface Snapshot { schema: 1; regions: SnapshotRow[] }
const SUCCESS_TTL = 60 * 60_000;
const FAILURE_COOLDOWN = 60_000;
const MAX_QUEUED = 64;
const MAX_SNAPSHOT_ROWS = 1024;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const REGION_UNAVAILABLE = 'Proxy region is unavailable; retry region lookup';

/** Owns cache and cancellation only; all network work remains in the injected lookup. */
export class AccountRegionManager {
  private readonly entries = new Map<number, Entry>();
  private readonly snapshots = new Map<number, SnapshotRow>();
  private readonly jobs = new Map<number, Job>();
  private readonly queue: Job[] = [];
  private readonly now: () => number;
  private readonly store: JsonStore<Snapshot> | undefined;
  private active = 0;
  private stopped = false;
  private draining = false;

  constructor(private readonly options: AccountRegionManagerOptions) {
    this.now = options.now ?? Date.now;
    if (options.dataDir !== undefined) {
      const directory = resolve(options.dataDir);
      this.store = new JsonStore<Snapshot>(join(directory, 'regions.json'), { schema: 1, regions: [] }, (raw) => this.validateSnapshot(raw));
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        chmodSync(directory, 0o700);
        const path = join(directory, 'regions.json');
        try {
          const info = statSync(path);
          if (!info.isFile() || info.size > MAX_SNAPSHOT_BYTES) return;
        } catch (error) {
          if (!isMissingFile(error)) return;
        }
        for (const row of this.store.read().regions) {
          const account = options.getAccount(row.id);
          if (account && proxyHash(account.proxy) === row.proxyHash) this.snapshots.set(row.id, row);
        }
      } catch { /* A cache read failure is never a source of credentials or a substitute for a lookup. */ }
    }
  }

  /** Reads cache only. A proxy mismatch is an invalidation, never a network request. */
  status(id: number): RegionStatus {
    validId(id);
    const account = this.synchronize(id);
    return this.view(id, account);
  }

  /** Force bypasses successful TTL, profile preferences and automatic failure cooldown. */
  ensure(id: number, options: { force?: boolean } = {}): Promise<RegionStatus> {
    validId(id);
    const account = this.synchronize(id);
    const entry = this.entries.get(id);
    if (this.stopped || !account || !entry?.proxyHash) return Promise.resolve(this.view(id, account));
    const existing = this.jobs.get(id);
    if (existing) return existing.promise;
    if (!options.force && !needsAutomatic(account)) return Promise.resolve(this.view(id, account));
    // Explicit operator retries bypass the automatic failure cooldown; automatic
    // scheduling still respects it to avoid hammering a failing proxy/provider.
    if (!options.force && this.now() < entry.retryNotBefore) return Promise.resolve(this.view(id, account));
    if (!options.force && entry.observation && !this.stale(entry) && !entry.error && !unsupportedCountry(account, entry)) {
      return Promise.resolve(this.view(id, account));
    }
    if (this.queue.length >= MAX_QUEUED) {
      this.fail(entry);
      this.notify(id);
      return Promise.resolve(this.view(id, account));
    }
    let resolveJob!: (status: RegionStatus) => void;
    const promise = new Promise<RegionStatus>((done) => { resolveJob = done; });
    const job: Job = {
      id, entry, proxyHash: entry.proxyHash, controller: new AbortController(), active: false, finished: false,
      promise, resolve: resolveJob,
    };
    this.jobs.set(id, job);
    this.queue.push(job);
    this.notify(id);
    this.drain();
    return promise;
  }

  /** Call before proxy replacement or account import, even when the new proxy string is identical. */
  invalidate(id: number): void {
    validId(id);
    const account = this.options.getAccount(id);
    if (account) this.entries.set(id, newEntry(proxyHash(account.proxy)));
    else this.entries.delete(id);
    this.snapshots.delete(id);
    const job = this.jobs.get(id);
    if (job) this.cancel(job);
    this.persist();
    this.notify(id);
    this.drain();
  }

  remove(id: number): void {
    validId(id);
    this.entries.delete(id);
    this.snapshots.delete(id);
    const job = this.jobs.get(id);
    if (job) this.cancel(job);
    this.persist();
    this.notify(id);
    this.drain();
  }

  stop(): void {
    this.stopped = true;
    for (const job of [...this.jobs.values()]) this.cancel(job);
    this.queue.length = 0;
  }

  /** Runtime profile resolution is synchronous and keeps same-proxy stale values for open documents. */
  effective(account: Account): Account {
    const output: Account = { ...account, fp: { ...account.fp } };
    if (account.fp.enabled !== true) return output;
    const current = this.synchronize(account.id);
    const entry = this.entries.get(account.id);
    const configuredProxy = proxyHash(account.proxy);
    for (const field of ['locale', 'timezone'] as const) {
      const mode = regionMode(account.fp, field);
      if (mode === 'manual') continue;
      if (mode === 'native' || configuredProxy === null) {
        output.fp[field] = '';
        continue;
      }
      const value = current && proxyHash(current.proxy) === configuredProxy && entry?.proxyHash === configuredProxy
        ? entry.observation?.[field] : null;
      if (!value) throw Object.assign(new Error(REGION_UNAVAILABLE), { statusCode: 503 });
      output.fp[field] = value;
    }
    return output;
  }

  private synchronize(id: number): Account | undefined {
    const account = this.options.getAccount(id);
    const hash = account ? proxyHash(account.proxy) : null;
    const previous = this.entries.get(id);
    const snapshot = this.snapshots.get(id);
    const changed = previous ? !account || previous.proxyHash !== hash : Boolean(snapshot && (!account || snapshot.proxyHash !== hash));
    if (changed) {
      if (account) this.entries.set(id, newEntry(hash));
      else this.entries.delete(id);
      this.snapshots.delete(id);
      const job = this.jobs.get(id);
      if (job) this.cancel(job);
      this.persist();
      this.notify(id);
      this.drain();
    } else if (account && !previous) {
      const entry = newEntry(hash);
      if (snapshot && this.isFresh(snapshot.checkedAt)) {
        entry.observation = observation(snapshot);
        entry.observedAt = snapshot.checkedAt;
        entry.checkedAt = snapshot.checkedAt;
        if (unsupportedCountry(account, entry)) entry.retryNotBefore = snapshot.checkedAt + FAILURE_COOLDOWN;
      }
      this.entries.set(id, entry);
    }
    return account;
  }

  private view(id: number, account = this.options.getAccount(id)): RegionStatus {
    if (!account) return emptyStatus('disabled');
    if (proxyHash(account.proxy) === null) return emptyStatus('no_proxy');
    const entry = this.entries.get(id);
    const result: RegionStatus = {
      state: needsAutomatic(account) ? 'unknown' : 'disabled',
      checkedAt: entry?.checkedAt ?? null,
      ip: entry?.observation?.ip ?? null,
      countryCode: entry?.observation?.countryCode ?? null,
      timezone: entry?.observation?.timezone ?? null,
      locale: entry?.observation?.locale ?? null,
      error: null,
      stale: entry ? this.stale(entry) : false,
    };
    if (this.jobs.has(id)) result.state = 'checking';
    else if (entry?.error) { result.state = 'error'; result.error = entry.error; }
    else if (entry?.observation) {
      result.state = unsupportedCountry(account, entry) ? 'error' : 'ready';
      if (result.state === 'error') result.error = 'unsupported_country';
    }
    return result;
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.stopped && this.active < 2 && this.queue.length) {
        const job = this.queue.shift()!;
        if (job.finished) continue;
        const account = this.synchronize(job.id);
        if (job.finished) continue;
        if (!account || !this.current(job) || proxyHash(account.proxy) !== job.proxyHash) {
          this.cancel(job);
          continue;
        }
        job.active = true;
        this.active++;
        try {
          const request = structuredClone(account);
          void Promise.resolve(this.options.lookup(request, job.controller.signal)).then(
            (value) => this.finish(job, value),
            () => this.finish(job),
          );
        } catch { this.finish(job); }
      }
    } finally { this.draining = false; }
  }

  private current(job: Job): boolean {
    return !this.stopped && !job.finished && !job.controller.signal.aborted
      && this.jobs.get(job.id) === job && this.entries.get(job.id) === job.entry;
  }

  private finish(job: Job, raw?: RegionObservation): void {
    // Abort settles the caller immediately, but a transport that ignores it still
    // owns its slot until its promise settles. Repeated invalidation stays bounded.
    this.settle(job);
    if (job.finished) { this.drain(); return; }
    const account = this.synchronize(job.id);
    if (job.finished) { this.drain(); return; }
    if (account && this.current(job) && proxyHash(account.proxy) === job.proxyHash) {
      const value = observation(raw);
      if (value) {
        const checkedAt = this.now();
        job.entry.observation = value;
        job.entry.observedAt = checkedAt;
        job.entry.checkedAt = checkedAt;
        job.entry.error = null;
        job.entry.retryNotBefore = unsupportedCountry(account, job.entry) ? checkedAt + FAILURE_COOLDOWN : 0;
        this.snapshots.delete(job.id);
        this.snapshots.set(job.id, { id: job.id, proxyHash: job.proxyHash, checkedAt, ...value });
        this.persist();
      } else this.fail(job.entry);
    }
    this.release(job);
    job.resolve(this.view(job.id));
    this.notify(job.id);
    this.drain();
  }

  private fail(entry: Entry): void {
    entry.checkedAt = this.now();
    entry.error = 'lookup_failed';
    entry.retryNotBefore = entry.checkedAt + FAILURE_COOLDOWN;
  }

  private settle(job: Job): void {
    if (job.active) { job.active = false; this.active--; }
  }

  private release(job: Job): void {
    job.finished = true;
    if (this.jobs.get(job.id) === job) this.jobs.delete(job.id);
    const queued = this.queue.indexOf(job);
    if (queued !== -1) this.queue.splice(queued, 1);
  }

  private cancel(job: Job): void {
    if (job.finished) return;
    this.release(job);
    job.controller.abort();
    job.resolve(this.view(job.id));
  }

  private stale(entry: Entry): boolean {
    return entry.observation !== null && (entry.observedAt === null || !this.isFresh(entry.observedAt));
  }

  private isFresh(checkedAt: number): boolean {
    const age = this.now() - checkedAt;
    return age >= 0 && age < SUCCESS_TTL;
  }

  private notify(id: number): void {
    try { this.options.onChange?.(id, this.view(id)); } catch { /* Observers do not own this lifecycle. */ }
  }

  private persist(): void {
    if (!this.store) return;
    const regions: SnapshotRow[] = [];
    for (const [id, row] of this.snapshots) {
      const account = this.options.getAccount(id);
      if (!account || proxyHash(account.proxy) !== row.proxyHash) {
        this.snapshots.delete(id);
        continue;
      }
      regions.push(row);
    }
    try { this.store.write({ schema: 1, regions: regions.slice(-MAX_SNAPSHOT_ROWS) }); }
    catch { /* Disk failures neither expose stored values nor erase a usable in-memory observation. */ }
  }

  private validateSnapshot(raw: unknown): Snapshot {
    const result: Snapshot = { schema: 1, regions: [] };
    if (!isRecord(raw) || raw.schema !== 1 || !Array.isArray(raw.regions)) return result;
    const seen = new Set<number>();
    for (const candidate of raw.regions.slice(0, MAX_SNAPSHOT_ROWS)) {
      if (!isRecord(candidate) || !Number.isSafeInteger(candidate.id) || (candidate.id as number) < 1
        || typeof candidate.proxyHash !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.proxyHash)
        || typeof candidate.checkedAt !== 'number' || !Number.isSafeInteger(candidate.checkedAt)
        || candidate.checkedAt < 0 || !this.isFresh(candidate.checkedAt)) continue;
      const value = observation(candidate);
      const id = candidate.id as number;
      if (!value || seen.has(id)) continue;
      seen.add(id);
      result.regions.push({ id, proxyHash: candidate.proxyHash, checkedAt: candidate.checkedAt, ...value });
    }
    return result;
  }
}

function newEntry(hash: string | null): Entry {
  return { proxyHash: hash, observation: null, observedAt: null, checkedAt: null, error: null, retryNotBefore: 0 };
}
function emptyStatus(state: RegionStatus['state']): RegionStatus {
  return { state, checkedAt: null, ip: null, countryCode: null, timezone: null, locale: null, error: null, stale: false };
}
function proxyHash(proxy: string): string | null {
  return typeof proxy === 'string' && proxy.trim() ? createHash('sha256').update(proxy).digest('hex') : null;
}
function regionMode(fp: RegionFingerprint, field: 'locale' | 'timezone'): RegionMode {
  const mode = fp[field === 'locale' ? 'localeMode' : 'timezoneMode'];
  return mode === 'manual' || mode === 'native' || mode === 'proxy' ? mode : fp[field]?.trim() ? 'manual' : 'proxy';
}
function needsAutomatic(account: Account): boolean {
  return account.fp.enabled === true && (regionMode(account.fp, 'locale') === 'proxy' || regionMode(account.fp, 'timezone') === 'proxy');
}
function unsupportedCountry(account: Account, entry: Entry): boolean {
  return account.fp.enabled === true && regionMode(account.fp, 'locale') === 'proxy'
    && entry.observation !== null && entry.observation.locale === null;
}
function observation(raw: unknown): RegionObservation | null {
  if (!isRecord(raw) || typeof raw.ip !== 'string' || !isIP(raw.ip)
    || typeof raw.countryCode !== 'string' || !/^[A-Z]{2}$/.test(raw.countryCode)
    || typeof raw.timezone !== 'string' || raw.timezone.length > 128
    || !/^[A-Za-z][A-Za-z0-9_+\/-]*$/.test(raw.timezone)) return null;
  try {
    new Intl.DateTimeFormat('en', { timeZone: raw.timezone });
    const locale = localeForCountry(raw.countryCode);
    if (raw.locale !== locale) return null;
    return { ip: raw.ip, countryCode: raw.countryCode, timezone: raw.timezone, locale };
  } catch { return null; }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validId(id: number): void {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid account ID');
}
function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
