import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const ACCOUNT_SESSION_COOKIE = 'muse_session';
export const DEFAULT_LAUNCH_TTL_MS = 60_000;
export const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;

export function requireBearerToken(expected: string, authorization?: string): boolean {
  if (!expected || !authorization) return false;
  const match = /^Bearer[ \t]+([^\s]+)$/i.exec(authorization);
  if (!match?.[1]) return false;
  return timingSafeEqual(createHash('sha256').update(expected).digest(), createHash('sha256').update(match[1]).digest());
}

export interface IssuedAccountToken { token: string; accountId: number; expiresAt: number }
export interface AccountSessionManagerOptions { now?: () => number }

type Entry = Omit<IssuedAccountToken, 'token'>;
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const validId = (id: number) => Number.isSafeInteger(id) && id > 0;

/** Launch secrets are one-use; account cookies never authorize the management API. */
export class AccountSessionManager {
  private readonly launches = new Map<string, Entry>();
  private readonly sessions = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(options: AccountSessionManagerOptions = {}) { this.now = options.now ?? Date.now; }

  private issue(entries: Map<string, Entry>, accountId: number, ttlMs: number): IssuedAccountToken {
    if (!validId(accountId)) throw new Error('Invalid account ID');
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('Invalid session lifetime');
    this.cleanup();
    if (entries.size >= 10_000) throw new Error('Session capacity reached');
    const token = randomBytes(32).toString('base64url');
    const entry = { accountId, expiresAt: this.now() + ttlMs };
    entries.set(digest(token), entry);
    return { token, ...entry };
  }

  issueLaunch(accountId: number, ttlMs = DEFAULT_LAUNCH_TTL_MS): IssuedAccountToken {
    return this.issue(this.launches, accountId, ttlMs);
  }

  consumeLaunch(token: string | undefined, accountId: number): boolean {
    if (!token || !validId(accountId)) return false;
    const key = digest(token);
    const entry = this.launches.get(key);
    if (!entry) return false;
    if (entry.expiresAt <= this.now()) { this.launches.delete(key); return false; }
    if (entry.accountId !== accountId) return false;
    this.launches.delete(key);
    return true;
  }

  issueSession(accountId: number, ttlMs = DEFAULT_SESSION_TTL_MS): IssuedAccountToken {
    return this.issue(this.sessions, accountId, ttlMs);
  }

  verifySession(token: string | undefined, accountId: number): boolean {
    if (!token || !validId(accountId)) return false;
    const key = digest(token);
    const entry = this.sessions.get(key);
    if (!entry) return false;
    if (entry.expiresAt <= this.now()) { this.sessions.delete(key); return false; }
    return entry.accountId === accountId;
  }

  accountFromSessionCookie(cookieHeader: string | undefined, accountId: number, cookieName = ACCOUNT_SESSION_COOKIE): boolean {
    if (!cookieHeader || !/^[a-zA-Z0-9_]+$/.test(cookieName)) return false;
    const values = cookieHeader.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${cookieName}=`));
    // Ambiguous duplicate cookies fail closed rather than selecting another account's token.
    if (values.length !== 1) return false;
    return this.verifySession(values[0]?.slice(cookieName.length + 1), accountId);
  }

  revokeAccount(accountId: number): void {
    for (const entries of [this.launches, this.sessions]) {
      for (const [key, entry] of entries) if (entry.accountId === accountId) entries.delete(key);
    }
  }

  cleanup(): void {
    for (const entries of [this.launches, this.sessions]) {
      for (const [key, entry] of entries) if (entry.expiresAt <= this.now()) entries.delete(key);
    }
  }
}

export function accountSessionCookieName(accountId: number): string {
  if (!validId(accountId)) throw new Error('Invalid account ID');
  return `muse_session_${accountId}`;
}

export function buildAccountSessionCookie(accountId: number, token: string, secure = false, maxAgeSeconds = DEFAULT_SESSION_TTL_MS / 1_000, options: { name?: string; path?: string } = {}): string {
  const name = options.name ?? ACCOUNT_SESSION_COOKIE;
  const path = options.path ?? `/muse/${accountId}`;
  if (!validId(accountId) || !/^[a-zA-Z0-9_-]+$/.test(token) || !/^[a-zA-Z0-9_]+$/.test(name) || !/^\/[a-zA-Z0-9/_-]*$/.test(path)) throw new Error('Invalid account session');
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) throw new Error('Invalid session lifetime');
  return `${name}=${token}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}
