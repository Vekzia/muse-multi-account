import { CookieJar } from 'tough-cookie';
import type { AccountInput } from '../types.js';
import { migrateLegacyFingerprint } from '../fingerprint/profile.js';
import { normalizeKeepAlive } from '../storage/account-store.js';

/** Current server backup envelope identifier. Android MUSEBAK1 is a separate format. */
export const BACKUP_APP = 'muse-multi-account-server';
export const BACKUP_SCHEMA = 1;
export const MAX_BACKUP_BYTES = 10 * 1024 * 1024;

/** Derive backup metadata from the shared account input contract. */
export type AccountRecord = { [Key in keyof AccountInput]: Exclude<AccountInput[Key], null> } & {
  id: number;
  version?: number;
};

export type CookieJarSnapshot = Record<string, unknown>;

export interface AccountStoreLike {
  list(): AccountRecord[] | readonly AccountRecord[] | Promise<AccountRecord[] | readonly AccountRecord[]>;
  create(account: AccountRecord): AccountRecord | Promise<AccountRecord>;
  update(id: number, patch: Partial<AccountRecord>): AccountRecord | Promise<AccountRecord>;
  remove(id: number): void | Promise<void>;
  /** Optional atomic replacement hook for stores that can commit one snapshot. */
  replaceAll?(accounts: AccountRecord[]): void | Promise<void>;
}

export interface CookieJarLike {
  toJSON?(): unknown;
  serialize?(callback?: (error: Error | null, value?: unknown) => void): unknown;
}

export interface CookieJarStoreLike {
  /** Preferred explicit export hook. */
  export?(accountId: number): unknown | Promise<unknown>;
  get?(accountId: number): CookieJarLike | unknown | Promise<CookieJarLike | unknown>;
  /** Preferred explicit import hook. */
  restore?(accountId: number, serialized: unknown): void | Promise<void>;
  save?(accountId: number, jar: CookieJarLike): void | Promise<void>;
  clear?(accountId: number): void | Promise<void>;
}

export type BackupMode = 'merge' | 'replace';

export interface BackupDocument {
  app: typeof BACKUP_APP;
  schema: typeof BACKUP_SCHEMA;
  exportedAt: number;
  accounts: AccountRecord[];
  cookies: Array<{ accountId: number; jar: unknown }>;
}

export interface ImportResult {
  mode: BackupMode;
  imported: number;
  created: number;
  updated: number;
  removed: number;
  cookiesImported: number;
}

class BackupError extends Error {
  readonly statusCode: 400 | 413 | 500;

  constructor(message: string, statusCode: 400 | 413 | 500 = 400) {
    super(message);
    this.name = 'BackupError';
    this.statusCode = statusCode;
  }
}

/** Serialize the current account metadata and account-scoped cookie jars. */
export async function exportBackup(
  store: AccountStoreLike,
  jars: CookieJarStoreLike,
): Promise<Buffer> {
  const accounts = (await store.list()).map((account) => cloneAccount(account));
  const cookies: Array<{ accountId: number; jar: unknown }> = [];
  for (const account of accounts) {
    const jar = await exportJar(jars, account.id);
    cookies.push({ accountId: account.id, jar });
  }

  const document: BackupDocument = {
    app: BACKUP_APP,
    schema: BACKUP_SCHEMA,
    exportedAt: Date.now(),
    accounts,
    cookies,
  };
  const payload = Buffer.from(JSON.stringify(document), 'utf8');
  if (payload.byteLength > MAX_BACKUP_BYTES) throw new BackupError('Backup is too large', 413);
  return payload;
}

/**
 * Validate the complete input before calling a store or cookie jar method.
 * Merge updates matching IDs; replace removes accounts and jars absent from the input.
 */
