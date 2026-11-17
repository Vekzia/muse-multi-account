import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AccountStore } from '../storage/account-store.js';
import { AccountCookieJar } from '../proxy/cookie-jar.js';
import {
  BACKUP_APP,
  BACKUP_SCHEMA,
  MAX_BACKUP_BYTES,
  exportBackup,
  importBackup,
  type AccountRecord,
  type AccountStoreLike,
  type CookieJarStoreLike,
} from './backup.js';

function account(id: number, name = `account-${id}`): AccountRecord {
  return { id, name, avatar: 'm', proxy: '', tags: [], group: '', pinned: false, keepAlive: { enabled: false, intervalMinutes: 360, wakeVm: false } };
}

function storeWith(accounts: AccountRecord[]): AccountStoreLike & {
  accounts: AccountRecord[];
  calls: string[];
} {
  const state = accounts.map((value) => structuredClone(value));
  const calls: string[] = [];
  return {
    accounts: state,
    calls,
    list: () => state.map((value) => structuredClone(value)),
    create: (value) => {
      calls.push(`create:${value.id}`);
      state.push(structuredClone(value));
      return structuredClone(value);
    },
    update: (id, patch) => {
      calls.push(`update:${id}`);
      const index = state.findIndex((value) => value.id === id);
      const previous = state[index];
      if (!previous) throw new Error(`missing account ${id}`);
      const next = { ...previous, ...structuredClone(patch), id };
      state[index] = next;
      return structuredClone(next);
    },
    remove: (id) => {
      calls.push(`remove:${id}`);
      const index = state.findIndex((value) => value.id === id);
      if (index >= 0) state.splice(index, 1);
    },
  };
}

function jarsWith(values: Record<number, unknown>): CookieJarStoreLike & {
  values: Record<number, unknown>;
  calls: string[];
} {
  const state = structuredClone(values);
  const calls: string[] = [];
  return {
    values: state,
    calls,
    export: (id) => structuredClone(state[id]),
    restore: (id, value) => {
      calls.push(`restore:${id}`);
      state[id] = structuredClone(value);
    },
    clear: (id) => {
      calls.push(`clear:${id}`);
      delete state[id];
    },
  };
}

