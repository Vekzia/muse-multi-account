import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountStore, AccountStoreError } from './account-store.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'muse-accounts-'));
  directories.push(directory);
  return directory;
}

describe('AccountStore fingerprint lifecycle', () => {
  it('loads v1.5 legacy fingerprints with invalid old strings in disabled native mode without dropping accounts or writing', async () => {
    const directory = await makeDirectory();
    const disk = JSON.stringify({ schema: 1, nextId: 3, currentId: 1, accounts: [
      { id: 1, name: 'legacy', fp: { uaMode: 'desktop', locale: 'en_US', tz: 'Invalid/Zone', uaCustom: 'Browser\r\nX: bad', noise: true } },
      { id: 2, name: 'valid', fp: { locale: 'zh-CN', timezone: 'Asia/Shanghai', uaMode: 'windows' } },
    ] });
    await writeFile(join(directory, 'accounts.json'), disk);
    const store = new AccountStore(directory);
    expect(store.list()).toHaveLength(2);
    expect(store.get(1)?.fp).toMatchObject({ enabled: false, uaMode: 'system', locale: '', timezone: '', uaCustom: '', noise: true });
    expect(store.get(2)?.fp).toMatchObject({ enabled: false, uaMode: 'windows', locale: 'zh-CN', timezone: 'Asia/Shanghai' });
    expect(new AccountStore(directory).get(1)?.fp).toEqual(store.get(1)?.fp);
    expect(await readFile(join(directory, 'accounts.json'), 'utf8')).toBe(disk);
    expect(() => store.update(1, { fp: { locale: 'en_US' } })).toThrowError(expect.objectContaining({ statusCode: 400 }));
  });

  it.each([{ enabled: true, locale: 'en_US' }, { seed: 123, uaMode: 'desktop' }, { script: 'raw', locale: 'en_US' }])('keeps nonlegacy persisted fingerprints strict: %j', async (fp) => {
    const directory = await makeDirectory();
    await writeFile(join(directory, 'accounts.json'), JSON.stringify({ schema: 1, nextId: 2, currentId: 1, accounts: [{ id: 1, name: 'bad', fp }] }));
    expect(() => new AccountStore(directory)).toThrow(/Invalid persisted/);
  });
  it('persists a creation seed once, deep-merges partial updates and keeps reads detached and stable', async () => {
    const directory = await makeDirectory();
    const store = new AccountStore(directory);
    const created = store.create({ name: 'profile', fp: { enabled: true, uaMode: 'custom', uaCustom: 'Browser/1', screenWidth: 1920, locale: 'en-US', audioNoise: true } });
    expect(created.fp.seed).toBeGreaterThan(0);
    expect(created.fp.seed).toBeLessThanOrEqual(0xffff_ffff);
    const updated = store.update(created.id, { fp: { timezone: 'Asia/Shanghai' } }, 1);
    expect(updated.fp).toMatchObject({ ...created.fp, timezone: 'Asia/Shanghai' });
    expect(updated.version).toBe(2);
    const disk = await readFile(join(directory, 'accounts.json'), 'utf8');
    expect(JSON.parse(disk).accounts[0].fp).toEqual(updated.fp);
    expect(new AccountStore(directory).get(created.id)?.fp).toEqual(updated.fp);
    expect(store.list()[0]?.fp).toEqual(updated.fp);
    expect(await readFile(join(directory, 'accounts.json'), 'utf8')).toBe(disk);
  });

  it('uses a deterministic legacy seed without modifying the old persisted file on reads', async () => {
    const directory = await makeDirectory();
    const disk = JSON.stringify({ schema: 1, nextId: 3, currentId: 1, accounts: [{ id: 1, name: 'legacy', fp: { uaMode: 'windows', noise: true } }, { id: 2, name: 'other' }] });
    await writeFile(join(directory, 'accounts.json'), disk);
    const first = new AccountStore(directory).get(1)!;
    expect(first.fp).toMatchObject({ enabled: false, uaMode: 'windows', noise: true });
    expect(first.fp.seed).toBeGreaterThan(0);
    const store = new AccountStore(directory);
    expect(store.get(1)?.fp.seed).toBe(first.fp.seed);
    expect(store.get(2)?.fp.seed).not.toBe(first.fp.seed);
    expect(await readFile(join(directory, 'accounts.json'), 'utf8')).toBe(disk);
    expect(store.update(1, { name: 'renamed' }).fp.seed).toBe(first.fp.seed);
  });

  it('resets to native disabled settings with the same seed and only regenerates on explicit generate', async () => {
    const directory = await makeDirectory();
    const store = new AccountStore(directory);
    const account = store.create({ name: 'profile', logged: true, fp: { enabled: true, noise: true, uaMode: 'windows', timezone: 'Asia/Shanghai' } });
    const reset = store.update(account.id, { fp: null }, 1);
    expect(reset.fp).toMatchObject({ enabled: false, seed: account.fp.seed, uaMode: 'system', timezone: '', screenWidth: 0, noise: false });
    const generated = store.generateFingerprint(account.id, 'macos', reset.version);
    expect(generated).toMatchObject({ name: 'profile', logged: true, version: 3, fp: { enabled: true, uaMode: 'macos' } });
    expect(generated.fp.seed).not.toBe(reset.fp.seed);
    expect(new AccountStore(directory).get(account.id)?.fp).toEqual(generated.fp);
    expect(() => store.generateFingerprint(account.id, 'windows', reset.version)).toThrowError(expect.objectContaining({ statusCode: 409 }));
    expect(store.get(account.id)?.fp).toEqual(generated.fp);
    const regenerated = store.generateFingerprint(account.id, 'macos', generated.version);
    expect(regenerated.fp.seed).not.toBe(generated.fp.seed);
    expect(new AccountStore(directory).get(account.id)?.fp).toEqual(regenerated.fp);
  });

  it.each([{ timezone: 'Invalid/Zone' }, { locale: 'en_US' }, { pixelRatio: -1 }, { uaCustom: 'Browser\r\nX: yes' }, { seed: 0 }, { script: 'alert(1)' }])('rejects malformed fingerprint changes before any mutation: %j', async (fp) => {
    const directory = await makeDirectory();
    const store = new AccountStore(directory);
    const account = store.create({ name: 'stable' });
    const disk = await readFile(join(directory, 'accounts.json'), 'utf8');
    expect(() => store.update(account.id, { name: 'changed', fp }, account.version)).toThrowError(expect.objectContaining({ statusCode: 400 }));
    expect(await readFile(join(directory, 'accounts.json'), 'utf8')).toBe(disk);
    expect(store.get(account.id)).toEqual(account);
  });

  it('allows a full draft with unchanged seed but rejects ordinary seed replacement', async () => {
    const store = new AccountStore(await makeDirectory());
    const account = store.create({ name: 'profile' });
    expect(store.update(account.id, { fp: account.fp }).fp.seed).toBe(account.fp.seed);
    const changed = account.fp.seed === 1 ? 2 : 1;
    expect(() => store.update(account.id, { fp: { seed: changed } })).toThrowError(expect.objectContaining({ statusCode: 400 }));
  });
});

