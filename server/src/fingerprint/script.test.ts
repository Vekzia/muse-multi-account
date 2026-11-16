import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { Fingerprint } from '../types.js';

const base = {
  enabled: true, seed: 12345, uaMode: 'system', uaCustom: '', timezone: '', locale: '',
  webdriver: false, noise: false, webrtc: false,
};
const fp = (overrides: Record<string, unknown> = {}) => ({ ...base, ...overrides }) as Fingerprint;
const api = () => import('./script.js');
function realm() {
  return vm.createContext({ navigator: { userAgent: 'native', userAgentData: { brands: ['native'] } }, screen: {}, devicePixelRatio: 1 });
}

describe('fingerprint page script', () => {
  it('leaves disabled and legacy profiles entirely native', async () => {
    const { fingerprintScript, injectFingerprint } = await api();
    for (const profile of [fp({ enabled: false }), fp({ enabled: undefined })]) {
      expect(fingerprintScript(profile)).toBeNull();
      expect(injectFingerprint('<head><script>native()</script></head>', profile)).toBe('<head><script>native()</script></head>');
    }
  });

  it('escapes every serialized string and executes literal values', async () => {
    const { fingerprintScript } = await api();
    const value = '</script><script>globalThis.attacked=true</script>\u2028\u2029';
    const script = fingerprintScript(fp({ uaMode: 'custom', uaCustom: '</script><script>globalThis.attacked=true</script>', platform: value }))!;
    expect(script).not.toContain('</script>');
    expect(script).not.toContain('\u2028');
    expect(script).not.toContain('\u2029');
    const context = realm();
    vm.runInContext(script, context);
    expect(vm.runInContext('navigator.platform', context)).toBe(value);
    expect(vm.runInContext('globalThis.attacked', context)).toBeUndefined();
  });

  it('installs once per realm and masks contradictory native client hints for overridden UA', async () => {
    const { fingerprintScript } = await api();
    const context = realm();
    vm.runInContext(fingerprintScript(fp({ uaMode: 'custom', uaCustom: 'Profile UA', locale: 'de-DE', timezone: 'Europe/Berlin' }))!, context);
    const first = vm.runInContext('Intl.DateTimeFormat', context);
    vm.runInContext(fingerprintScript(fp({ uaMode: 'custom', uaCustom: 'Other UA', timezone: 'Asia/Tokyo' }))!, context);
    expect(vm.runInContext('navigator.userAgent', context)).toBe('Profile UA');
    expect(vm.runInContext('navigator.userAgentData', context)).toBeUndefined();
    expect(vm.runInContext('Intl.DateTimeFormat', context)).toBe(first);
    expect(vm.runInContext('navigator.language', context)).toBe('de-DE');
    expect(Array.from(vm.runInContext('navigator.languages', context))).toEqual(['de-DE', 'de']);
  });

  it('preserves unconfigured native fields and isolates a failed feature', async () => {
    const { fingerprintScript } = await api();
    const context = realm();
    vm.runInContext("Object.defineProperty(navigator, 'platform', { value: 'locked', configurable: false })", context);
    vm.runInContext(fingerprintScript(fp({ platform: 'configured', hardwareConcurrency: 6, deviceMemory: 8, screenWidth: 1440, pixelRatio: 2 }))!, context);
    expect(vm.runInContext('navigator.platform', context)).toBe('locked');
    expect(vm.runInContext('navigator.hardwareConcurrency', context)).toBe(6);
    expect(vm.runInContext('navigator.deviceMemory', context)).toBe(8);
    expect(vm.runInContext('navigator.userAgentData.brands[0]', context)).toBe('native');
    expect(vm.runInContext('screen.width', context)).toBe(1440);
    expect(vm.runInContext('screen.height', context)).toBeUndefined();
    expect(vm.runInContext('devicePixelRatio', context)).toBe(2);
  });

  it('keeps Intl constructors, statics, prototypes, explicit arguments and Date formatting', async () => {
    const { fingerprintScript } = await api();
    const context = realm();
    const prototype = vm.runInContext('Intl.DateTimeFormat.prototype', context);
    const supported = vm.runInContext('Intl.DateTimeFormat.supportedLocalesOf', context);
    vm.runInContext(fingerprintScript(fp({ timezone: 'America/New_York', locale: 'de-DE' }))!, context);
    expect(vm.runInContext('Intl.DateTimeFormat.prototype', context)).toBe(prototype);
    expect(vm.runInContext('Intl.DateTimeFormat.supportedLocalesOf', context)).toBe(supported);
    expect(vm.runInContext('new Intl.DateTimeFormat() instanceof Intl.DateTimeFormat', context)).toBe(true);
    expect(vm.runInContext('Intl.DateTimeFormat().resolvedOptions().timeZone', context)).toBe('America/New_York');
    expect(vm.runInContext('new Intl.NumberFormat().resolvedOptions().locale', context)).toBe('de-DE');
    expect(vm.runInContext("new Intl.DateTimeFormat('ja-JP', {timeZone:'Asia/Tokyo'}).resolvedOptions().locale", context)).toBe('ja-JP');
    expect(vm.runInContext("new Date('2024-01-15T12:00:00Z').toLocaleTimeString('en-GB', { timeZone: 'UTC', hour12:false })", context)).toBe('12:00:00');
    expect(vm.runInContext("new Date('2024-01-15T12:00:00Z').toLocaleTimeString('en-GB', { hour12:false })", context)).toBe('07:00:00');
  });

  it('calculates offsets for each date, both sides of DST and fractional zones', async () => {
    const { fingerprintScript } = await api();
    for (const [zone, expected] of [['America/New_York', [300, 240, 300, 240]], ['Asia/Kathmandu', [-345, -345, -345, -345]]] as const) {
      const context = realm();
      vm.runInContext(fingerprintScript(fp({ timezone: zone }))!, context);
      const offsets = vm.runInContext("['2024-01-15T12:00:00Z','2024-07-15T12:00:00Z','2024-03-10T06:59:59Z','2024-03-10T07:00:00Z'].map(v=>new Date(v).getTimezoneOffset())", context);
      expect(Array.from(offsets)).toEqual(expected);
      expect(vm.runInContext('new Date(NaN).getTimezoneOffset()', context)).toBeNaN();
    }
  });
});
