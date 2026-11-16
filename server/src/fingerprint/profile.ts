import { createHash, randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { Fingerprint } from '../types.js';

export type FingerprintPreset = 'windows' | 'macos' | 'android';

/** Fixed Chrome 131 presets, matching the Android app (not the client's browser version). */
export const presetUA = {
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  macos: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
} as const;

type Field = { type: 'string' | 'number' | 'integer' | 'boolean'; default: string | number | boolean; maxLength?: number; pattern?: string; minimum?: number; maximum?: number; enum?: readonly (string | number)[]; nonzeroMinimum?: number };
const text = (maxLength: number): Field => ({ type: 'string', default: '', maxLength, pattern: '^[^\\u0000-\\u001f\\u007f]*$' });
// This table is the sole field/type/bounds definition for runtime and JSON Schema.
const fields = {
  uaMode: { type: 'string', default: 'system', enum: ['system', 'windows', 'macos', 'android', 'custom'] },
  uaCustom: { ...text(2048), pattern: '^[\\u0020-\\u007e\\u0080-\\u00ff]*$' },
  timezone: text(128), locale: text(128),
  webdriver: { type: 'boolean', default: false }, noise: { type: 'boolean', default: false }, webrtc: { type: 'boolean', default: false },
  enabled: { type: 'boolean', default: false },
  seed: { type: 'integer', default: 1, minimum: 1, maximum: 0xffff_ffff },
  platform: text(128),
  screenWidth: { type: 'integer', default: 0, minimum: 0, maximum: 16384 },
  screenHeight: { type: 'integer', default: 0, minimum: 0, maximum: 16384 },
  pixelRatio: { type: 'number', default: 0, minimum: 0, maximum: 8, nonzeroMinimum: 0.25 },
  hardwareConcurrency: { type: 'integer', default: 0, minimum: 0, maximum: 256 },
  deviceMemory: { type: 'number', default: 0, enum: [0, 0.25, 0.5, 1, 2, 4, 8] },
  webglVendor: text(256), webglRenderer: text(512), audioNoise: { type: 'boolean', default: false },
} satisfies Record<keyof Fingerprint, Field>;

/** Optional fields only: defaults must be applied after PATCH merges, never by AJV. */
export const fingerprintSchema = {
  type: 'object', additionalProperties: false,
  properties: Object.fromEntries(Object.entries(fields).map(([key, field]) => {
    const { default: _fallback, nonzeroMinimum, ...schema } = field as Field;
    return [key, { ...schema, ...(nonzeroMinimum === undefined ? {} : { anyOf: [{ const: 0 }, { minimum: nonzeroMinimum }] }) }];
  })),
};

function invalid(field = 'profile'): never {
  throw Object.assign(new Error(`Invalid fingerprint ${field}`), { statusCode: 400 });
}

/** No random state or storage side effects: old accounts get an account-ID-derived seed. */
export function normalizeFingerprint(input: unknown, accountId: number): Fingerprint {
  if (!Number.isSafeInteger(accountId) || accountId < 1) invalid('account ID');
  if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) invalid();
  const raw = { ...((input ?? {}) as Record<string, unknown>) };
  // Android's older timezone alias is accepted on migration/import, not in the API schema.
  if (Object.hasOwn(raw, 'tz')) {
    validateField(raw.tz, fields.timezone, 'tz');
    if (!Object.hasOwn(raw, 'timezone')) raw.timezone = raw.tz;
    delete raw.tz;
  }
  for (const key of Object.keys(raw)) if (!Object.hasOwn(fields, key)) invalid('field');
  const output: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(fields)) {
    const value = Object.hasOwn(raw, key) ? raw[key] : schema.default;
    validateField(value, schema, key);
    output[key] = value;
  }
  if (raw.seed === undefined) output.seed = createHash('sha256').update(`muse-fingerprint:${accountId}`).digest().readUInt32BE(0) || 1;
  if (output.timezone) {
    try { new Intl.DateTimeFormat('en', { timeZone: output.timezone as string }); } catch { invalid('timezone'); }
  }
  if (output.locale) {
    try { output.locale = Intl.getCanonicalLocales(output.locale as string)[0]; } catch { invalid('locale'); }
  }
  return output as unknown as Fingerprint;
}