describe('v1.7 backup policy contract', () => {
  it.each(['merge', 'replace'] as const)('preserves policies and keepalive through real %s backup reload', async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), 'muse-v17-backup-'));
    try {
      const source = new AccountStore(join(directory, 'source'));
      const sourceJars = new AccountCookieJar(join(directory, 'source'));
      const original = source.create({ name: 'policy', keepAlive: { enabled: true, intervalMinutes: 30, wakeVm: true }, fp: { enabled: true, seed: 123, tlsProfile: 'chrome142', workerMode: 'profile', fontMode: 'standard', webgpuMode: 'disabled' } });
      const target = new AccountStore(join(directory, 'target'));
      const targetJars = new AccountCookieJar(join(directory, 'target'));
      await importBackup(await exportBackup(source, sourceJars), target, targetJars, mode);
      expect(new AccountStore(join(directory, 'target')).get(original.id)).toMatchObject({ fp: original.fp, keepAlive: { enabled: true, intervalMinutes: 30, wakeVm: true } });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('disables old backup accounts when merging into a previously enabled fallback store', async () => {
    const store = storeWith([{ ...account(1), keepAlive: { enabled: true, intervalMinutes: 30, wakeVm: true } }]);
    const legacy = { ...account(1, 'legacy') };
    delete legacy.keepAlive;
    const input = Buffer.from(JSON.stringify({ app: BACKUP_APP, schema: BACKUP_SCHEMA, accounts: [legacy], cookies: [] }));
    await importBackup(input, store, jarsWith({}), 'merge');
    expect(store.accounts[0]?.keepAlive).toEqual({ enabled: false, intervalMinutes: 360, wakeVm: false });
  });

  it('normalizes partial imported keepalive before handing it to store dependencies', async () => {
    const store = storeWith([]);
    const input = Buffer.from(JSON.stringify({ app: BACKUP_APP, schema: BACKUP_SCHEMA, accounts: [{ ...account(2), keepAlive: { wakeVm: true } }], cookies: [] }));
    await importBackup(input, store, jarsWith({}), 'merge');
    expect(store.accounts[0]?.keepAlive).toEqual({ enabled: false, intervalMinutes: 360, wakeVm: true });
  });

  it('preserves v1.6 active profile settings while importing native policies and disabled keepalive', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'muse-v16-backup-'));
    try {
      const store = new AccountStore(directory);
      const input = Buffer.from(JSON.stringify({ app: BACKUP_APP, schema: BACKUP_SCHEMA, accounts: [{ ...account(7), fp: { enabled: true, seed: 123, uaMode: 'windows', noise: true } }], cookies: [] }));
      await importBackup(input, store, new AccountCookieJar(directory), 'replace');
      expect(new AccountStore(directory).get(7)).toMatchObject({ keepAlive: { enabled: false, intervalMinutes: 360, wakeVm: false }, fp: { enabled: true, seed: 123, uaMode: 'windows', noise: true, tlsProfile: 'native', workerMode: 'native', fontMode: 'native', webgpuMode: 'native' } });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each([false, [], { enabled: 'true' }, { wakeVm: null }, { intervalMinutes: '360' }, { intervalMinutes: 29 }, { intervalMinutes: 1441 }, { intervalMinutes: 30.5 }, { extra: true }])('validates keepalive in the complete backup before any mutation: %j', async (keepAlive) => {
    const store = storeWith([account(1)]);
    const jars = jarsWith({ 1: { cookies: [] } });
    const input = Buffer.from(JSON.stringify({ app: BACKUP_APP, schema: BACKUP_SCHEMA, accounts: [account(2), { ...account(3), keepAlive }], cookies: [] }));
    await expect(importBackup(input, store, jars, 'merge')).rejects.toMatchObject({ statusCode: 400 });
    expect(store.accounts).toEqual([account(1)]);
    expect(jars.values).toEqual({ 1: { cookies: [] } });
  });

  it.each([{ tlsProfile: 'chrome143' }, { workerMode: true }, { fontMode: 'local' }, { webgpuMode: null }])('validates new fingerprint policies before any backup mutation: %j', async (fp) => {
    const store = storeWith([account(1)]);
    const input = Buffer.from(JSON.stringify({ app: BACKUP_APP, schema: BACKUP_SCHEMA, accounts: [account(2), { ...account(3), fp }], cookies: [] }));
    await expect(importBackup(input, store, jarsWith({}), 'merge')).rejects.toMatchObject({ statusCode: 400 });
    expect(store.accounts).toEqual([account(1)]);
  });
});

