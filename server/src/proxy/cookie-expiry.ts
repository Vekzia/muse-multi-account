import { Cookie } from 'tough-cookie';

/**
 * Freeze relative expiry once. A stored cookie's anchor is lastAccessed, then
 * creation: this freezes legacy snapshot semantics, not proof of its receipt.
 * No anchor means unknown expiry; callers must drop that relative cookie.
 */
export function normalizeCookieExpiry(cookie: Cookie, anchor?: Date): boolean {
  const maxAge = cookie.maxAge;
  if (maxAge == null) return true;
  if (maxAge === '-Infinity' || (typeof maxAge === 'number' && maxAge <= 0)) {
    cookie.expires = new Date(0);
  } else if (maxAge === 'Infinity') {
    cookie.expires = 'Infinity';
  } else {
    if (!Number.isFinite(maxAge) || !Number.isInteger(maxAge)) throw new Error('Invalid cookie expiry');
    if (!anchor || !Number.isFinite(anchor.getTime())) return false;
    const expires = new Date(anchor.getTime() + maxAge * 1000);
    if (!Number.isFinite(expires.getTime())) return false;
    cookie.expires = expires;
  }
  cookie.maxAge = null;
  return true;
}

/** Normalize a real response using its receipt time, never an old creation. */
export function normalizeSetCookieExpiry(cookieString: string, receivedAt = new Date()): string | undefined {
  const cookie = Cookie.parse(cookieString);
  if (!cookie || !normalizeCookieExpiry(cookie, receivedAt)) return undefined;
  // Keep the public jar adapter string-only; serialization preserves cookie
  // attributes and uses HTTP-date precision (whole seconds, rounded down).
  return cookie.toString();
}