export async function importBackup(
  buffer: Buffer,
  store: AccountStoreLike,
  jars: CookieJarStoreLike,
  mode: BackupMode,
): Promise<ImportResult> {
  if (mode !== 'merge' && mode !== 'replace') throw new BackupError('Invalid backup mode');
  const document = parseBackup(buffer);
  const current = (await store.list()).map((account) => cloneAccount(account));
  const currentById = new Map(current.map((account) => [account.id, account]));
  const incomingIds = new Set(document.accounts.map((account) => account.id));

  // Build the complete plan before mutating either dependency.
  const createdAccounts = document.accounts.filter((account) => !currentById.has(account.id));
  const updatedAccounts = document.accounts.filter((account) => currentById.has(account.id));
  const removedAccounts = mode === 'replace'
    ? current.filter((account) => !incomingIds.has(account.id))
    : [];
  const clearJarIds = mode === 'replace'
    ? uniqueIds([...current.map((account) => account.id), ...document.accounts.map((account) => account.id)])
    : [];
  if (mode === 'replace' && !jars.clear) throw new BackupError('Cookie jar store cannot replace jars');
  if (document.cookies.length && !jars.restore && !jars.save) {
    throw new BackupError('Cookie jar store cannot restore jars');
  }

  const touchedJarIds = mode === 'replace' ? clearJarIds : document.cookies.map((cookie) => cookie.accountId);
  if (touchedJarIds.length && (!jars.clear || (!jars.restore && !jars.save))) {
    throw new BackupError('Cookie jar store cannot restore a rollback snapshot');
  }
  const previousJars = new Map<number, unknown>();
  for (const id of touchedJarIds) previousJars.set(id, await exportJar(jars, id));

  const incomingById = new Map(document.accounts.map((account) => [account.id, account]));
  const next = mode === 'replace'
    ? document.accounts.map(cloneAccount)
    : [...current.map((account) => cloneAccount(incomingById.get(account.id) ?? account)), ...createdAccounts.map(cloneAccount)];
  try {
    if (store.replaceAll) {
      await store.replaceAll(next);
    } else {
      for (const account of removedAccounts) await store.remove(account.id);
      for (const account of updatedAccounts) await store.update(account.id, cloneAccount(account));
      for (const account of createdAccounts) await store.create(cloneAccount(account));
    }
    if (mode === 'replace') {
      for (const id of clearJarIds) await jars.clear!(id);
    }
    for (const cookie of document.cookies) await restoreJar(jars, cookie.accountId, cookie.jar);
  } catch {
    let rollbackFailed = false;
    try {
      if (store.replaceAll) await store.replaceAll(current.map(cloneAccount));
      else {
        const now = await store.list();
        const nowIds = new Set(now.map((account) => account.id));
        for (const account of now) if (!currentById.has(account.id)) await store.remove(account.id);
        for (const account of current) {
          if (nowIds.has(account.id)) await store.update(account.id, cloneAccount(account));
          else await store.create(cloneAccount(account));
        }
      }
    } catch { rollbackFailed = true; }
    for (const [id, jar] of previousJars) {
      try {
        if (jar === undefined) await jars.clear!(id);
        else await restoreJar(jars, id, jar);
      } catch { rollbackFailed = true; }
    }
    throw new BackupError(rollbackFailed
      ? 'Backup import failed; rollback incomplete'
      : 'Backup import failed; previous state restored');
  }

  return {
    mode,
    imported: document.accounts.length,
    created: createdAccounts.length,
    updated: updatedAccounts.length,
    removed: removedAccounts.length,
    cookiesImported: document.cookies.length,
  };
}

function parseBackup(buffer: Buffer): BackupDocument {
  if (!Buffer.isBuffer(buffer)) throw new BackupError('Backup payload must be a buffer');
  if (buffer.byteLength > MAX_BACKUP_BYTES) throw new BackupError('Backup is too large', 413);
  let value: unknown;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new BackupError('Backup JSON is malformed');
  }
  if (!isRecord(value)) throw new BackupError('Backup root must be an object');
  if (value.app !== BACKUP_APP) throw new BackupError('Unsupported backup app');
  if (value.schema !== BACKUP_SCHEMA) throw new BackupError('Unsupported backup schema');
  if (!Array.isArray(value.accounts)) throw new BackupError('Backup accounts must be an array');
  if (!Array.isArray(value.cookies)) throw new BackupError('Backup cookies must be an array');
  if (value.exportedAt !== undefined && (typeof value.exportedAt !== 'number' || !Number.isSafeInteger(value.exportedAt) || value.exportedAt < 0)) {
    throw new BackupError('Malformed backup timestamp');
  }

  const accounts: AccountRecord[] = [];
  const accountIds = new Set<number>();
  for (const raw of value.accounts) {
    if (!isRecord(raw) || !isValidAccountId(raw.id) || typeof raw.name !== 'string' || raw.name.trim() === '' || !validAccountMetadata(raw)) {
      throw new BackupError('Malformed account record');
    }
    if (accountIds.has(raw.id)) throw new BackupError(`Duplicate account ID ${raw.id}`);
    accountIds.add(raw.id);
    accounts.push(cloneAccount({ ...raw, id: raw.id, name: raw.name,
      ...(raw.fp === undefined ? {} : { fp: migrateLegacyFingerprint(raw.fp, raw.id) }),
      keepAlive: normalizeKeepAlive(raw.keepAlive),
    }));
  }

  const cookies: Array<{ accountId: number; jar: unknown }> = [];
  const cookieIds = new Set<number>();
  for (const raw of value.cookies) {
    if (!isRecord(raw) || !isValidAccountId(raw.accountId) || !('jar' in raw) || !isRecord(raw.jar)) {
      throw new BackupError('Malformed cookie jar record');
    }
    if (!accountIds.has(raw.accountId)) throw new BackupError(`Unknown account ID ${raw.accountId} in cookie jar`);
    if (cookieIds.has(raw.accountId)) throw new BackupError(`Duplicate cookie jar ID ${raw.accountId}`);
    cookieIds.add(raw.accountId);
    if (!Array.isArray(raw.jar.cookies) || raw.jar.cookies.some((cookie) => !validCookie(cookie))) {
      throw new BackupError('Malformed cookie jar data');
    }
    try {
      CookieJar.fromJSON(raw.jar as Parameters<typeof CookieJar.fromJSON>[0]);
    } catch {
      throw new BackupError('Malformed cookie jar data');
    }
    cookies.push({ accountId: raw.accountId, jar: cloneJson(raw.jar) });
  }

  return {
    app: BACKUP_APP,
    schema: BACKUP_SCHEMA,
    exportedAt: typeof value.exportedAt === 'number' ? value.exportedAt : 0,
    accounts,
    cookies,
  };
}