/** Migration-only: v1.5 allowed arbitrary old text values. Never activate them. */
export function migrateLegacyFingerprint(input: unknown, accountId: number): Fingerprint {
  const legacyKeys = ['uaMode', 'uaCustom', 'timezone', 'tz', 'locale', 'webdriver', 'noise', 'webrtc'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !legacyKeys.includes(key))) {
    return normalizeFingerprint(input, accountId);
  }
  const migrated: Record<string, unknown> = { enabled: false };
  for (const [key, value] of Object.entries(input)) {
    const canonicalKey = key === 'tz' ? 'timezone' : key;
    const field = fields[canonicalKey as keyof typeof fields];
    // Type errors never represented a valid v1.5 backup. Only obsolete text
    // semantics are repaired; null had native defaults in old persisted data.
    if (value === null) continue;
    if (typeof value !== field.type) invalid(key);
    try {
      const normalized = normalizeFingerprint({ [canonicalKey]: value }, accountId);
      if (canonicalKey !== 'timezone' || key !== 'tz' || !Object.hasOwn(input, 'timezone')) {
        migrated[canonicalKey] = normalized[canonicalKey as keyof Fingerprint];
      }
    } catch {
      // Invalid old mode/locale/timezone/header strings become native defaults.
      // Unknown/new fields took the strict path above, so this cannot downgrade them.
    }
  }
  return normalizeFingerprint(migrated, accountId);
}

function validateField(value: unknown, field: Field, key: string): void {
  if (field.type === 'string') {
    if (typeof value !== 'string' || (field.maxLength !== undefined && value.length > field.maxLength) || (field.pattern && !new RegExp(field.pattern).test(value))) invalid(key);
  } else if (field.type === 'boolean') {
    if (typeof value !== 'boolean') invalid(key);
  } else {
    if (typeof value !== 'number' || !Number.isFinite(value) || (field.type === 'integer' && !Number.isSafeInteger(value)) || (field.minimum !== undefined && value < field.minimum) || (field.maximum !== undefined && value > field.maximum)) invalid(key);
    if (field.nonzeroMinimum !== undefined && value !== 0 && value < field.nonzeroMinimum) invalid(key);
  }
  if (field.enum && !field.enum.includes(value as never)) invalid(key);
}

/** Randomness is used only on account creation and explicit regeneration. */
export function createFingerprintSeed(previous?: number): number {
  let seed: number;
  do { seed = randomBytes(4).readUInt32BE(0); } while (seed === 0 || seed === previous);
  return seed;
}

const presets: Record<FingerprintPreset, Partial<Fingerprint>> = {
  windows: { platform: 'Win32', screenWidth: 1920, screenHeight: 1080, pixelRatio: 1, hardwareConcurrency: 8, deviceMemory: 8, webglVendor: 'Google Inc. (Intel)', webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E92) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  macos: { platform: 'MacIntel', screenWidth: 1440, screenHeight: 900, pixelRatio: 2, hardwareConcurrency: 8, deviceMemory: 8, webglVendor: 'Google Inc. (Apple)', webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)' },
  android: { platform: 'Linux armv8l', screenWidth: 412, screenHeight: 915, pixelRatio: 2.625, hardwareConcurrency: 8, deviceMemory: 8, webglVendor: 'ARM', webglRenderer: 'Mali-G715' },
};

export function generateFingerprint(mode: FingerprintPreset, previous?: Partial<Fingerprint>): Fingerprint {
  if (!Object.hasOwn(presets, mode)) invalid('mode');
  const prior = normalizeFingerprint(previous, 1);
  return normalizeFingerprint({ ...prior, ...presets[mode], enabled: true, uaMode: mode, uaCustom: '', seed: createFingerprintSeed(prior.seed) }, 1);
}

export function fingerprintUserAgent(fp: Fingerprint): string | undefined {
  const profile = normalizeFingerprint(fp, 1);
  if (!profile.enabled) return undefined;
  if (profile.uaMode === 'custom') return profile.uaCustom || undefined;
  return Object.hasOwn(presetUA, profile.uaMode) ? presetUA[profile.uaMode as FingerprintPreset] : undefined;
}

/** Clone input, override configured UA/language only, never add credentials or forged UA hints. */
export function fingerprintHeaders(headers: IncomingHttpHeaders, fp?: Fingerprint): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]));
  if (!fp?.enabled) return result;
  const profile = normalizeFingerprint(fp, 1);
  const ua = fingerprintUserAgent(profile);
  for (const key of Object.keys(result)) {
    const name = key.toLowerCase();
    if ((ua && (name === 'user-agent' || name.startsWith('sec-ch-ua'))) || (profile.locale && name === 'accept-language')) delete result[key];
  }
  if (ua) result['user-agent'] = ua;
  if (profile.locale) {
    const language = profile.locale.split('-')[0]!;
    result['accept-language'] = language === profile.locale ? language : `${profile.locale},${language};q=0.9`;
  }
  return result;
}
