import { CookieJar } from 'tough-cookie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { persistSetCookies } from './upstream.js';

const origin = 'https://muse.example/private/page';
const receivedAt = new Date('2030-01-01T00:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(receivedAt);
});
afterEach(() => vi.useRealTimers());

async function receive(jar: CookieJar, ...cookies: string[]): Promise<void> {
  // Match the production string-only interface and exercise the real jar.
  await persistSetCookies({ headers: { 'set-cookie': cookies } }, origin, {
    getCookieString: (url) => jar.getCookieString(url),
    setCookie: (value, url) => {
      expect(typeof value).toBe('string');
      return jar.setCookie(value, url);
    },
  });
}

describe('Set-Cookie absolute expiry', () => {
  it('keeps the receipt deadline while real getCookieString reads update lastAccessed', async () => {
    const jar = new CookieJar();
    await receive(jar, 'auth=first; Max-Age=60; Path=/private; Secure; HttpOnly; SameSite=Lax; Priority=High');
    const cookie = (await jar.getCookies(origin))[0]!;
    expect(cookie.expiryTime()).toBe(Date.parse('2030-01-01T00:01:00Z'));
    expect(cookie).toMatchObject({ path: '/private', secure: true, httpOnly: true, sameSite: 'lax', extensions: ['Priority=High'] });
    expect(await jar.getCookieString('http://muse.example/private/page')).toBe('');
    expect(await jar.getCookieString('https://muse.example/public')).toBe('');

    vi.setSystemTime(new Date('2030-01-01T00:00:30Z'));
    expect(await jar.getCookieString(origin)).toBe('auth=first');
    expect(cookie.lastAccessed).toEqual(new Date('2030-01-01T00:00:30Z'));
    expect(cookie.expiryTime()).toBe(Date.parse('2030-01-01T00:01:00Z'));
    vi.setSystemTime(new Date('2030-01-01T00:01:00Z'));
    expect(await jar.getCookieString(origin)).toBe('');
  });

  it('renews a replacement from the new response time despite the retained old creation', async () => {
    const jar = new CookieJar();
    await receive(jar, 'auth=first; Max-Age=60; Path=/');
    vi.setSystemTime(new Date('2030-01-01T00:00:40Z'));
    await receive(jar, 'auth=rotated; Max-Age=60; Path=/');
    const rotated = (await jar.getCookies(origin))[0]!;
    expect(rotated.creation).toEqual(receivedAt);
    expect(rotated.expiryTime()).toBe(Date.parse('2030-01-01T00:01:40Z'));
    vi.setSystemTime(new Date('2030-01-01T00:01:10Z'));
    expect(await jar.getCookieString(origin)).toBe('auth=rotated');
    expect(rotated.expiryTime()).toBe(Date.parse('2030-01-01T00:01:40Z'));
    vi.setSystemTime(new Date('2030-01-01T00:01:40Z'));
    expect(await jar.getCookieString(origin)).toBe('');
  });

  it.each(['Tue, 01 Jan 2019 00:00:00 GMT', 'Thu, 01 Jan 2099 00:00:00 GMT'])
  ('gives Max-Age precedence over Expires=%s', async (expires) => {
    const jar = new CookieJar();
    await receive(jar, `auth=value; Max-Age=60; Expires=${expires}; Path=/`);
    vi.setSystemTime(new Date('2030-01-01T00:00:20Z'));
    const cookie = (await jar.getCookies(origin))[0]!;
    expect(cookie.value).toBe('value');
    expect(cookie.expiryTime()).toBe(Date.parse('2030-01-01T00:01:00Z'));
  });

  it.each([0, -1])('applies Max-Age=%s deletion even with future Expires', async (maxAge) => {
    const jar = new CookieJar();
    await receive(jar, 'auth=old; Path=/');
    await receive(jar, `auth=deleted; Max-Age=${maxAge}; Expires=Thu, 01 Jan 2099 00:00:00 GMT; Path=/`);
    expect(await jar.getCookieString(origin)).toBe('');
  });

  it('preserves explicit Expires and session Infinity without invented lifetime', async () => {
    const jar = new CookieJar();
    await receive(jar, 'session=value; Path=/', 'absolute=value; Expires=Tue, 01 Jan 2030 00:01:00 GMT; Path=/');
    vi.setSystemTime(new Date('2030-01-04T00:00:00Z'));
    expect(await jar.getCookieString(origin)).toBe('session=value');
    expect((await jar.getCookies(origin))[0]!.expiryTime()).toBe(Infinity);
  });

  it('retains the absolute deadline across a serialized jar round trip', async () => {
    const jar = new CookieJar();
    await receive(jar, 'auth=value; Max-Age=60; Path=/');
    vi.setSystemTime(new Date('2030-01-01T00:00:20Z'));
    await jar.getCookieString(origin);
    const restored = CookieJar.fromJSON(JSON.stringify(jar.toJSON()));
    vi.setSystemTime(new Date('2030-01-01T00:00:50Z'));
    expect(await restored.getCookieString(origin)).toBe('auth=value');
    expect((await restored.getCookies(origin))[0]!.expiryTime()).toBe(Date.parse('2030-01-01T00:01:00Z'));
    vi.setSystemTime(new Date('2030-01-01T00:01:00Z'));
    expect(await restored.getCookieString(origin)).toBe('');
  });

  it('continues ingesting valid cookies after a malformed header', async () => {
    const jar = new CookieJar();
    await receive(jar, '=; Max-Age=60', 'auth=value; Max-Age=60; Path=/');
    vi.setSystemTime(new Date('2030-01-01T00:00:30Z'));
    const cookie = (await jar.getCookies(origin)).find((item) => item.key === 'auth')!;
    expect(cookie.value).toBe('value');
    expect(cookie.expiryTime()).toBe(Date.parse('2030-01-01T00:01:00Z'));
  });
});
