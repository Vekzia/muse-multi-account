import { mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Cookie, CookieJar } from 'tough-cookie';
import { normalizeCookieExpiry } from './cookie-expiry.js';

export type ToughCookieJar = CookieJar;
export type SerializedCookieJar = ReturnType<CookieJar['toJSON']>;

const ACCOUNT_ID = /^[1-9]\d*$/;

function validateAccountId(id: number): void {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid account ID');
}

/** Persistent, account-scoped tough-cookie jars. */
export class AccountCookieJar {
  private readonly cache = new Map<number, Promise<CookieJar>>();
  private readonly writes = new Map<number, Promise<void>>();
  private readonly retired = new WeakSet<CookieJar>();
  private readonly cookiesDir: string;

  constructor(private readonly dataDir: string) {
    this.cookiesDir = join(dataDir, 'cookies');
  }

  async get(id: number): Promise<CookieJar> {
    validateAccountId(id);
    const existing = this.cache.get(id);
    if (existing) return existing;
    const pending = this.load(id);
    this.cache.set(id, pending);
    try {
      return await pending;
    } catch (error) {
      if (this.cache.get(id) === pending) this.cache.delete(id);
      throw error;
    }
  }

  async load(id: number): Promise<CookieJar> {
    validateAccountId(id);
    try {
      const serialized = await readFile(this.fileFor(id), 'utf8');
      const value: unknown = JSON.parse(serialized);
      return deserializeJar(value);
    } catch (error) {
      if (isMissingFile(error)) return new CookieJar();
      throw new Error('Cookie jar load failed');
    }
  }

  async restore(id: number, serialized: unknown): Promise<void> {
    validateAccountId(id);
    let jar: CookieJar;
    try {
      jar = deserializeJar(serialized);
    } catch {
      throw new Error('Invalid cookie jar data');
    }
    await this.save(id, jar);
  }

  async save(id: number, jar: CookieJar): Promise<void> {
    validateAccountId(id);
    if (!(jar instanceof CookieJar) || this.retired.has(jar)) throw new Error('Cookie jar save failed');
    const previous = this.writes.get(id) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (this.retired.has(jar)) throw new Error('Cookie jar save failed');
      const temporary = `${this.fileFor(id)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
      try {
        // Direct jar.setCookie callers also get a fixed deadline before any
        // snapshot is written. Store access avoids getCookies updating clocks.
        for (const cookie of await jar.store.getAllCookies()) {
          if (cookie.maxAge == null) continue;
          const anchor = persistedDate(cookie.lastAccessed) ?? persistedDate(cookie.creation);
          if (!normalizeCookieExpiry(cookie, anchor)) {
            await jar.store.removeCookie(cookie.domain, cookie.path, cookie.key);
          } else {
            await jar.store.putCookie(cookie);
          }
        }
        await mkdir(this.cookiesDir, { recursive: true, mode: 0o700 });
        await writeFile(temporary, JSON.stringify(jar.toJSON()), { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, this.fileFor(id));
        this.cache.set(id, Promise.resolve(jar));
      } catch {
        await unlink(temporary).catch(() => undefined);
        throw new Error('Cookie jar save failed');
      }
    });
    this.writes.set(id, next);
    try {
      await next;
    } finally {
      if (this.writes.get(id) === next) this.writes.delete(id);
    }
  }

  async clear(id: number): Promise<void> {
    validateAccountId(id);
    const previous = this.writes.get(id) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        await rm(this.fileFor(id), { force: true });
        const current = this.cache.get(id);
        if (current) {
          // A pending get belongs to the retired session as well. Await it
          // before completing clear, and never return that instance again.
          const jar = await current.catch(() => undefined);
          if (jar) {
            this.retired.add(jar);
            await clearJar(jar);
          }
        }
        this.cache.set(id, Promise.resolve(new CookieJar()));
      } catch {
        throw new Error('Cookie jar clear failed');
      }
    });
    this.writes.set(id, next);
    try {
      await next;
    } finally {
      if (this.writes.get(id) === next) this.writes.delete(id);
    }
  }

  private fileFor(id: number): string {
    if (!ACCOUNT_ID.test(String(id))) throw new Error('Invalid account ID');
    return join(this.cookiesDir, `${id}.json`);
  }
}

function deserializeJar(serialized: unknown): CookieJar {
  if (!serialized || typeof serialized !== 'object' || Array.isArray(serialized)
    || !('cookies' in serialized) || !Array.isArray(serialized.cookies)) throw new Error();
  const normalized = structuredClone({ ...serialized, cookies: serialized.cookies });
  normalized.cookies = normalized.cookies.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error();
    const fields = entry as Record<string, unknown>;
    if (typeof fields.key !== 'string' || typeof fields.value !== 'string'
      || typeof fields.domain !== 'string' || !fields.domain
      || typeof fields.path !== 'string' || !fields.path.startsWith('/')) throw new Error();
    const anchor = persistedDate(fields.lastAccessed) ?? persistedDate(fields.creation);
    // Validate even a superseded field before passing data to the permissive
    // tough-cookie JSON reader (which silently ignores wrong field types).
    persistedDate(fields.creation);
    persistedDate(fields.expires);
    if (fields.maxAge != null && fields.maxAge !== 'Infinity' && fields.maxAge !== '-Infinity'
      && (typeof fields.maxAge !== 'number' || !Number.isFinite(fields.maxAge) || !Number.isInteger(fields.maxAge))) throw new Error();
    const cookie = Cookie.fromJSON(fields);
    if (!cookie) throw new Error();
    // Legacy lastAccessed may already have slid. Freeze the stored snapshot;
    // missing anchors are unknown, never a reason to issue a fresh lifetime.
    if (!normalizeCookieExpiry(cookie, anchor)) return [];
    return [cookie.toJSON()];
  });
  return CookieJar.fromJSON(normalized as Parameters<typeof CookieJar.fromJSON>[0]);
}

function persistedDate(value: unknown): Date | undefined {
  if (value == null || value === 'Infinity') return undefined;
  if (!(value instanceof Date) && typeof value !== 'string' && typeof value !== 'number') throw new Error();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error();
  return date;
}

function clearJar(jar: CookieJar): Promise<void> {
  return new Promise((resolve, reject) => {
    jar.removeAllCookies((error) => error ? reject(error) : resolve());
  });
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