describe('fingerprint backup contract', () => {
  it('imports old-only v1.5 fingerprints with unsupported strings disabled and deterministic across reloads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'muse-legacy-backup-'));
    try {
      const store = new AccountStore(directory);
      const jars = new AccountCookieJar(directory);
      const input = Buffer.from(JSON.stringify({ app: BACKUP_APP, schema: BACKUP_SCHEMA, accounts: [{ id: 7, name: 'legacy', fp: { uaMode: 'desktop', locale: 'en_US', timezone: 'Invalid/Zone', uaCustom: 'Browser\r\nX: yes', noise: true } }], cookies: [] }));
      await importBackup(input, store, jars, 'replace');
      expect(store.get(7)?.fp).toMatchObject({ enabled: false, uaMode: 'system', locale: '', timezone: '', uaCustom: '', noise: true });
      expect(new AccountStore(directory).get(7)?.fp).toEqual(store.get(7)?.fp);
      const seed = store.get(7)?.fp.seed;
      await importBackup(input, store, jars, 'merge');
      expect(store.get(7)?.fp.seed).toBe(seed);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it.each(['merge', 'replace'] as const)('preserves every fingerprint field and seed through real %s backup and reload', async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), 'muse-fingerprint-backup-'));
    try {
      const source = new AccountStore(join(directory, 'source'));
      const sourceJars = new AccountCookieJar(join(directory, 'source'));
      const account = source.create({ name: 'source', fp: { enabled: true, seed: 123456, uaMode: 'custom', uaCustom: 'Browser/1', timezone: 'America/New_York', locale: 'zh-CN', platform: 'Win32', screenWidth: 1920, screenHeight: 1080, pixelRatio: 1.25, hardwareConcurrency: 8, deviceMemory: 8, webglVendor: 'Vendor', webglRenderer: 'Renderer', audioNoise: true, noise: true, webdriver: true, webrtc: true } });
      expect(account.fp).toMatchObject({ enabled: true, seed: 123456, screenWidth: 1920, audioNoise: true });
      const jar = await sourceJars.get(account.id);
      await jar.setCookie('sid=original; Path=/', 'https://example.com/');
      await sourceJars.save(account.id, jar);
      const payload = await exportBackup(source, sourceJars);
      expect(JSON.parse(payload.toString()).accounts[0].fp).toEqual(account.fp);
      const target = new AccountStore(join(directory, 'target'));
      target.create({ name: 'old', fp: { seed: 111 } });
      const targetJars = new AccountCookieJar(join(directory, 'target'));
      await importBackup(payload, target, targetJars, mode);
      const reloaded = new AccountStore(join(directory, 'target'));
      expect(reloaded.get(account.id)?.fp).toEqual(account.fp);
      expect((await (await targetJars.get(account.id)).getCookieString('https://example.com/'))).toBe('sid=original');
      expect(JSON.parse((await exportBackup(reloaded, targetJars)).toString()).accounts[0].fp).toEqual(account.fp);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each([{ enabled: 'true' }, { seed: 0 }, { seed: 0x1_0000_0000 }, { enabled: false, timezone: 'Invalid/Zone' }, { enabled: true, locale: 'en_US' }, { screenHeight: -1 }, { pixelRatio: 100 }, { hardwareConcurrency: 1.5 }, { deviceMemory: 3 }, { audioNoise: null }, { seed: 123, uaCustom: 'Browser\r\nX: yes' }, { script: 'alert(1)' }])('validates fingerprint in a whole backup before any mutation: %j', async (fp) => {
    const store = storeWith([account(1)]);
    const jars = jarsWith({ 1: { cookies: [] } });
    const input = Buffer.from(JSON.stringify({ app: BACKUP_APP, schema: BACKUP_SCHEMA, accounts: [account(2), { ...account(3), fp }], cookies: [] }));
    await expect(importBackup(input, store, jars, 'merge')).rejects.toMatchObject({ statusCode: 400 });
    expect(store.accounts).toEqual([account(1)]);
    expect(jars.values).toEqual({ 1: { cookies: [] } });
  });
});

describe('exportBackup', () => {
  it('round-trips persisted accounts and full Cookie Jar scope through real stores', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'muse-backup-'));
    try {
      const source = new AccountStore(join(directory, 'source'));
      const sourceJars = new AccountCookieJar(join(directory, 'source'));
      const first = source.create({ name: 'primary', group: 'work', proxy: 'http://user:secret@proxy.example:8080' });
      source.create({ name: 'other' });
      const jar = await sourceJars.get(first.id);
      await jar.setCookie('session=private; Secure; HttpOnly; SameSite=Lax; Path=/private', 'https://muse.example/private');
      await sourceJars.save(first.id, jar);
      const payload = await exportBackup(source, sourceJars);
      const target = new AccountStore(join(directory, 'target'));
      const targetJars = new AccountCookieJar(join(directory, 'target'));
      await importBackup(payload, target, targetJars, 'replace');
      expect(target.list().map(({ id, name, group }) => ({ id, name, group }))).toEqual([
        { id: 1, name: 'primary', group: 'work' }, { id: 2, name: 'other', group: '' },
      ]);
      const reloaded = new AccountCookieJar(join(directory, 'target'));
      const cookies = await (await reloaded.get(1)).getCookies('https://muse.example/private');
      expect(cookies[0]).toMatchObject({ key: 'session', value: 'private', secure: true, httpOnly: true, sameSite: 'lax', path: '/private' });
      expect(await (await reloaded.get(1)).getCookieString('https://muse.example/')).toBe('');
      expect(await (await reloaded.get(2)).getCookieString('https://muse.example/private')).toBe('');
      expect(target.create({ name: 'after restore' }).id).toBe(3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('round-trips account metadata and each account cookie jar', async () => {
    const store = storeWith([account(7, 'primary'), account(8, 'secondary')]);
    const jars = jarsWith({
      7: { version: 1, cookies: [{ key: 'sid', value: 'alpha' }] },
      8: { version: 1, cookies: [{ key: 'sid', value: 'beta' }] },
    });

    const payload = await exportBackup(store, jars);
    const parsed = JSON.parse(payload.toString('utf8'));

    expect(parsed).toMatchObject({ app: BACKUP_APP, schema: BACKUP_SCHEMA });
    expect(parsed.accounts).toEqual([account(7, 'primary'), account(8, 'secondary')]);
    expect(parsed.cookies).toEqual([
      { accountId: 7, jar: { version: 1, cookies: [{ key: 'sid', value: 'alpha' }] } },
      { accountId: 8, jar: { version: 1, cookies: [{ key: 'sid', value: 'beta' }] } },
    ]);
  });

  it('exports an empty cookie jar snapshot instead of leaking a jar object', async () => {
    const store = storeWith([account(1)]);
    const jars = {
      get: () => ({
        toJSON: () => ({ version: 1, cookies: [] }),
      }),
    } satisfies CookieJarStoreLike;

    const parsed = JSON.parse((await exportBackup(store, jars)).toString('utf8'));
    expect(parsed.cookies).toEqual([{ accountId: 1, jar: { version: 1, cookies: [] } }]);
  });
});

describe('importBackup', () => {
  it('rejects invalid backup timestamps before mutation with status 400', async () => {
    const store = storeWith([account(1)]);
    const jars = jarsWith({});
    const input = Buffer.from(JSON.stringify({ app: BACKUP_APP, schema: BACKUP_SCHEMA, exportedAt: 'PRIVATE_VALUE', accounts: [], cookies: [] }));
    await expect(importBackup(input, store, jars, 'replace')).rejects.toMatchObject({ statusCode: 400 });
    expect(store.calls).toEqual([]);
    expect(jars.calls).toEqual([]);
  });

  it('reports size-limit failures as HTTP 413', async () => {
    await expect(importBackup(Buffer.alloc(MAX_BACKUP_BYTES + 1), storeWith([]), jarsWith({}), 'merge'))
      .rejects.toMatchObject({ statusCode: 413 });
  });

  it('rejects an invalid account version before calling replaceAll', async () => {
    const store = storeWith([account(1)]);
    store.replaceAll = (accounts) => { store.calls.push('replaceAll'); store.accounts.splice(0, store.accounts.length, ...accounts); };
    const input = Buffer.from(JSON.stringify({ app: BACKUP_APP, schema: BACKUP_SCHEMA, accounts: [{ ...account(2), version: 0 }], cookies: [] }));
    await expect(importBackup(input, store, jarsWith({}), 'merge')).rejects.toThrow(/account/i);
    expect(store.calls).toEqual([]);
  });

  it.each([
    { avatar: 123 }, { proxy: [] }, { proxyPool: ['ok', 3] },
    { tags: 'bad' }, { group: false }, { pinned: 'yes' },
    { lastUsedAt: -1 }, { logged: 'yes' }, { fp: { locale: 123 } },
  ])('validates all account fields before mutation: %j', async (invalidFields) => {
    const store = storeWith([account(10)]);
    const jars = jarsWith({});
    const input = Buffer.from(JSON.stringify({
      app: BACKUP_APP, schema: BACKUP_SCHEMA,
      accounts: [account(11), { ...account(12), ...invalidFields }], cookies: [],
    }));
    await expect(importBackup(input, store, jars, 'merge')).rejects.toThrow(/account/i);
    expect(store.calls).toEqual([]);
    expect(jars.calls).toEqual([]);
  });

  it.each([
    { key: 'sid', value: 'private' },
    { key: 'sid', value: 'private', domain: 7, path: '/' },
    { key: 'sid', value: 'private', domain: 'muse.example', path: 'relative' },
    { key: 'sid', value: 'private', domain: 'muse.example', path: '/', secure: 'yes' },
  ])('rejects malformed cookie scope and flags before mutation: %j', async (cookie) => {
    const store = storeWith([]);
    const jars = jarsWith({});
    const input = Buffer.from(JSON.stringify({ app: BACKUP_APP, schema: BACKUP_SCHEMA, accounts: [account(1)], cookies: [{ accountId: 1, jar: { cookies: [cookie] } }] }));
    await expect(importBackup(input, store, jars, 'merge')).rejects.toThrow(/cookie/i);
    expect(store.calls).toEqual([]);
    expect(jars.calls).toEqual([]);
  });

  it('validates every serialized jar before writing any account', async () => {
    const store = storeWith([account(10)]);
    const jars = jarsWith({});
    const input = Buffer.from(JSON.stringify({
      app: BACKUP_APP, schema: BACKUP_SCHEMA,
      accounts: [account(11), account(12)],
      cookies: [{ accountId: 11, jar: { cookies: [] } }, { accountId: 12, jar: { cookies: 'PRIVATE_COOKIE' } }],
    }));
    await expect(importBackup(input, store, jars, 'merge')).rejects.toThrow(/cookie/i);
    expect(store.calls).toEqual([]);
    expect(jars.calls).toEqual([]);
  });

  it('rejects duplicate cookie IDs in an otherwise valid envelope', async () => {
    const store = storeWith([account(10)]);
    const jars = jarsWith({});
    const input = Buffer.from(JSON.stringify({
      app: BACKUP_APP, schema: BACKUP_SCHEMA,
      accounts: [account(11)],
      cookies: [{ accountId: 11, jar: { cookies: [] } }, { accountId: 11, jar: { cookies: [] } }],
    }));
    await expect(importBackup(input, store, jars, 'merge')).rejects.toThrow(/duplicate cookie/i);
    expect(store.calls).toEqual([]);
    expect(jars.calls).toEqual([]);
  });

  it('restores an empty replacement by deleting all accounts and their jars', async () => {
    const store = storeWith([account(10)]);
    const jars = jarsWith({ 10: { cookies: [] } });
    const input = Buffer.from(JSON.stringify({ app: BACKUP_APP, schema: BACKUP_SCHEMA, accounts: [], cookies: [] }));
    await expect(importBackup(input, store, jars, 'replace')).resolves.toMatchObject({ imported: 0, removed: 1 });
    expect(store.accounts).toEqual([]);
    expect(jars.values).toEqual({});
  });

  it('checks restoration capabilities before writing any account', async () => {
    const store = storeWith([]);
    const input = Buffer.from(JSON.stringify({
      app: BACKUP_APP, schema: BACKUP_SCHEMA, accounts: [account(11)],
      cookies: [{ accountId: 11, jar: { cookies: [] } }],
    }));
    await expect(importBackup(input, store, {}, 'merge')).rejects.toThrow(/restore/i);
    expect(store.calls).toEqual([]);
  });

  it('rolls back accounts and jars when a later jar restore fails', async () => {
    const store = storeWith([account(1, 'original'), account(2, 'removed')]);
    const originalJars = { 1: { cookies: [{ key: 'sid', value: 'original' }] }, 2: { cookies: [] } };
    const jars = jarsWith(originalJars);
    const restore = jars.restore!;
    let failed = false;
    jars.restore = async (id, value) => {
      if (id === 3 && !failed) { failed = true; throw new Error('PRIVATE_COOKIE persistence failed'); }
      await restore(id, value);
    };
    const input = Buffer.from(JSON.stringify({
      app: BACKUP_APP, schema: BACKUP_SCHEMA,
      accounts: [account(1, 'changed'), account(3, 'new')],
      cookies: [{ accountId: 1, jar: { cookies: [] } }, { accountId: 3, jar: { cookies: [] } }],
    }));
    await expect(importBackup(input, store, jars, 'replace')).rejects.toThrow(/^Backup import failed; previous state restored$/);
    expect(store.accounts).toEqual([account(1, 'original'), account(2, 'removed')]);
    expect(jars.values).toEqual(originalJars);
  });

  it('rolls back an earlier account update when a later create fails', async () => {
    const store = storeWith([account(1, 'original')]);
    store.create = () => { throw new Error('PRIVATE_STORE failure'); };
    const jars = jarsWith({ 1: { cookies: [] } });
    const input = Buffer.from(JSON.stringify({
      app: BACKUP_APP, schema: BACKUP_SCHEMA,
      accounts: [account(1, 'changed'), account(3, 'new')], cookies: [],
    }));
    await expect(importBackup(input, store, jars, 'merge')).rejects.toThrow(/^Backup import failed; previous state restored$/);
    expect(store.accounts).toEqual([account(1, 'original')]);
  });

  it('merges new accounts, updates existing metadata, and restores supplied jars', async () => {
    const store = storeWith([account(1, 'old'), account(2, 'kept')]);
    const jars = jarsWith({ 1: { cookies: [{ key: 'old', value: '1' }] }, 2: { cookies: [] } });
    const input = Buffer.from(JSON.stringify({
      app: BACKUP_APP,
      schema: BACKUP_SCHEMA,
      exportedAt: 100,
      accounts: [account(1, 'new'), account(3, 'added')],
      cookies: [{ accountId: 1, jar: { cookies: [{ key: 'sid', value: 'new', domain: 'muse.example', path: '/' }] } }],
    }));

    const result = await importBackup(input, store, jars, 'merge');

    expect(result).toMatchObject({ mode: 'merge', imported: 2, created: 1, updated: 1, removed: 0, cookiesImported: 1 });
    expect(store.accounts).toEqual([account(1, 'new'), account(2, 'kept'), account(3, 'added')]);
    expect(jars.values[1]).toEqual({ cookies: [{ key: 'sid', value: 'new', domain: 'muse.example', path: '/' }] });
    expect(jars.values[2]).toEqual({ cookies: [] });
  });

  it('replaces accounts and clears jars absent from a complete replacement', async () => {
    const store = storeWith([account(1, 'old'), account(2, 'removed')]);
    const jars = jarsWith({ 1: { cookies: [{ key: 'old', value: '1' }] }, 2: { cookies: [{ key: 'old', value: '2' }] } });
    const input = Buffer.from(JSON.stringify({
      app: BACKUP_APP,
      schema: BACKUP_SCHEMA,
      accounts: [account(1, 'restored'), account(3, 'new')],
      cookies: [],
    }));

    const result = await importBackup(input, store, jars, 'replace');

    expect(result).toMatchObject({ mode: 'replace', imported: 2, created: 1, updated: 1, removed: 1, cookiesImported: 0 });
    expect(store.accounts).toEqual([account(1, 'restored'), account(3, 'new')]);
    expect(jars.values).toEqual({});
    expect(jars.calls).toEqual(['clear:1', 'clear:2', 'clear:3']);
  });

  it('rejects duplicate account IDs before any store or jar mutation', async () => {
    const store = storeWith([account(10)]);
    const jars = jarsWith({ 10: { cookies: [{ key: 'sid', value: 'old' }] } });
    const input = Buffer.from(JSON.stringify({
      app: BACKUP_APP,
      schema: BACKUP_SCHEMA,
      accounts: [account(10), account(10, 'duplicate')],
      cookies: [],
    }));

    await expect(importBackup(input, store, jars, 'merge')).rejects.toThrow(/duplicate account id/i);
    expect(store.calls).toEqual([]);
    expect(jars.calls).toEqual([]);
    expect(store.accounts).toEqual([account(10)]);
  });

  it('rejects duplicate cookie IDs and malformed schema before any mutation', async () => {
    const store = storeWith([account(10)]);
    const jars = jarsWith({ 10: { cookies: [{ key: 'sid', value: 'old' }] } });
    const input = Buffer.from(JSON.stringify({
      app: BACKUP_APP,
      schema: BACKUP_SCHEMA + 1,
      accounts: [account(10)],
      cookies: [
        { accountId: 10, jar: {} },
        { accountId: 10, jar: {} },
      ],
    }));

    await expect(importBackup(input, store, jars, 'merge')).rejects.toThrow(/schema/i);
    expect(store.calls).toEqual([]);
    expect(jars.calls).toEqual([]);
  });

  it('rejects a cookie for an unknown account before mutation', async () => {
    const store = storeWith([account(10)]);
    const jars = jarsWith({ 10: { cookies: [] } });
    const input = Buffer.from(JSON.stringify({
      app: BACKUP_APP,
      schema: BACKUP_SCHEMA,
      accounts: [account(10)],
      cookies: [{ accountId: 99, jar: {} }],
    }));

    await expect(importBackup(input, store, jars, 'merge')).rejects.toThrow(/unknown account/i);
    expect(store.calls).toEqual([]);
    expect(jars.calls).toEqual([]);
  });

  it('rejects payloads larger than the configured maximum before mutation', async () => {
    const store = storeWith([account(10)]);
    const jars = jarsWith({});
    const oversized = Buffer.from(JSON.stringify({
      app: BACKUP_APP,
      schema: BACKUP_SCHEMA,
      accounts: [{ ...account(11), note: 'x'.repeat(MAX_BACKUP_BYTES) }],
      cookies: [],
    }));

    await expect(importBackup(oversized, store, jars, 'merge')).rejects.toThrow(/too large/i);
    expect(store.calls).toEqual([]);
    expect(jars.calls).toEqual([]);
  });

  it('rejects an invalid mode without mutating dependencies', async () => {
    const store = storeWith([account(10)]);
    const jars = jarsWith({});
    const input = Buffer.from(JSON.stringify({
      app: BACKUP_APP,
      schema: BACKUP_SCHEMA,
      accounts: [],
      cookies: [],
    }));

    await expect(importBackup(input, store, jars, 'append' as never)).rejects.toThrow(/mode/i);
    expect(store.calls).toEqual([]);
    expect(jars.calls).toEqual([]);
  });

  it('checks replace capabilities before mutating the account store', async () => {
    const store = storeWith([account(10)]);
    const jars: CookieJarStoreLike = { restore: vi.fn() };
    const input = Buffer.from(JSON.stringify({
      app: BACKUP_APP,
      schema: BACKUP_SCHEMA,
      accounts: [],
      cookies: [],
    }));

    await expect(importBackup(input, store, jars, 'replace')).rejects.toThrow(/replace jars/i);
    expect(store.calls).toEqual([]);
    expect(jars.restore).not.toHaveBeenCalled();
  });

  it('supports callback-style cookie jar serialization through get()', async () => {
    const store = storeWith([account(1)]);
    const jars = {
      get: vi.fn(async () => ({
        serialize: (callback: (error: Error | null, value?: unknown) => void) =>
          callback(null, { version: 1, cookies: [] }),
      })),
    } satisfies CookieJarStoreLike;

    const parsed = JSON.parse((await exportBackup(store, jars)).toString('utf8'));
    expect(parsed.cookies).toEqual([{ accountId: 1, jar: { version: 1, cookies: [] } }]);
  });
});
