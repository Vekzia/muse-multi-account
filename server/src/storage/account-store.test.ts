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
