import { describe, expect, it } from 'vitest';
import {
  AccountSessionManager,
  buildAccountSessionCookie,
  accountSessionCookieName,
  requireBearerToken,
} from './token-auth.js';

describe('requireBearerToken', () => {
  it('accepts only an exact bearer token', () => {
    expect(requireBearerToken('secret-token', 'Bearer secret-token')).toBe(true);
    expect(requireBearerToken('secret-token', 'bearer secret-token')).toBe(true);
    expect(requireBearerToken('secret-token', 'Bearer wrong-token')).toBe(false);
    expect(requireBearerToken('secret-token', undefined)).toBe(false);
    expect(requireBearerToken('secret-token', 'Basic secret-token')).toBe(false);
    expect(requireBearerToken('secret-token', 'Bearer secret-token trailing')).toBe(false);
  });

  it('fails closed for empty expected or supplied values', () => {
    expect(requireBearerToken('', 'Bearer ')).toBe(false);
    expect(requireBearerToken('secret-token', '')).toBe(false);
    expect(requireBearerToken('secret-token', 'Bearer secret-token\nforged')).toBe(false);
    expect(requireBearerToken('secret-token', 'Bearer secret-token\n')).toBe(false);
  });
});

describe('AccountSessionManager', () => {
  it('issues a launch token that is single-use and bound to its account', () => {
    const sessions = new AccountSessionManager({ now: () => 1_000 });
    const launch = sessions.issueLaunch(42, 60_000);

    expect(sessions.consumeLaunch(launch.token, 7)).toBe(false);
    expect(sessions.consumeLaunch(launch.token, 42)).toBe(true);
    expect(sessions.consumeLaunch(launch.token, 42)).toBe(false);
  });

  it('rejects expired launch tokens without revealing token material', () => {
    let now = 1_000;
    const sessions = new AccountSessionManager({ now: () => now });
    const launch = sessions.issueLaunch(42, 60_000);

    now = 61_001;
    expect(sessions.consumeLaunch(launch.token, 42)).toBe(false);
    expect(sessions.consumeLaunch('missing-token', 42)).toBe(false);
  });

  it('creates and verifies an account session cookie scoped to the account path', () => {
    const sessions = new AccountSessionManager({ now: () => 1_000 });
    const session = sessions.issueSession(42, 3_600_000);
    const cookie = buildAccountSessionCookie(42, session.token, false);

    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/muse/42');
    expect(cookie).toContain(session.token);
    expect(sessions.verifySession(session.token, 42)).toBe(true);
    expect(sessions.verifySession(session.token, 7)).toBe(false);
    expect(sessions.verifySession('other', 42)).toBe(false);
  });

  it('supports unique root-path cookies for isolated account gateway ports', () => {
    const sessions = new AccountSessionManager();
    const session = sessions.issueSession(42);
    const name = accountSessionCookieName(42);
    const cookie = buildAccountSessionCookie(42, session.token, true, 3_600, { path: '/', name });
    expect(name).toBe('muse_session_42');
    expect(cookie).toContain(`muse_session_42=${session.token}; Path=/;`);
    expect(cookie).toContain('; Secure');
    expect(sessions.accountFromSessionCookie(`other=x; ${name}=${session.token}`, 42, name)).toBe(true);
    expect(sessions.accountFromSessionCookie(`${name}=${session.token}; ${name}=other`, 42, name)).toBe(false);
    sessions.revokeAccount(42);
    expect(sessions.verifySession(session.token, 42)).toBe(false);
  });

  it('expires sessions on the boundary and rejects malformed cookie values', () => {
    let now = 0;
    const sessions = new AccountSessionManager({ now: () => now });
    const session = sessions.issueSession(2, 100);
    now = 100;
    expect(sessions.verifySession(session.token, 2)).toBe(false);
    expect(sessions.accountFromSessionCookie(undefined, 2)).toBe(false);
    expect(() => buildAccountSessionCookie(2, 'x; HttpOnly')).toThrow();
  });
});
