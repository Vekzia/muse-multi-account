import { join } from 'node:path';
import type { Account, AccountInput, AccountListQuery, AccountPatch, AccountStoreState } from '../types.js';
import { createFingerprintSeed, generateFingerprint, migrateLegacyFingerprint, normalizeFingerprint, type FingerprintPreset } from '../fingerprint/profile.js';
import { JsonStore } from './json-store.js';

export type { Account, AccountInput, AccountListQuery, AccountPatch, AccountStoreState } from '../types.js';

export interface Store<T> {
  read(): T;
  write(next: T): void;
}

export interface AccountStoreOptions {
  now?: () => number;
}

export class AccountStoreError extends Error {
  public constructor(message: string, public readonly statusCode: 400 | 404 | 409 = 400) {
    super(message);
    this.name = 'AccountStoreError';
  }
}

const INITIAL_STATE: AccountStoreState = { schema: 1, nextId: 1, currentId: null, accounts: [] };

/** Single-process account repository; JSON replacement is atomic for other readers. */
export class AccountStore {
  private readonly store: Store<AccountStoreState>;
  private readonly now: () => number;
  private readonly loginState = new Map<number, boolean>();

  public constructor(dataDir: string | Store<AccountStoreState>, options: AccountStoreOptions = {}) {
    this.store = typeof dataDir === 'string'
      ? new JsonStore(join(dataDir, 'accounts.json'), INITIAL_STATE, parseState)
      : dataDir;
    this.now = options.now ?? Date.now;
    this.state();
  }

  public list(query: AccountListQuery = {}): Account[] {
    if (!query || typeof query !== 'object' || Array.isArray(query)) throw new AccountStoreError('Invalid account query');
    if (query.query != null && typeof query.query !== 'string') throw new AccountStoreError('Invalid search query');
    if (query.group != null && typeof query.group !== 'string') throw new AccountStoreError('Invalid group query');
    if (query.sort != null && !['manual', 'name', 'recent'].includes(query.sort)) throw new AccountStoreError('Invalid account sort');
    const text = (query.query ?? '').trim().toLowerCase();
    const accounts = this.state().accounts.filter((account) =>
      (query.group == null || account.group === query.group) &&
      [account.name, account.group, ...account.tags].some((value) => value.toLowerCase().includes(text)));
    accounts.sort((a, b) => {
      const pinOrder = Number(b.pinned) - Number(a.pinned);
      if (pinOrder !== 0) return pinOrder;
      if (query.sort === 'recent') return b.lastUsedAt - a.lastUsedAt;
      if (query.sort === 'name') {
        const left = a.name.toLowerCase();
        const right = b.name.toLowerCase();
        return left < right ? -1 : left > right ? 1 : 0;
      }
      return 0;
    });
    return accounts.map((account) => this.withLogin(account));
  }

  public get(id: number): Account | undefined {
    validId(id);
    const account = this.state().accounts.find((item) => item.id === id);
    return account ? this.withLogin(account) : undefined;
  }

  public peekNextId(): number {
    return this.state().nextId;
  }

  public create(input: AccountInput): Account {
    const state = this.state();
    if (state.nextId >= Number.MAX_SAFE_INTEGER) throw new AccountStoreError('Account ID space exhausted', 409);
    const raw = record(input);
    const fp = normalizeFingerprint(raw.fp, state.nextId);
    const suppliedSeed = raw.fp != null && Object.hasOwn(record(raw.fp), 'seed');
    const account = normalizeAccount({ ...raw, id: state.nextId, version: 1, fp: { ...fp, seed: suppliedSeed ? fp.seed : createFingerprintSeed() } });
    state.nextId++;
    state.accounts.push(account);
    state.currentId ??= account.id;
    this.save(state);
    this.loginState.set(account.id, account.logged);
    return this.withLogin(account);
  }

  public update(id: number, patch: AccountPatch, expectedVersion?: number): Account {
    const state = this.state();
    const account = this.require(state, id, expectedVersion);
    const changes = record(patch);
    let fp = account.fp;
    if (Object.hasOwn(changes, 'fp')) {
      if (changes.fp === null) {
        // Native reset is not regeneration: retain the account's noise identity.
        fp = normalizeFingerprint({ seed: account.fp.seed }, id);
      } else {
        const partial = record(changes.fp);
        normalizeFingerprint(partial, id);
        if (Object.hasOwn(partial, 'seed') && partial.seed !== account.fp.seed) throw new AccountStoreError('Fingerprint seed is read-only');
        fp = normalizeFingerprint({ ...account.fp, ...partial }, id);
      }
    }
    const next = normalizeAccount({ ...account, ...changes, fp, id, version: account.version + 1 });
    state.accounts[state.accounts.indexOf(account)] = next;
    this.save(state);
    if (Object.hasOwn(changes, 'logged')) this.loginState.set(id, next.logged);
    return this.withLogin(next);
  }

  public generateFingerprint(id: number, mode: FingerprintPreset, expectedVersion?: number): Account {
    const state = this.state();
    const account = this.require(state, id, expectedVersion);
    const next = normalizeAccount({ ...account, fp: generateFingerprint(mode, account.fp), version: account.version + 1 });
    state.accounts[state.accounts.indexOf(account)] = next;
    this.save(state);
    return this.withLogin(next);
  }

