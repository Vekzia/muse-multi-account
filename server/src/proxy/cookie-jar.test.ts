import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CookieJar } from 'tough-cookie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountCookieJar } from './cookie-jar.js';

let dataDir: string;
beforeEach(async () => { dataDir = await mkdtemp(join(tmpdir(), 'muse-jars-')); });
afterEach(async () => { await rm(dataDir, { recursive: true, force: true }); });

const origin = 'https://muse.example/';

describe('AccountCookieJar', () => {
  it('persists full Set-Cookie semantics in separate account files and reloads them', async () => {
    const jars = new AccountCookieJar(dataDir);
    const first = await jars.get(1);
    const second = await jars.get(2);
    await first.setCookie('session=FIRST_PRIVATE; Path=/; Secure; HttpOnly; SameSite=Lax', origin);
    await first.setCookie('section=SECTION_PRIVATE; Path=/private; Secure', origin);
    await second.setCookie('session=SECOND_PRIVATE; Path=/; Secure', origin);
    await Promise.all([jars.save(1, first), jars.save(2, second)]);

    const reloaded = new AccountCookieJar(dataDir);
    expect(await (await reloaded.load(1)).getCookieString(origin)).toBe('session=FIRST_PRIVATE');
    expect(await (await reloaded.get(2)).getCookieString(origin)).toBe('session=SECOND_PRIVATE');
    expect(await (await reloaded.get(1)).getCookieString('https://muse.example/private/page'))
      .toBe('section=SECTION_PRIVATE; session=FIRST_PRIVATE');
    expect(await (await reloaded.get(1)).getCookieString('https://other.example/')).toBe('');
    const cookies = await (await reloaded.get(1)).getCookies(origin);
    expect(cookies[0]).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax' });
    expect((await stat(join(dataDir, 'cookies', '1.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dataDir, 'cookies'))).mode & 0o777).toBe(0o700);
  });

  it('shares one jar for simultaneous requests to an account', async () => {
    const jars = new AccountCookieJar(dataDir);
    const [first, again, other] = await Promise.all([jars.get(1), jars.get(1), jars.get(2)]);
    expect(first).toBe(again);
    expect(first).not.toBe(other);
    await first.setCookie('session=one; Path=/', origin);
    expect(await again.getCookieString(origin)).toBe('session=one');
    expect(await other.getCookieString(origin)).toBe('');
  });

  it('atomically replaces cookie files without exposing partial JSON or leaving temporary files', async () => {
    const jars = new AccountCookieJar(dataDir);
    const file = join(dataDir, 'cookies', '1.json');
    const initial = new CookieJar();
    await initial.setCookie('session=initial; Path=/', origin);
    await jars.save(1, initial);
    const next = new CookieJar();
    await next.setCookie(`session=${'x'.repeat(100_000)}; Path=/`, origin);
    const writes = Array.from({ length: 12 }, () => jars.save(1, next));
    for (let index = 0; index < 30; index++) {
      const snapshot = JSON.parse(await readFile(file, 'utf8'));
      expect(snapshot.cookies[0].value).toMatch(/^(initial|x+)$/);
    }
    await Promise.all(writes);
    expect(await readdir(join(dataDir, 'cookies'))).toEqual(['1.json']);
    expect(await (await new AccountCookieJar(dataDir).load(1)).getCookieString(origin))
      .toBe(`session=${'x'.repeat(100_000)}`);
  });

  it('replaces the cached jar after clear and retires pending old references', async () => {
    const jars = new AccountCookieJar(dataDir);
    const pendingOld = jars.get(1);
    await jars.clear(1);
    const old = await pendingOld;
    const fresh = await jars.get(1);

    expect(fresh).not.toBe(old);
    await old.setCookie('late=old; Path=/', origin);
    expect(await fresh.getCookieString(origin)).toBe('');
    await expect(jars.save(1, old)).rejects.toThrow(/^Cookie jar save failed$/);
    expect(await (await new AccountCookieJar(dataDir).get(1)).getCookieString(origin)).toBe('');
  });

  it('retires an in-flight disk load before clear completes', async () => {
    const writer = new AccountCookieJar(dataDir);
    const persisted = await writer.get(1);
    await persisted.setCookie('session=BEFORE_CLEAR; Path=/', origin);
    await writer.save(1, persisted);
    const jars = new AccountCookieJar(dataDir);
    const load = jars.load.bind(jars);
    let release!: () => void;
    let loaded!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { loaded = resolve; });
    const delayed = vi.spyOn(jars, 'load').mockImplementationOnce(async (id) => {
      const jar = await load(id);
      loaded();
      await held;
      return jar;
    });
    const pending = jars.get(1);
    await ready;
    const clearing = jars.clear(1);
    release();
    await clearing;
    delayed.mockRestore();
    const old = await pending;
    const fresh = await jars.get(1);
    expect(fresh).not.toBe(old);
    expect(await old.getCookieString(origin)).toBe('');
    await old.setCookie('late=OLD_RESPONSE; Path=/', origin);
    await expect(jars.save(1, old)).rejects.toThrow(/^Cookie jar save failed$/);
    expect(await fresh.getCookieString(origin)).toBe('');
    expect(await (await new AccountCookieJar(dataDir).load(1)).getCookieString(origin)).toBe('');
  });

  it('keeps a replacement cache when an older pending load fails', async () => {
    const jars = new AccountCookieJar(dataDir);
    let fail!: (error: Error) => void;
    const delayed = vi.spyOn(jars, 'load').mockImplementationOnce(() => new Promise<CookieJar>((_resolve, reject) => { fail = reject; }));
    const pending = jars.get(1).catch(() => undefined);
    const replacement = new CookieJar();
    await jars.save(1, replacement);
    await replacement.setCookie('unsaved=CURRENT_SESSION; Path=/', origin);
    fail(new Error('Cookie jar load failed'));
    await pending;
    delayed.mockRestore();
    expect(await jars.get(1)).toBe(replacement);
    expect(await (await jars.get(1)).getCookieString(origin)).toBe('unsaved=CURRENT_SESSION');
  });

  it('clears one account on disk and in existing references without touching another', async () => {
    const jars = new AccountCookieJar(dataDir);
    const first = await jars.get(1);
    const second = await jars.get(2);
    await first.setCookie('session=first; Path=/', origin);
    await second.setCookie('session=second; Path=/', origin);
    await Promise.all([jars.save(1, first), jars.save(2, second)]);
    await jars.clear(1);
    expect(await first.getCookieString(origin)).toBe('');
    const replacement = await jars.get(1);
    expect(replacement).not.toBe(first);
    await first.setCookie('late=OLD_RESPONSE; Path=/', origin);
    expect(await replacement.getCookieString(origin)).toBe('');
    expect(await (await new AccountCookieJar(dataDir).get(1)).getCookieString(origin)).toBe('');
    expect(await second.getCookieString(origin)).toBe('session=second');
    expect(await (await new AccountCookieJar(dataDir).get(2)).getCookieString(origin)).toBe('session=second');
    await expect(jars.clear(3)).resolves.toBeUndefined();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '../PRIVATE_PATH'])
  ('rejects unsafe account ids before using the filesystem: %s', async (id) => {
    const jars = new AccountCookieJar(dataDir);
    await expect(jars.get(id as number)).rejects.toThrow(/^Invalid account ID$/);
    await expect(jars.load(id as number)).rejects.toThrow(/^Invalid account ID$/);
    await expect(jars.save(id as number, new CookieJar())).rejects.toThrow(/^Invalid account ID$/);
    await expect(jars.clear(id as number)).rejects.toThrow(/^Invalid account ID$/);
    expect(await readdir(dataDir)).toEqual([]);
  });

  it('fails closed on corrupt cookies without echoing file content or paths', async () => {
    await mkdir(join(dataDir, 'cookies'));
    await writeFile(join(dataDir, 'cookies', '1.json'), '{"PRIVATE_COOKIE":"PRIVATE_SECRET"');
    const jars = new AccountCookieJar(dataDir);
    await expect(jars.load(1)).rejects.toThrow(/^Cookie jar load failed$/);
    await writeFile(join(dataDir, 'cookies', '1.json'), JSON.stringify({ cookies: 'PRIVATE_SECRET' }));
    await expect(jars.get(1)).rejects.toThrow(/^Cookie jar load failed$/);
  });

  it('restores a serialized backup jar and rejects invalid backups before mutation', async () => {
    const jars = new AccountCookieJar(dataDir);
    const backup = new CookieJar();
    await backup.setCookie('session=RESTORED; Path=/; Secure; HttpOnly', origin);
    await jars.restore(1, backup.toJSON());
    expect(await (await jars.get(1)).getCookieString(origin)).toBe('session=RESTORED');
    await expect(jars.restore(1, { cookies: 'PRIVATE_SECRET' })).rejects.toThrow(/^Invalid cookie jar data$/);
    expect(await (await new AccountCookieJar(dataDir).get(1)).getCookieString(origin)).toBe('session=RESTORED');
  });

  it.each([{}, { cookies: [null] }, { cookies: [{}] }, { cookies: [{ key: 'session', value: 'PRIVATE_SECRET' }] }])
  ('rejects incomplete persisted cookie records before replacing valid state', async (invalid) => {
    const jars = new AccountCookieJar(dataDir);
    const jar = await jars.get(1);
    await jar.setCookie('session=original; Path=/', origin);
    await jars.save(1, jar);
    await expect(jars.restore(1, invalid)).rejects.toThrow(/^Invalid cookie jar data$/);
    expect(await (await new AccountCookieJar(dataDir).load(1)).getCookieString(origin)).toBe('session=original');
  });

  it('does not leak filesystem errors or cookie values when persistence fails', async () => {
    await writeFile(join(dataDir, 'cookies'), 'not a directory');
    const jar = new CookieJar();
    await jar.setCookie('session=PRIVATE_SECRET; Path=/', origin);
    const jars = new AccountCookieJar(dataDir);
    await expect(jars.save(1, jar)).rejects.toThrow(/^Cookie jar save failed$/);
  });
});