async function exportJar(jars: CookieJarStoreLike, id: number): Promise<unknown> {
  if (jars.export) return cloneJson(await jars.export(id));
  if (!jars.get) throw new BackupError('Cookie jar store cannot export jars');
  const candidate = await jars.get(id);
  if (!candidate || typeof candidate !== 'object') throw new BackupError('Cookie jar export failed');
  const jar = candidate as CookieJarLike;
  if (typeof jar.toJSON === 'function') return cloneJson(jar.toJSON());
  if (typeof jar.serialize === 'function') {
    const serialize = jar.serialize.bind(jar) as CookieJarLike['serialize'];
    if (!serialize) throw new BackupError('Cookie jar export failed');
    if (serialize.length > 0) {
      return await new Promise<unknown>((resolve, reject) => {
        serialize((error, value) => error ? reject(new BackupError('Cookie jar export failed')) : resolve(value));
      }).then(cloneJson);
    }
    return cloneJson(await serialize());
  }
  throw new BackupError('Cookie jar export failed');
}

async function restoreJar(jars: CookieJarStoreLike, id: number, serialized: unknown): Promise<void> {
  if (jars.restore) {
    await jars.restore(id, cloneJson(serialized));
    return;
  }
  if (!jars.save) throw new BackupError('Cookie jar store cannot restore jars');
  // AccountCookieJar.save expects a tough-cookie CookieJar. This fallback keeps the
  // module usable with the foundation's get/load/save contract until restore is added.
  try {
    await jars.save(id, CookieJar.fromJSON(serialized as Parameters<typeof CookieJar.fromJSON>[0]));
  } catch {
    throw new BackupError('Cookie jar restore failed');
  }
}

function cloneAccount(account: AccountRecord): AccountRecord {
  return cloneJson(account) as AccountRecord;
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  try {
    return structuredClone(value);
  } catch {
    throw new BackupError('Backup contains unsupported data');
  }
}

function validAccountMetadata(account: Record<string, unknown>): boolean {
  for (const key of ['avatar', 'proxy', 'group']) {
    if (account[key] !== undefined && typeof account[key] !== 'string') return false;
  }
  for (const key of ['proxyPool', 'tags']) {
    const value = account[key];
    if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))) return false;
  }
  for (const key of ['pinned', 'logged']) {
    if (account[key] !== undefined && typeof account[key] !== 'boolean') return false;
  }
  for (const key of ['lastUsedAt', 'version']) {
    const value = account[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || (key === 'version' ? value < 1 : value < 0))) return false;
  }
  if (account.keepAlive !== undefined) {
    try { normalizeKeepAlive(account.keepAlive); } catch { return false; }
  }
  if (account.fp !== undefined) {
    if (!isRecord(account.fp)) return false;
    try { migrateLegacyFingerprint(account.fp, account.id as number); } catch { return false; }
  }
  return true;
}

function validCookie(value: unknown): boolean {
  if (!isRecord(value) || typeof value.key !== 'string' || typeof value.value !== 'string' ||
      typeof value.domain !== 'string' || !value.domain || typeof value.path !== 'string' || !value.path.startsWith('/')) return false;
  if (/[\x00-\x1f\x7f]/.test(value.key + value.value + value.domain + value.path)) return false;
  for (const key of ['secure', 'httpOnly', 'hostOnly', 'pathIsDefault']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') return false;
  }
  if (value.sameSite !== undefined && !['strict', 'lax', 'none'].includes(String(value.sameSite))) return false;
  for (const key of ['creation', 'lastAccessed', 'expires']) {
    const date = value[key];
    if (date !== undefined && (typeof date !== 'string' || (date !== 'Infinity' && !Number.isFinite(Date.parse(date))))) return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isValidAccountId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function uniqueIds(ids: number[]): number[] {
  return [...new Set(ids)];
}