  public remove(id: number, expectedVersion?: number): void {
    const state = this.state();
    this.require(state, id, expectedVersion);
    state.accounts = state.accounts.filter((account) => account.id !== id);
    if (state.currentId === id) state.currentId = state.accounts[0]?.id ?? null;
    this.save(state);
    this.loginState.delete(id);
  }

  public setCurrent(id: number): Account {
    const state = this.state();
    const account = this.require(state, id);
    const timestamp = this.now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new AccountStoreError('Invalid account timestamp');
    account.lastUsedAt = timestamp;
    account.version++;
    state.currentId = id;
    this.save(state);
    return this.withLogin(account);
  }

  public getCurrent(): Account | undefined {
    const state = this.state();
    const account = state.accounts.find((item) => item.id === state.currentId);
    return account ? this.withLogin(account) : undefined;
  }

  /** Validate a complete backup snapshot before making one atomic replacement. */
  public replaceAll(inputs: readonly (AccountInput & { id: number; version?: number })[]): void {
    if (!Array.isArray(inputs)) throw new AccountStoreError('Invalid accounts');
    const state = this.state();
    const seen = new Set<number>();
    const accounts = inputs.map((input) => {
      const account = normalizeAccount(record(input));
      if (seen.has(account.id)) throw new AccountStoreError('Duplicate account ID');
      seen.add(account.id);
      return account;
    });
    const nextId = accounts.reduce((next, account) => Math.max(next, account.id + 1), state.nextId);
    if (!Number.isSafeInteger(nextId)) throw new AccountStoreError('Account ID space exhausted', 409);
    this.save({ schema: 1, nextId, currentId: accounts.some((account) => account.id === state.currentId) ? state.currentId : accounts[0]?.id ?? null, accounts });
    this.loginState.clear();
  }

  private state(): AccountStoreState {
    return parseState(this.store.read());
  }

  private save(state: AccountStoreState): void {
    this.store.write({ ...state, accounts: state.accounts.map((account) => ({ ...account, logged: false })) });
  }

  private withLogin(account: Account): Account {
    return structuredClone({ ...account, logged: this.loginState.get(account.id) ?? false });
  }

  private require(state: AccountStoreState, id: number, version?: number): Account {
    validId(id);
    const account = state.accounts.find((item) => item.id === id);
    if (!account) throw new AccountStoreError('Account not found', 404);
    if (version !== undefined && (!Number.isSafeInteger(version) || version !== account.version)) {
      throw new AccountStoreError('Account version conflict', 409);
    }
    return account;
  }
}

function parseState(value: unknown): AccountStoreState {
  try {
    const raw = record(value);
    if (raw.schema !== 1 || !Array.isArray(raw.accounts)) throw new Error();
    const seen = new Set<number>();
    const accounts = raw.accounts.map((value: unknown) => {
      const stored = record(value);
      validId(stored.id);
      const account = normalizeAccount({ ...stored, fp: migrateLegacyFingerprint(stored.fp, stored.id) });
      if (seen.has(account.id)) throw new Error();
      seen.add(account.id);
      return account;
    });
    const storedNextId = raw.nextId;
    if (typeof storedNextId !== 'number' || !Number.isSafeInteger(storedNextId) || storedNextId < 1) throw new Error();
    const nextId = accounts.reduce((next, account) => Math.max(next, account.id + 1), storedNextId);
    if (!Number.isSafeInteger(nextId)) throw new Error();
    const currentId = raw.currentId;
    if (currentId !== null && (typeof currentId !== 'number' || !Number.isSafeInteger(currentId) || currentId < 1)) throw new Error();
    return { schema: 1, nextId, currentId: accounts.some((account) => account.id === currentId) ? currentId : accounts[0]?.id ?? null, accounts };
  } catch {
    throw new Error('Invalid persisted account state');
  }
}

function normalizeAccount(raw: Record<string, unknown>): Account {
  validId(raw.id);
  if (typeof raw.name !== 'string' || !raw.name.trim()) throw new AccountStoreError('Invalid account name');
  const version = raw.version ?? 1;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) throw new AccountStoreError('Invalid account version');
  const lastUsedAt = raw.lastUsedAt ?? 0;
  if (typeof lastUsedAt !== 'number' || !Number.isSafeInteger(lastUsedAt)) throw new AccountStoreError('Invalid lastUsedAt');
  return {
    id: raw.id, name: raw.name.trim(), avatar: text(raw.avatar, 'm'), proxy: text(raw.proxy),
    proxyPool: strings(raw.proxyPool), tags: strings(raw.tags), group: text(raw.group).trim().slice(0, 24),
    pinned: bool(raw.pinned), lastUsedAt: Math.max(0, lastUsedAt), logged: bool(raw.logged), version,
    fp: normalizeFingerprint(raw.fp, raw.id),
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AccountStoreError('Invalid account input');
  return value as Record<string, unknown>;
}

function validId(id: unknown): asserts id is number {
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new AccountStoreError('Invalid account ID');
}

function text(value: unknown, fallback = ''): string {
  if (value == null) return fallback;
  if (typeof value !== 'string') throw new AccountStoreError('Invalid account text field');
  return value;
}

function bool(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value !== 'boolean') throw new AccountStoreError('Invalid account boolean field');
  return value;
}

function strings(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new AccountStoreError('Invalid account list field');
  return [...new Set((value as string[]).map((entry) => entry.trim()).filter(Boolean))];
}
