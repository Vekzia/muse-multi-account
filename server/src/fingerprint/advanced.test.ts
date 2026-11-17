import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { Fingerprint } from '../types.js';

const fp = (overrides: Record<string, unknown> = {}) => ({ enabled: true, seed: 42, uaMode: 'system', uaCustom: '', timezone: '', locale: '', webdriver: false, noise: false, webrtc: false, ...overrides }) as Fingerprint;
const options = { primaryOrigin: 'https://muse.ai', localOrigin: 'http://localhost:4100', additionalOrigins: { api: 'https://api.muse.ai' } };
const api = () => import('./advanced.js');

describe('advanced fingerprint policies', () => {
  it('leaves disabled and native profiles untouched', async () => {
    const { advancedFingerprintScript, workerBootstrapResponse } = await api();
    for (const profile of [fp(), fp({ enabled: false, workerMode: 'profile', fontMode: 'standard', webgpuMode: 'disabled' })]) {
      expect(advancedFingerprintScript(profile, options)).toBeNull();
      expect(workerBootstrapResponse(profile, '/__muse/worker?src=http%3A%2F%2Flocalhost%3A4100%2Fa.js&type=classic', options)?.status).toBe(404);
    }
  });

  it('disables GPU on the navigator and its prototype, but leaves native mode untouched', async () => {
    const { advancedFingerprintScript } = await api();
    const context = createContext({ URL, location: new URL(options.localOrigin), navigator: Object.create({ gpu: { requestAdapter() {} } }) });
    runInContext(advancedFingerprintScript(fp({ webgpuMode: 'disabled' }), options)!, context);
    expect(runInContext('navigator.gpu', context)).toBeUndefined();
    expect(runInContext('Object.getPrototypeOf(navigator).gpu', context)).toBeUndefined();
    expect(runInContext("'gpu' in navigator", context)).toBe(false);
  });

  it('validates wrapper sources without ever granting access to remote, file or reserved resources', async () => {
    const { workerBootstrapResponse } = await api();
    const profile = fp({ workerMode: 'profile' });
    for (const src of ['https://other.invalid/a.js', 'file:///tmp/worker.js', 'blob:http://localhost:4100/uuid', 'http://localhost:4100/__muse/worker', 'http://localhost:4100/__muse/launch', 'http://user:pass@localhost:4100/a.js']) {
      expect(workerBootstrapResponse(profile, '/__muse/worker?' + new URLSearchParams({ src, type: 'classic' }), options)?.status).toBe(400);
    }
    expect(workerBootstrapResponse(profile, '/unrelated', options)).toBeNull();
  });

  it('creates usable deterministic bootstrap URLs without optional origin mappings and rejects stale profile versions', async () => {
    const { advancedFingerprintScript, workerBootstrapResponse } = await api();
    let target = '';
    class WorkerBoundary { constructor(url: string) { target = url; } }
    const profile = fp({ workerMode: 'profile' });
    const context = createContext({ URL, URLSearchParams, location: new URL('http://localhost:4100/jobs/page.html'), Worker: WorkerBoundary });
    runInContext(advancedFingerprintScript(profile)!, context);
    runInContext("new Worker('./main.js')", context);
    expect(new URL(target).pathname).toBe('/__muse/worker');
    expect(new URL(target).searchParams.get('src')).toBe('http://localhost:4100/jobs/main.js');
    expect(workerBootstrapResponse(profile, target, options)?.status).toBe(200);
    expect(workerBootstrapResponse(fp({ workerMode: 'profile', seed: 99 }), target, options)?.status).toBe(409);
  });

  it('escapes hostile profile text while executing it as literal worker metadata', async () => {
    const { advancedFingerprintScript, workerBootstrapResponse } = await api();
    const platform = '</script><script>globalThis.attacked=true</script>\u2028\u2029';
    const profile = fp({ workerMode: 'profile', platform });
    const page = advancedFingerprintScript(profile, options)!;
    expect(page).not.toContain('</script>');
    const response = workerBootstrapResponse(profile, '/__muse/worker?' + new URLSearchParams({ src: 'http://localhost:4100/a.js', type: 'classic' }), options)!;
    const context = createContext({ URL, navigator: {}, location: new URL(options.localOrigin), importScripts() {} });
    runInContext(response.body, context);
    expect(runInContext('navigator.platform', context)).toBe(platform);
    expect(runInContext('globalThis.attacked', context)).toBeUndefined();
  });

  it('keeps off-policy font APIs and ServiceWorker registration native', async () => {
    const { advancedFingerprintScript } = await api();
    const context = createContext({ URL, location: new URL(options.localOrigin), navigator: { serviceWorker: { register: () => 'native registration' } }, queryLocalFonts: () => ['native font'] });
    runInContext(advancedFingerprintScript(fp({ webgpuMode: 'disabled' }), options)!, context);
    expect(runInContext('queryLocalFonts()[0]', context)).toBe('native font');
    expect(runInContext('navigator.serviceWorker.register()', context)).toBe('native registration');
  });

  it('permits configured same-origin alias worker paths and rejects unconfigured aliases', async () => {
    const { workerBootstrapResponse } = await api();
    for (const [src, status] of [['http://localhost:4100/__muse/origin/api/worker.js', 200], ['http://localhost:4100/__muse/origin/other/worker.js', 400]] as const) {
      expect(workerBootstrapResponse(fp({ workerMode: 'profile' }), '/__muse/worker?' + new URLSearchParams({ src, type: 'classic' }), options)?.status).toBe(status);
    }
  });

  it('installs profile before classic source and maps relative fetch/imports without window APIs', async () => {
    const { workerBootstrapResponse } = await api();
    const calls: unknown[] = [];
    const source = 'http://localhost:4100/jobs/main.js?revision=1';
    const response = workerBootstrapResponse(fp({ workerMode: 'profile', uaMode: 'custom', uaCustom: 'Worker profile', locale: 'de-DE', timezone: 'Europe/Berlin', platform: 'Win32', hardwareConcurrency: 6 }), '/__muse/worker?' + new URLSearchParams({ src: source, type: 'classic' }), options)!;
    expect(response.status).toBe(200);
    const context = createContext({ URL, Request, Headers, Response, DOMException, navigator: { userAgent: 'native' }, location: new URL('http://localhost:4100/__muse/worker'), importScripts: (...urls: string[]) => { calls.push({ urls, ua: runInContext('navigator.userAgent', context) }); }, fetch: async (url: unknown, init: unknown) => { calls.push({ url, init }); return new Response('ok'); } });
    runInContext(response.body, context);
    expect(calls[0]).toEqual({ urls: [source], ua: 'Worker profile' });
    await runInContext("fetch('./data.json')", context);
    runInContext("importScripts('./dep.js')", context);
    await runInContext("fetch('https://api.muse.ai/v1/ping')", context);
    expect(calls[1]).toMatchObject({ url: 'http://localhost:4100/jobs/data.json', init: { credentials: 'same-origin', mode: 'same-origin' } });
    expect(calls[2]).toEqual({ urls: ['http://localhost:4100/jobs/dep.js'], ua: 'Worker profile' });
    expect(calls[3]).toMatchObject({ url: 'http://localhost:4100/__muse/origin/api/v1/ping' });
    await runInContext("fetch(new Request('./data.json'))", context);
    expect(calls[4]).toMatchObject({ url: 'http://localhost:4100/jobs/data.json', init: { credentials: 'same-origin', mode: 'same-origin' } });
    expect(runInContext('[navigator.language,navigator.platform,navigator.hardwareConcurrency,new Intl.DateTimeFormat().resolvedOptions().timeZone]', context)).toEqual(['de-DE', 'Win32', 6, 'Europe/Berlin']);
  });
});