describe('AccountStore', () => {
  it('exposes the next ID without consuming it or mutating storage', async () => {
    const directory = await makeDirectory();
    const store = new AccountStore(directory);
    const before = await readFile(join(directory, 'accounts.json'), 'utf8');
    expect(store.peekNextId()).toBe(1);
    expect(store.peekNextId()).toBe(1);
    expect(await readFile(join(directory, 'accounts.json'), 'utf8')).toBe(before);
    expect(store.create({ name: 'first' }).id).toBe(1);
    expect(new AccountStore(directory).peekNextId()).toBe(2);
  });

  it('replaces a backup snapshot atomically and preserves the ID high-water mark', async () => {
    const directory = await makeDirectory();
    const store = new AccountStore(directory);
    store.replaceAll([{ id: 40, name: 'imported', fp: { locale: 'zh-CN' } }]);
    expect(new AccountStore(directory).get(40)).toMatchObject({ name: 'imported', fp: { locale: 'zh-CN' } });
    expect(() => store.replaceAll([{ id: 5, name: 'first' }, { id: 5, name: 'duplicate' }])).toThrow(/Duplicate/);
    expect(() => store.replaceAll([{ id: 6, name: 'first' }, { id: 7, name: '' }])).toThrow(/name/);
    expect(store.list().map((account) => account.id)).toEqual([40]);
    store.replaceAll([]);
    expect(store.getCurrent()).toBeUndefined();
    expect(new AccountStore(directory).create({ name: 'after reload' }).id).toBe(41);
  });

  it('repairs a stale ID counter above existing Android-compatible records', async () => {
    const directory = await makeDirectory();
    await writeFile(join(directory, 'accounts.json'), JSON.stringify({ schema: 1, nextId: 1, currentId: null, accounts: [{ id: 50, name: 'old' }] }));
    const store = new AccountStore(directory);
    expect(store.get(50)).toMatchObject({ group: '', pinned: false, lastUsedAt: 0 });
    expect(store.create({ name: 'new' }).id).toBe(51);
  });

  it('returns detached snapshots and keeps runtime login state out of persistence', async () => {
    const directory = await makeDirectory();
    const store = new AccountStore(directory);
    const account = store.create({ name: 'one', tags: ['work'], logged: true });
    account.tags.push('mutated');
    store.list()[0]!.fp.locale = 'changed';
    expect(store.get(account.id)).toMatchObject({ tags: ['work'], logged: true, fp: { locale: '' } });
    expect(new AccountStore(directory).get(account.id)?.logged).toBe(false);
    expect(JSON.parse(await readFile(join(directory, 'accounts.json'), 'utf8')).accounts[0].logged).not.toBe(true);
  });

  it('reports invalid and missing IDs without mutating accounts', async () => {
    const directory = await makeDirectory();
    const store = new AccountStore(directory);
    const account = store.create({ name: 'one' });
    expect(() => store.remove(99)).toThrowError(expect.objectContaining({ statusCode: 404 }));
    expect(() => store.update(account.id, { name: 'new' }, 99)).toThrowError(expect.objectContaining({ statusCode: 409 }));
    expect(() => store.setCurrent(0)).toThrowError(expect.objectContaining({ statusCode: 400 }));
    store.remove(account.id);
    expect(store.getCurrent()).toBeUndefined();
    expect(store.get(account.id)).toBeUndefined();
  });

  it('persists compatible account metadata and reloads it across instances', async () => {
    const directory = await makeDirectory();
    const first = new AccountStore(directory, { now: () => 100 });
    const account = first.create({
      name: 'Primary', avatar: 'P', proxy: 'http://proxy:8080', proxyPool: ['http://proxy:8080'],
      tags: ['work'], group: 'Team', pinned: true,
    });

    expect(account).toMatchObject({ id: 1, name: 'Primary', avatar: 'P', proxy: 'http://proxy:8080', group: 'Team', pinned: true, version: 1, logged: false });
    expect(new AccountStore(directory).get(account.id)).toMatchObject({ id: 1, tags: ['work'], group: 'Team' });
  });

  it('allocates monotonically increasing IDs after deletion and stale metadata', async () => {
    const directory = await makeDirectory();
    const store = new AccountStore(directory);
    const first = store.create({ name: 'one' });
    const second = store.create({ name: 'two' });
    store.remove(first.id);
    expect(store.create({ name: 'three' }).id).toBe(3);
    expect(second.id).toBe(2);
  });

  it('filters accounts and orders pins before manual, name, and recent sort keys', async () => {
    const directory = await makeDirectory();
    const store = new AccountStore(directory, { now: () => 1_000 });
    store.create({ name: 'Zulu', tags: ['ops'], lastUsedAt: 50 });
    store.create({ name: 'beta', group: 'Team', pinned: true, lastUsedAt: 5 });
    store.create({ name: 'Alpha', group: 'Team', lastUsedAt: 100 });
    store.create({ name: 'ALPHA', group: 'Team', lastUsedAt: 100 });
    store.create({ name: 'Able', pinned: true, lastUsedAt: 10 });

    expect(store.list().map((account) => account.id)).toEqual([2, 5, 1, 3, 4]);
    expect(store.list({ sort: 'name' }).map((account) => account.id)).toEqual([5, 2, 3, 4, 1]);
    expect(store.list({ sort: 'recent' }).map((account) => account.id)).toEqual([5, 2, 3, 4, 1]);
    expect(store.list({ query: ' ops ' }).map((account) => account.id)).toEqual([1]);
    expect(store.list({ group: 'Team' }).map((account) => account.id)).toEqual([2, 3, 4]);
    expect(store.list({ group: '' }).map((account) => account.id)).toEqual([5, 1]);
  });

  it('updates versions, rejects stale writes, and changes current account', async () => {
    const directory = await makeDirectory();
    const store = new AccountStore(directory, { now: () => 1234 });
    const account = store.create({ name: 'one' });
    const updated = store.update(account.id, { name: 'renamed', logged: true }, account.version);
    expect(updated).toMatchObject({ name: 'renamed', logged: true, version: 2 });
    expect(() => store.update(account.id, { name: 'stale' }, account.version)).toThrowError(AccountStoreError);
    expect(() => store.update(account.id, { name: 'missing' }, 1)).toThrow(/409|conflict/i);
    expect(store.setCurrent(account.id)).toMatchObject({ id: account.id, lastUsedAt: 1234 });
    expect(store.getCurrent()).toMatchObject({ id: account.id });
  });

  it('normalizes nullable legacy fields and rejects invalid names', async () => {
    const directory = await makeDirectory();
    const store = new AccountStore(directory);
    const account = store.create({ name: ' legacy ', avatar: null, proxy: null, proxyPool: null, tags: null, group: null, pinned: null, lastUsedAt: null });
    expect(account).toMatchObject({ name: 'legacy', avatar: 'm', proxy: '', proxyPool: [], tags: [], group: '', pinned: false, lastUsedAt: 0 });
    expect(() => store.create({ name: '   ' })).toThrow(/name/i);
    expect(() => store.create({ name: 123 as unknown as string })).toThrow(AccountStoreError);
  });
});
