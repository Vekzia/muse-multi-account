import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, Fingerprint } from '../types.js';
import { AccountRegionManager, type AccountRegionManagerOptions, type RegionStatus } from './account-region.js';
import type { RegionObservation } from './region-lookup.js';

type Modes = { localeMode?: 'proxy' | 'manual' | 'native'; timezoneMode?: 'proxy' | 'manual' | 'native' };
const EPOCH = 1_800_000_000_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;
const US: RegionObservation = { ip: '198.51.100.10', countryCode: 'US', timezone: 'America/New_York', locale: 'en-US' };
const JP: RegionObservation = { ip: '2001:db8::10', countryCode: 'JP', timezone: 'Asia/Tokyo', locale: 'ja-JP' };
const UNKNOWN: RegionObservation = { ip: '203.0.113.10', countryCode: 'ZZ', timezone: 'Etc/UTC', locale: null };
const empty = (state: RegionStatus['state']): RegionStatus => ({
  state, checkedAt: null, ip: null, countryCode: null, timezone: null, locale: null, error: null, stale: false,
});

function account(id: number, fp: Partial<Fingerprint> & Modes = {}, proxy = `http://user:secret-${id}@proxy-${id}.example:8080`): Account {
  return {
    id, name: `Account ${id}`, avatar: '', proxy, proxyPool: [], tags: [], group: '', pinned: false,
    lastUsedAt: 0, logged: false, version: 7,
    fp: { uaMode: 'system', uaCustom: '', enabled: true, locale: '', timezone: '', webdriver: false, noise: false, webrtc: false, seed: 123, ...fp },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const directories: string[] = [];
const managers: AccountRegionManager[] = [];
function directory() {
  const result = mkdtempSync(join(tmpdir(), 'muse-account-region-'));
  directories.push(result);
  return result;
}
function setup(accounts: Account[], lookup: AccountRegionManagerOptions['lookup'] = async () => US, options: Partial<AccountRegionManagerOptions> = {}) {
  const records = new Map(accounts.map((value) => [value.id, value]));
  const manager = new AccountRegionManager({ getAccount: (id) => records.get(id), lookup, now: () => Date.now(), ...options });
  managers.push(manager);
  return { manager, records };
}
async function flush() { await Promise.resolve(); await Promise.resolve(); }
function hash(proxy: string) { return createHash('sha256').update(proxy).digest('hex'); }
function snapshotRow(value: Account, observation: RegionObservation = US, checkedAt = EPOCH) {
  return { id: value.id, proxyHash: hash(value.proxy), checkedAt, ...observation };
}
function writeSnapshot(dataDir: string, rows: unknown[]) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dataDir, 'regions.json'), JSON.stringify({ schema: 1, regions: rows }), { mode: 0o600 });
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(EPOCH); });
afterEach(() => {
  for (const manager of managers.splice(0)) manager.stop();
  for (const value of directories.splice(0)) rmSync(value, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('AccountRegionManager status and lookup policy', () => {
  it('has exact synchronous public states and never performs lookup on a status read', async () => {
    const lookup = vi.fn(async () => US);
    const { manager } = setup([account(1), account(2, { enabled: false }), account(3, {}, '')], lookup);
    expect(manager.status(1)).toEqual(empty('unknown'));
    expect(manager.status(2)).toEqual(empty('disabled'));
    expect(manager.status(3)).toEqual(empty('no_proxy'));
    expect(manager.status(99)).toEqual(empty('disabled'));
    await manager.ensure(2);
    await manager.ensure(3, { force: true });
    expect(lookup).not.toHaveBeenCalled();
    const first = manager.status(1);
    first.state = 'error';
    expect(manager.status(1)).toEqual(empty('unknown'));
  });

  it('only queries automatic enabled profiles unless forced, and never queries without a proxy', async () => {
    const lookup = vi.fn(async () => US);
    const { manager } = setup([
      account(1, { locale: 'fr-FR', timezone: 'Europe/Paris' }),
      account(2, { localeMode: 'native', timezoneMode: 'native' }),
      account(3, { enabled: false }), account(4, {}, ' \t '),
    ], lookup);
    await manager.ensure(1);
    await manager.ensure(2);
    await manager.ensure(3);
    expect(lookup).not.toHaveBeenCalled();
    expect((await manager.ensure(1, { force: true })).state).toBe('ready');
    expect((await manager.ensure(3, { force: true })).state).toBe('ready');
    expect((await manager.ensure(4, { force: true })).state).toBe('no_proxy');
    expect(lookup.mock.calls).toHaveLength(2);
  });

  it('deduplicates a single account while keeping account results isolated', async () => {
    const first = deferred<RegionObservation>();
    const second = deferred<RegionObservation>();
    const lookup = vi.fn((value: Account) => value.id === 1 ? first.promise : second.promise);
    const { manager } = setup([account(1), account(2)], lookup);
    const pending = manager.ensure(1);
    expect(manager.ensure(1, { force: true })).toBe(pending);
    const other = manager.ensure(2);
    expect(manager.status(1)).toEqual({ ...empty('checking'), state: 'checking' });
    second.resolve(JP);
    await other;
    expect(manager.status(2)).toMatchObject({ state: 'ready', ...JP });
    expect(manager.status(1).ip).toBeNull();
    first.resolve(US);
    expect(await pending).toEqual({ state: 'ready', checkedAt: EPOCH, ...US, error: null, stale: false });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('holds at most two active lookups and bounds pending work to 64 queue entries', async () => {
    const jobs = new Map<number, ReturnType<typeof deferred<RegionObservation>>>();
    const seen: number[] = [];
    const { manager } = setup(Array.from({ length: 67 }, (_, i) => account(i + 1)), (value) => {
      seen.push(value.id);
      const job = deferred<RegionObservation>(); jobs.set(value.id, job); return job.promise;
    });
    const pending = Array.from({ length: 66 }, (_, i) => manager.ensure(i + 1));
    expect(seen).toEqual([1, 2]);
    expect(manager.ensure(3)).toBe(pending[2]);
    expect(await manager.ensure(67)).toMatchObject({ state: 'error', error: 'lookup_failed', checkedAt: EPOCH });
    expect(await manager.ensure(67, { force: true })).toMatchObject({ state: 'error', error: 'lookup_failed' });
    expect(seen).toEqual([1, 2]);
    jobs.get(1)!.resolve(US);
    await pending[0];
    expect(seen).toEqual([1, 2, 3]);
    manager.stop();
    await Promise.all(pending);
    expect(jobs.size).toBe(3);
  });

  it('uses the one-hour successful TTL, exposes stale state and bypasses only success on force', async () => {
    const lookup = vi.fn(async () => US);
    const { manager } = setup([account(1)], lookup);
    await manager.ensure(1);
    vi.setSystemTime(EPOCH + HOUR - 1);
    await manager.ensure(1);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(manager.status(1).stale).toBe(false);
    vi.setSystemTime(EPOCH + HOUR);
    expect(manager.status(1)).toMatchObject({ state: 'ready', stale: true, checkedAt: EPOCH });
    expect(lookup).toHaveBeenCalledTimes(1);
    await manager.ensure(1);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(manager.status(1).checkedAt).toBe(EPOCH + HOUR);
    await manager.ensure(1, { force: true });
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('redacts failures, backs off automatic checks, and lets explicit force retry immediately', async () => {
    let fail = true;
    const lookup = vi.fn(async () => { if (fail) throw new Error('secret-token http://user:pass@private'); return JP; });
    const { manager } = setup([account(1)], lookup);
    const result = await manager.ensure(1);
    expect(result).toEqual({ ...empty('error'), checkedAt: EPOCH, error: 'lookup_failed' });
    expect(JSON.stringify(result)).not.toMatch(/secret|token|pass|private/);
    for (let i = 0; i < 8; i++) await manager.ensure(1);
    expect(lookup).toHaveBeenCalledTimes(1);
    vi.setSystemTime(EPOCH + MINUTE - 1);
    await manager.ensure(1);
    expect(lookup).toHaveBeenCalledTimes(1);
    // An operator pressing refresh must be able to retry the same proxy at once.
    await manager.ensure(1, { force: true });
    expect(lookup).toHaveBeenCalledTimes(2);
    fail = false;
    expect(await manager.ensure(1, { force: true })).toMatchObject({ state: 'ready', ...JP, error: null });
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('sanitizes invalid lookup payloads and does not expose raw fields or thrown values', async () => {
    const invalid = [
      { ...US, ip: 'not-ip' }, { ...US, countryCode: 'US\r\nSecret' },
      { ...US, timezone: 'Mars/Private' }, { ...US, locale: 'SECRET_CREDENTIAL' },
      { ...US, timezone: '+01:00' }, { ...US, ip: '127.0.0.1 secret' },
    ];
    const { manager } = setup(invalid.map((_, index) => account(index + 1)), async (value) => invalid[value.id - 1] as RegionObservation);
    for (let id = 1; id <= invalid.length; id++) {
      expect(await manager.ensure(id)).toEqual({ ...empty('error'), checkedAt: EPOCH, error: 'lookup_failed' });
    }
  });

  it('notifies with detached statuses and does not let observer errors break lookup', async () => {
    const seen: RegionStatus[] = [];
    const { manager } = setup([account(1)], async () => US, { onChange: (id, status) => {
      expect(id).toBe(1); seen.push({ ...status }); status.locale = 'private'; throw new Error('observer secret');
    } });
    expect(await manager.ensure(1)).toMatchObject({ state: 'ready', locale: 'en-US' });
    manager.invalidate(1);
    expect(seen.some((value) => value.state === 'ready')).toBe(true);
    expect(seen.some((value) => value.state === 'unknown')).toBe(true);
    expect(manager.status(1)).toEqual(empty('unknown'));
  });
});

describe('AccountRegionManager cancellation and proxy binding', () => {
  it('invalidates full proxy hashes including credentials when status observes a mismatch', async () => {
    const dataDir = directory();
    const first = deferred<RegionObservation>();
    let oldSignal: AbortSignal | undefined;
    const lookup = vi.fn((_value: Account, signal: AbortSignal) => { oldSignal = signal; return first.promise; });
    const { manager, records } = setup([account(1)], lookup, { dataDir });
    const pending = manager.ensure(1);
    records.set(1, { ...records.get(1)!, proxy: records.get(1)!.proxy.replace('secret-1', 'different-secret') });
    expect(manager.status(1)).toEqual(empty('unknown'));
    expect(oldSignal!.aborted).toBe(true);
    await pending;
    first.resolve(US);
    await flush();
    expect(manager.status(1)).toEqual(empty('unknown'));
    expect(readFileSync(join(dataDir, 'regions.json'), 'utf8')).not.toContain(US.ip);
  });

  it('checks the live proxy again before persisting even without a status read', async () => {
    const job = deferred<RegionObservation>();
    const dataDir = directory();
    const { manager, records } = setup([account(1)], () => job.promise, { dataDir });
    const pending = manager.ensure(1);
    records.set(1, account(1, {}, 'socks5://new:credential@new-proxy.example:1080'));
    job.resolve(US);
    expect(await pending).toEqual(empty('unknown'));
    expect(readFileSync(join(dataDir, 'regions.json'), 'utf8')).not.toContain(US.ip);
  });

  it('keeps the two-call cap when a cancelled lookup ignores its AbortSignal', async () => {
    const first = deferred<RegionObservation>();
    const second = deferred<RegionObservation>();
    let calls = 0;
    const { manager } = setup([account(1)], () => {
      calls++;
      return calls === 1 ? first.promise : calls === 2 ? second.promise : Promise.resolve(JP);
    });
    const old = manager.ensure(1);
    manager.invalidate(1);
    await old;
    const replacement = manager.ensure(1);
    manager.invalidate(1);
    await replacement;
    const queued = manager.ensure(1);
    expect(calls).toBe(2);
    first.resolve(US);
    expect(await queued).toMatchObject({ state: 'ready', ...JP });
    expect(calls).toBe(3);
    second.resolve(US);
    await flush();
    expect(manager.status(1)).toMatchObject({ state: 'ready', ...JP });
  });

  it('prevents an aborted generation from replacing its successful replacement', async () => {
    const old = deferred<RegionObservation>();
    let calls = 0;
    const dataDir = directory();
    const { manager } = setup([account(1)], () => ++calls === 1 ? old.promise : Promise.resolve(JP), { dataDir });
    const pending = manager.ensure(1);
    manager.invalidate(1);
    expect(await pending).toEqual(empty('unknown'));
    expect(await manager.ensure(1)).toMatchObject({ state: 'ready', ...JP });
    old.resolve(US);
    await flush();
    expect(manager.status(1)).toMatchObject({ state: 'ready', ...JP });
    expect(readFileSync(join(dataDir, 'regions.json'), 'utf8')).not.toContain(US.ip);
  });

  it('drops deleted/imported account work and remove deletes persisted state', async () => {
    const dataDir = directory();
    const old = deferred<RegionObservation>();
    let calls = 0;
    const { manager, records } = setup([account(1)], () => ++calls === 1 ? Promise.resolve(US) : old.promise, { dataDir });
    await manager.ensure(1);
    const pending = manager.ensure(1, { force: true });
    records.delete(1);
    manager.remove(1);
    expect(await pending).toEqual(empty('disabled'));
    records.set(1, account(1));
    manager.invalidate(1);
    old.resolve(JP);
    await flush();
    expect(manager.status(1)).toEqual(empty('unknown'));
    expect(JSON.parse(readFileSync(join(dataDir, 'regions.json'), 'utf8')).regions).toEqual([]);
  });

  it('removes persisted state for an externally deleted account when status detects it', async () => {
    const dataDir = directory();
    const { manager, records } = setup([account(1)], async () => US, { dataDir });
    await manager.ensure(1);
    records.delete(1);
    expect(manager.status(1)).toEqual(empty('disabled'));
    expect(JSON.parse(readFileSync(join(dataDir, 'regions.json'), 'utf8')).regions).toEqual([]);
  });

  it('stop cancels queued/active tasks and ignores late completion without altering existing cache', async () => {
    const dataDir = directory();
    const old = deferred<RegionObservation>();
    const signals: AbortSignal[] = [];
    const lookup = vi.fn((value: Account, signal: AbortSignal) => {
      if (value.id === 4) return Promise.resolve(JP);
      signals.push(signal); return old.promise;
    });
    const { manager } = setup([account(1), account(2), account(3), account(4)], lookup, { dataDir });
    await manager.ensure(4);
    const pending = [manager.ensure(1), manager.ensure(2), manager.ensure(3)];
    manager.stop();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect((await Promise.all(pending)).map((value) => value.state)).toEqual(['unknown', 'unknown', 'unknown']);
    const stored = readFileSync(join(dataDir, 'regions.json'), 'utf8');
    old.resolve(US);
    await flush();
    expect(readFileSync(join(dataDir, 'regions.json'), 'utf8')).toBe(stored);
    expect(manager.status(4)).toMatchObject({ state: 'ready', ...JP });
    await manager.ensure(1, { force: true });
    expect(lookup).toHaveBeenCalledTimes(3);
  });
});

describe('AccountRegionManager effective fingerprint', () => {
  it('clones fingerprint, derives auto values and preserves account version, seed and saved manual fields', async () => {
    const saved = account(1, { locale: 'fr-FR', timezone: 'Europe/Paris', localeMode: 'proxy', timezoneMode: 'proxy' });
    const original = structuredClone(saved);
    const { manager } = setup([saved]);
    await manager.ensure(1);
    const result = manager.effective(saved);
    expect(result).not.toBe(saved);
    expect(result.fp).not.toBe(saved.fp);
    expect(result.fp).toMatchObject({ locale: 'en-US', timezone: 'America/New_York', seed: 123 });
    expect(result.version).toBe(7);
    expect(saved).toEqual(original);
  });

  it('infers old non-empty values as manual, honors native and only applies when enabled', async () => {
    const manual = account(1, { locale: 'fr-FR', timezone: 'Europe/Paris' });
    const native = account(2, { locale: 'fr-FR', timezone: 'Europe/Paris', localeMode: 'native', timezoneMode: 'native' });
    const disabled = account(3, { enabled: false, locale: 'fr-FR', timezone: 'Europe/Paris', localeMode: 'proxy', timezoneMode: 'proxy' });
    const { manager } = setup([manual, native, disabled]);
    expect(manager.effective(manual).fp).toMatchObject({ locale: 'fr-FR', timezone: 'Europe/Paris' });
    expect(manager.effective(native).fp).toMatchObject({ locale: '', timezone: '' });
    expect(manager.effective(disabled).fp).toEqual(disabled.fp);
    expect(manager.effective(disabled).fp).not.toBe(disabled.fp);
  });

  it('returns blank native auto fields when no proxy exists and never falls back to host locale', async () => {
    const saved = account(1, { locale: 'fr-FR', timezone: 'Europe/Paris', localeMode: 'proxy', timezoneMode: 'proxy' }, '');
    const lookup = vi.fn(async () => US);
    const { manager } = setup([saved], lookup);
    expect(manager.effective(saved).fp).toMatchObject({ locale: '', timezone: '' });
    expect(await manager.ensure(1)).toEqual(empty('no_proxy'));
    expect(lookup).not.toHaveBeenCalled();
  });

  it('fails closed with status 503 for missing proxy-required values without leaking details', async () => {
    const saved = account(1);
    const { manager } = setup([saved], async () => { throw new Error('raw private credential'); });
    for (const read of [() => manager.effective(saved), async () => { await manager.ensure(1); return manager.effective(saved); }]) {
      try { await read(); expect.fail('missing region must fail'); }
      catch (error) {
        expect(error).toMatchObject({ statusCode: 503, message: 'Proxy region is unavailable; retry region lookup' });
        expect(String(error)).not.toMatch(/private|credential|user:|secret-/);
      }
    }
  });

  it('uses a valid timezone for an unsupported country if language is manual or native', async () => {
    const manual = account(1, { locale: 'fr-FR', timezoneMode: 'proxy' });
    const automatic = account(2);
    const native = account(3, { localeMode: 'native', timezoneMode: 'proxy' });
    const lookup = vi.fn(async () => UNKNOWN);
    const { manager } = setup([manual, automatic, native], lookup);
    expect(await manager.ensure(1)).toMatchObject({ state: 'ready', error: null, ...UNKNOWN });
    expect(manager.effective(manual).fp).toMatchObject({ locale: 'fr-FR', timezone: 'Etc/UTC' });
    expect(await manager.ensure(2)).toMatchObject({ state: 'error', error: 'unsupported_country', ...UNKNOWN });
    expect(() => manager.effective(automatic)).toThrow('Proxy region is unavailable; retry region lookup');
    expect(await manager.ensure(3)).toMatchObject({ state: 'ready', ...UNKNOWN });
    expect(manager.effective(native).fp).toMatchObject({ locale: '', timezone: 'Etc/UTC' });
    // An explicit refresh may also retry an unsupported-country observation.
    await manager.ensure(2, { force: true });
    expect(lookup).toHaveBeenCalledTimes(4);
  });

  it('retains cached stale values for a running document without network or timestamp writes', async () => {
    const saved = account(1);
    let fail = false;
    const lookup = vi.fn(async () => { if (fail) throw new Error('offline'); return US; });
    const dataDir = directory();
    const { manager } = setup([saved], lookup, { dataDir });
    await manager.ensure(1);
    const stored = readFileSync(join(dataDir, 'regions.json'), 'utf8');
    vi.setSystemTime(EPOCH + HOUR + 1);
    for (let i = 0; i < 3; i++) expect(manager.effective(saved).fp).toMatchObject({ locale: 'en-US', timezone: 'America/New_York' });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(manager.status(1).stale).toBe(true);
    expect(readFileSync(join(dataDir, 'regions.json'), 'utf8')).toBe(stored);
    fail = true;
    expect(await manager.ensure(1)).toMatchObject({ state: 'error', error: 'lookup_failed', stale: true });
    expect(manager.effective(saved).fp.locale).toBe('en-US');
  });

  it('rejects a stale Account argument when the live record has a new proxy', async () => {
    const saved = account(1);
    const { manager, records } = setup([saved]);
    await manager.ensure(1);
    records.set(1, account(1, {}, 'http://other.example:8080'));
    expect(() => manager.effective(saved)).toThrow('Proxy region is unavailable; retry region lookup');
    expect(manager.status(1)).toEqual(empty('unknown'));
  });
});

describe('AccountRegionManager persisted region snapshots', () => {
  it('persists a sanitized proxy-bound observation at mode 0600 under a mode 0700 directory', async () => {
    const root = directory();
    const dataDir = join(root, 'private');
    const saved = account(1);
    const { manager } = setup([saved], async () => ({ ...US, raw: 'PRIVATE_VALUE' }), { dataDir });
    await manager.ensure(1);
    const path = join(dataDir, 'regions.json');
    const text = readFileSync(path, 'utf8');
    expect(JSON.parse(text)).toEqual({ schema: 1, regions: [snapshotRow(saved)] });
    expect(text).not.toMatch(/secret-|user:|proxy-1|PRIVATE_VALUE|raw/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(saved.version).toBe(7);
  });

  it('loads a fresh same-proxy snapshot without network and rejects account/proxy substitution', async () => {
    const dataDir = directory();
    const saved = account(1);
    const first = setup([saved], async () => US, { dataDir }).manager;
    await first.ensure(1);
    first.stop();
    vi.setSystemTime(EPOCH + HOUR - 1);
    const lookup = vi.fn(async () => JP);
    const { manager } = setup([saved, account(2)], lookup, { dataDir });
    expect(manager.status(1)).toMatchObject({ state: 'ready', ...US, stale: false });
    await manager.ensure(1);
    expect(lookup).not.toHaveBeenCalled();
    expect(manager.status(2)).toEqual(empty('unknown'));
    const { manager: mismatched } = setup([account(1, {}, saved.proxy.replace('secret-1', 'changed'))], lookup, { dataDir });
    expect(mismatched.status(1)).toEqual(empty('unknown'));
  });

  it('discards expired loaded snapshots rather than using them as runtime proof', async () => {
    const dataDir = directory();
    const saved = account(1);
    writeSnapshot(dataDir, [snapshotRow(saved, US, EPOCH - HOUR)]);
    const lookup = vi.fn(async () => JP);
    const { manager } = setup([saved], lookup, { dataDir });
    expect(manager.status(1)).toEqual(empty('unknown'));
    expect(() => manager.effective(saved)).toThrow('Proxy region is unavailable; retry region lookup');
    expect(await manager.ensure(1)).toMatchObject({ state: 'ready', ...JP });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('ignores corrupt, oversized, future and invalid cached data and arbitrary locale suggestions', async () => {
    const dataDir = directory();
    const values = Array.from({ length: 8 }, (_, index) => account(index + 1));
    const rows = [
      { ...snapshotRow(values[0]!), ip: 'not-an-ip', password: 'PRIVATE' },
      { ...snapshotRow(values[1]!), timezone: 'Mars/Olympus' },
      { ...snapshotRow(values[2]!), locale: 'fr-FR' },
      { ...snapshotRow(values[3]!), checkedAt: EPOCH + 1 },
      { ...snapshotRow(values[4]!), countryCode: 'usa' },
      { ...snapshotRow(values[5]!), proxyHash: values[5]!.proxy },
      { ...snapshotRow(values[6]!), id: -1 },
      snapshotRow(values[7]!),
    ];
    writeSnapshot(dataDir, rows);
    const { manager } = setup(values, async () => US, { dataDir });
    for (let id = 1; id <= 7; id++) expect(manager.status(id)).toEqual(empty('unknown'));
    expect(manager.status(8)).toMatchObject({ state: 'ready', ...US });
    writeFileSync(join(dataDir, 'regions.json'), '{PRIVATE_SECRET is malformed', 'utf8');
    expect(() => setup(values, async () => US, { dataDir })).not.toThrow();
    expect(setup(values, async () => US, { dataDir }).manager.status(1)).toEqual(empty('unknown'));
    writeFileSync(join(dataDir, 'regions.json'), `{"schema":1,"regions":[],"secret":"${'x'.repeat(2 * 1024 * 1024)}"}`, 'utf8');
    expect(setup(values, async () => US, { dataDir }).manager.status(1)).toEqual(empty('unknown'));
  });

  it('caps loaded snapshot rows rather than trusting an unlimited cache', () => {
    const dataDir = directory();
    const values = Array.from({ length: 1025 }, (_, index) => account(index + 1));
    writeSnapshot(dataDir, values.map((value) => snapshotRow(value)));
    const { manager } = setup(values, async () => US, { dataDir });
    expect(manager.status(1)).toMatchObject({ state: 'ready' });
    expect(manager.status(1025)).toEqual(empty('unknown'));
  });
});
