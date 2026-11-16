import type { IncomingHttpHeaders } from 'node:http';
import { describe, expect, it } from 'vitest';
import { fingerprintHeaders, fingerprintUserAgent, generateFingerprint, normalizeFingerprint } from './profile.js';

describe('fingerprint profiles', () => {
  it('normalizes legacy profiles to disabled native defaults with stable account-specific seeds', () => {
    const fp = normalizeFingerprint({ uaMode: 'windows', tz: 'Asia/Shanghai', noise: true }, 42);
    expect(fp).toMatchObject({ enabled: false, uaMode: 'windows', timezone: 'Asia/Shanghai', noise: true, platform: '', screenWidth: 0, screenHeight: 0, pixelRatio: 0, hardwareConcurrency: 0, deviceMemory: 0, webglVendor: '', webglRenderer: '', audioNoise: false });
    expect(fp.seed).toBeGreaterThan(0);
    expect(fp.seed).toBeLessThanOrEqual(0xffff_ffff);
    expect(normalizeFingerprint({ tz: 'Asia/Shanghai' }, 42).seed).toBe(fp.seed);
    expect(normalizeFingerprint(undefined, 43).seed).not.toBe(fp.seed);
    expect(fingerprintUserAgent(fp)).toBeUndefined();
  });

  it('canonicalizes locale and preserves supplied complete profile fields and seed', () => {
    const fp = normalizeFingerprint({ enabled: true, seed: 123, uaMode: 'custom', uaCustom: 'Browser/1', locale: 'zh-cn', timezone: 'America/New_York', platform: 'Win32', screenWidth: 1920, screenHeight: 1080, pixelRatio: 1.25, hardwareConcurrency: 8, deviceMemory: 8, webglVendor: 'GPU vendor', webglRenderer: 'GPU renderer', audioNoise: true }, 1);
    expect(fp).toMatchObject({ enabled: true, seed: 123, locale: 'zh-CN', timezone: 'America/New_York', screenWidth: 1920, pixelRatio: 1.25, audioNoise: true });
    expect(normalizeFingerprint(fp, 2)).toEqual(fp);
    expect(fingerprintUserAgent(fp)).toBe('Browser/1');
  });

  it.each([
    [], 'bad', 3, { enabled: 'true' }, { seed: 0 }, { seed: -1 }, { seed: 0x1_0000_0000 }, { seed: 1.5 },
    { uaMode: 'unknown' }, { uaCustom: 'ok\r\nX-Injected: yes' }, { uaCustom: 'ok\0' }, { uaCustom: 'x'.repeat(2049) },
    { timezone: 'Mars/Olympus' }, { timezone: 5 }, { locale: 'en_US' }, { locale: 'en-US\r\nX: a' },
    { platform: '\nX: yes' }, { platform: 'Win32\n' }, { uaCustom: 'Browser/1\n' }, { webglVendor: 4 }, { webglRenderer: '\u007f' }, { audioNoise: null },
    { screenWidth: -1 }, { screenWidth: 12.5 }, { screenWidth: 20000 }, { screenHeight: '1080' },
    { pixelRatio: 0.1 }, { pixelRatio: 9 }, { hardwareConcurrency: 257 }, { hardwareConcurrency: 1.5 },
    { deviceMemory: 3 }, { deviceMemory: Infinity }, { noise: 'true' }, { script: 'alert(1)' },
  ])('rejects invalid runtime profile input with status400: %j', (input) => {
    expect(() => normalizeFingerprint(input, 1)).toThrowError(expect.objectContaining({ statusCode: 400 }));
  });

  it.each([
    ['windows', 'Win32', 1920, 1080, 1, 'Windows NT 10.0', 'Google Inc. (Intel)'],
    ['macos', 'MacIntel', 1440, 900, 2, 'Macintosh; Intel Mac OS X 10_15_7', 'Google Inc. (Apple)'],
    ['android', 'Linux armv8l', 412, 915, 2.625, 'Linux; Android 14; Pixel 8', 'ARM'],
  ] as const)('generates a coherent %s preset and a fresh seed without changing previous input', (mode, platform, width, height, ratio, uaFragment, vendor) => {
    const previous = normalizeFingerprint({ seed: 123, locale: 'zh-CN', timezone: 'Asia/Shanghai' }, 1);
    const before = structuredClone(previous);
    const fp = generateFingerprint(mode, previous);
    expect(fp).toMatchObject({ enabled: true, uaMode: mode, platform, screenWidth: width, screenHeight: height, pixelRatio: ratio, locale: 'zh-CN', timezone: 'Asia/Shanghai', webglVendor: vendor });
    expect(fp.webglRenderer).not.toBe('');
    expect(fp.seed).not.toBe(123);
    expect(fp.seed).toBeGreaterThan(0);
    expect(fp.seed).toBeLessThanOrEqual(0xffff_ffff);
    expect(fingerprintUserAgent(fp)).toContain(uaFragment);
    expect(fingerprintUserAgent(fp)).toContain('Chrome/131.0.0.0');
    expect(previous).toEqual(before);
    expect(normalizeFingerprint(fp, 1)).toEqual(fp);
  });

  it('rejects an unsupported generation mode', () => {
    expect(() => generateFingerprint('system' as never)).toThrowError(expect.objectContaining({ statusCode: 400 }));
  });

  it('returns a detached header clone while disabled, including array values', () => {
    const headers: IncomingHttpHeaders = { 'user-agent': 'native', 'accept-language': 'fr', 'sec-ch-ua': 'native', 'x-array': ['one'] };
    const result = fingerprintHeaders(headers, normalizeFingerprint({ uaMode: 'windows', locale: 'en-US' }, 1));
    expect(result).toEqual(headers);
    expect(result).not.toBe(headers);
    (result['x-array'] as string[]).push('two');
    expect(headers['x-array']).toEqual(['one']);
    expect(fingerprintHeaders(headers)).toEqual(headers);
  });

  it('synchronizes UA/language overrides, removes all UA hints case-insensitively and leaves caller input unchanged', () => {
    const headers: IncomingHttpHeaders = { 'User-Agent': 'native', 'Accept-Language': 'fr', 'Sec-CH-UA-Platform': 'native', 'sec-ch-ua-full-version-list': 'native', 'sec-ch-ua': 'native', accept: 'text/html' };
    const before = structuredClone(headers);
    const fp = normalizeFingerprint({ enabled: true, uaMode: 'custom', uaCustom: 'Browser/1', locale: 'zh-cn' }, 1);
    expect(fingerprintHeaders(headers, fp)).toEqual({ 'user-agent': 'Browser/1', 'accept-language': 'zh-CN,zh;q=0.9', accept: 'text/html' });
    expect(headers).toEqual(before);
  });

  it('preserves native UA hints for language-only changes and native language for UA-only changes', () => {
    const headers = { 'user-agent': 'native', 'sec-ch-ua': 'native hints', 'accept-language': 'fr' };
    expect(fingerprintHeaders(headers, normalizeFingerprint({ enabled: true, locale: 'en' }, 1))).toEqual({ ...headers, 'accept-language': 'en' });
    const result = fingerprintHeaders(headers, generateFingerprint('windows'));
    expect(result['accept-language']).toBe('fr');
    expect(result['sec-ch-ua']).toBeUndefined();
    expect(Object.keys(result)).not.toContain('authorization');
    expect(Object.keys(result)).not.toContain('cookie');
  });
});
