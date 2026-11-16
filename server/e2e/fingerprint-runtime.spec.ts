import { test, expect, type Page } from '@playwright/test';
import type { Fingerprint } from '../src/types.js';

const profile = (overrides: Record<string, unknown> = {}) => ({
  enabled: true, seed: 12345, uaMode: 'system', uaCustom: '', timezone: '', locale: '',
  webdriver: false, noise: false, webrtc: false, ...overrides,
}) as Fingerprint;
const api = () => import('../src/fingerprint/script.js');
async function install(page: Page, overrides: Record<string, unknown> = {}, body = '') {
  const { injectFingerprint } = await api();
  await page.setContent(injectFingerprint('<!doctype html><html><head></head><body>' + body + '</body></html>', profile(overrides)));
}

test('runs before the first page script, preserves document mode, and installs idempotently', async ({ page }) => {
  const { injectFingerprint } = await api();
  const html = '<!doctype html><!-- <head> decoy --><html><script>window.seen=navigator.userAgent</script><head></head></html>';
  const injected = injectFingerprint(html, profile({ uaMode: 'custom', uaCustom: 'Profile UA' }));
  await page.setContent(injectFingerprint(injected, profile({ uaMode: 'custom', uaCustom: 'Profile UA' })));
  expect(await page.evaluate(() => ({ seen: (window as any).seen, mode: document.compatMode, count: document.querySelectorAll('[data-muse-fingerprint]').length }))).toEqual({ seen: 'Profile UA', mode: 'CSS1Compat', count: 1 });
});

test('HTML comments and quoted tag delimiters never swallow the earliest injection', async ({ page }) => {
  const { injectFingerprint } = await api();
  const html = '<!doctype html><!-- <script data-muse-fingerprint>decoy</script> --><html data-value=">\"><!-- head --><head data-value=">\"><script>window.seen=navigator.userAgent</script></head></html>';
  await page.setContent(injectFingerprint(html, profile({ uaMode: 'custom', uaCustom: 'Profile UA' })));
  expect(await page.evaluate(() => ({ seen: (window as any).seen, mode: document.compatMode, count: document.querySelectorAll('[data-muse-fingerprint]').length }))).toEqual({ seen: 'Profile UA', mode: 'CSS1Compat', count: 1 });
});

test('overrides only configured navigator and screen metadata without resizing the viewport', async ({ page }) => {
  const before = await page.evaluate(() => ({ width: innerWidth, height: screen.height, driver: navigator.webdriver }));
  await install(page, { uaMode: 'custom', uaCustom: 'Profile UA', platform: 'Win32', locale: 'de-DE', hardwareConcurrency: 6, deviceMemory: 8, screenWidth: 1440, pixelRatio: 2 });
  expect(await page.evaluate(() => ({ ua: navigator.userAgent, uaData: (navigator as any).userAgentData, platform: navigator.platform, locale: navigator.language, langs: [...navigator.languages], cores: navigator.hardwareConcurrency, memory: (navigator as any).deviceMemory, width: screen.width, avail: screen.availWidth, ratio: devicePixelRatio, viewport: innerWidth, height: screen.height, driver: navigator.webdriver }))).toEqual({ ua: 'Profile UA', uaData: undefined, platform: 'Win32', locale: 'de-DE', langs: ['de-DE', 'de'], cores: 6, memory: 8, width: 1440, avail: 1440, ratio: 2, viewport: before.width, height: before.height, driver: before.driver });
});

test('Date seasonal offsets, explicit timezone, locale, subclass and prototype behave in Chromium', async ({ page }) => {
  await install(page, { timezone: 'America/New_York', locale: 'de-DE' });
  expect(await page.evaluate(() => {
    class CustomFormat extends Intl.DateTimeFormat {}
    return {
      winter: new Date('2024-01-15T12:00:00Z').getTimezoneOffset(), summer: new Date('2024-07-15T12:00:00Z').getTimezoneOffset(),
      before: new Date('2024-03-10T06:59:59Z').getTimezoneOffset(), after: new Date('2024-03-10T07:00:00Z').getTimezoneOffset(),
      explicit: new Date('2024-07-15T12:00:00Z').toLocaleString('en-GB', { timeZone: 'UTC', hour12: false }),
      defaultTime: new Date('2024-01-15T12:00:00Z').toLocaleTimeString('en-GB', { hour12: false }),
      locale: new Intl.DateTimeFormat().resolvedOptions().locale, zone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
      subclass: new CustomFormat() instanceof CustomFormat, staticLocale: Intl.DateTimeFormat.supportedLocalesOf(['en-US'])[0],
      prototype: Intl.DateTimeFormat.prototype.constructor === Intl.DateTimeFormat,
    };
  })).toEqual({ winter: 300, summer: 240, before: 300, after: 240, explicit: '15/07/2024, 12:00:00', defaultTime: '07:00:00', locale: 'de-DE', zone: 'America/New_York', subclass: true, staticLocale: 'en-US', prototype: true });
});

async function canvasSample(page: Page, seed: number, enabled = true) {
  const { injectFingerprint } = await api();
  await page.setContent(injectFingerprint('<!doctype html><html><head></head><body><canvas></canvas></body></html>', profile({ enabled, seed, noise: true })));
  return page.evaluate(async () => {
    const canvas = document.querySelector('canvas')!;
    canvas.width = 16; canvas.height = 16;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'rgb(80,120,160)'; ctx.fillRect(0, 0, 16, 16);
    const first = Array.from(ctx.getImageData(0, 0, 16, 16).data);
    const region = Array.from(ctx.getImageData(3, 4, 2, 2).data);
    const url1 = canvas.toDataURL(), url2 = canvas.toDataURL();
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve));
    const second = Array.from(ctx.getImageData(0, 0, 16, 16).data);
    const iframe = document.createElement('iframe'); document.body.appendChild(iframe);
    const nativeDocument = iframe.contentDocument!;
    async function decode(source: string | Blob) {
      const img = nativeDocument.createElement('img');
      const url = typeof source === 'string' ? source : URL.createObjectURL(source);
      img.src = url; await img.decode();
      const copy = nativeDocument.createElement('canvas'); copy.width = 16; copy.height = 16;
      const context = copy.getContext('2d')!; context.drawImage(img, 0, 0);
      const pixels = Array.from(context.getImageData(0, 0, 16, 16).data);
      if (typeof source !== 'string') URL.revokeObjectURL(url);
      return pixels;
    }
    const rawCopy = nativeDocument.createElement('canvas'); rawCopy.width = 16; rawCopy.height = 16;
    const rawContext = rawCopy.getContext('2d')!; rawContext.drawImage(canvas, 0, 0);
    const raw = Array.from(rawContext.getImageData(0, 0, 16, 16).data);
    const png = await decode(url1), blobPng = await decode(blob!);
    canvas.width = 0;
    const empty = canvas.toDataURL();
    const emptyBlob = await new Promise(resolve => canvas.toBlob(resolve));
    return { first, second, raw, region, png, blobPng, url1, url2, empty, emptyBlob };
  });
}

test('canvas readback and real PNG exports share stable seed noise without changing source pixels', async ({ browser }) => {
  const pages = await Promise.all([1, 2, 3, 4].map(() => browser.newPage()));
  try {
    const [a, same, different, native] = await Promise.all(pages.map((page, i) => canvasSample(page, i === 2 ? 54321 : 12345, i !== 3)));
    expect(a!.first).toEqual(a!.second); expect(a!.first).toEqual(a!.png); expect(a!.blobPng).toEqual(a!.png);
    expect(a!.url1).toBe(a!.url2); expect(a!.first).toEqual(same!.first); expect(a!.first).not.toEqual(different!.first);
    expect(a!.raw).toEqual(native!.first); expect(a!.first).not.toEqual(native!.first);
    expect(a!.empty).toBe('data:,'); expect(a!.emptyBlob).toBeNull();
    for (let i = 0; i < a!.first.length; i++) expect(Math.abs(a!.first[i]! - a!.raw[i]!)).toBeLessThanOrEqual(i % 4 === 3 ? 0 : 1);
    expect(a!.region).toEqual([4, 5].flatMap(y => [3, 4].flatMap(x => a!.first.slice((y * 16 + x) * 4, (y * 16 + x + 1) * 4))));
  } finally { await Promise.all(pages.map(page => page.close())); }
});

test('wide-gamut and float16 canvas reads and actual PNG exports preserve native colors', async ({ page }) => {
  await page.evaluate(() => {
    (window as any).nativeCanvas = {
      read: CanvasRenderingContext2D.prototype.getImageData,
      url: HTMLCanvasElement.prototype.toDataURL,
      blob: HTMLCanvasElement.prototype.toBlob,
    };
  });
  await install(page, { noise: true });
  const results = await page.evaluate(async () => {
    const native = (window as any).nativeCanvas;
    const iframe = document.createElement('iframe'); document.body.appendChild(iframe);
    const nativeDocument = iframe.contentDocument!;
    const results = [];
    for (const settings of [{ colorSpace: 'display-p3' }, { colorSpace: 'srgb', colorType: 'float16' }]) {
      const canvas = document.createElement('canvas'); canvas.width = 4; canvas.height = 4;
      const context = canvas.getContext('2d', settings as any)!;
      context.fillStyle = 'color(display-p3 1 0.5 0)'; context.fillRect(0, 0, 4, 4);
      const readSettings = { colorSpace: settings.colorSpace, pixelFormat: settings.colorType ? 'rgba-float16' : 'rgba-unorm8' };
      const original = Array.from(native.read.call(context, 0, 0, 1, 1, readSettings).data);
      const actual = Array.from(context.getImageData(0, 0, 1, 1, readSettings as any).data);
      const nativeSrgb = Array.from(native.read.call(context, 0, 0, 1, 1).data);
      const actualSrgb = Array.from(context.getImageData(0, 0, 1, 1).data);
      const nativeUrl = native.url.call(canvas), actualUrl = canvas.toDataURL();
      const nativeBlob = await new Promise<Blob>(resolve => native.blob.call(canvas, resolve));
      const actualBlob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!)));
      async function decode(blob: Blob) {
        const image = nativeDocument.createElement('img'); const url = URL.createObjectURL(blob);
        image.src = url; await image.decode();
        const decoded = nativeDocument.createElement('canvas'); decoded.width = 4; decoded.height = 4;
        const target = decoded.getContext('2d', { colorSpace: 'display-p3' })!; target.drawImage(image, 0, 0);
        URL.revokeObjectURL(url);
        return Array.from(target.getImageData(0, 0, 1, 1, { colorSpace: 'display-p3' }).data);
      }
      results.push({ settings: context.getContextAttributes(), original, actual, nativeSrgb, actualSrgb,
        sameUrl: actualUrl === nativeUrl,
        nativeBlob: Array.from(new Uint8Array(await nativeBlob.arrayBuffer())),
        actualBlob: Array.from(new Uint8Array(await actualBlob.arrayBuffer())),
        nativeDecoded: await decode(nativeBlob), actualDecoded: await decode(actualBlob) });
    }
    return results;
  });
  expect(results[0]!.settings.colorSpace).toBe('display-p3');
  expect((results[1]!.settings as any).colorType).toBe('float16');
  for (const result of results) {
    expect(result.actual, JSON.stringify(result.settings)).toEqual(result.original);
    expect(result.actualSrgb).toEqual(result.nativeSrgb);
    expect(result.sameUrl).toBe(true);
    expect(result.actualBlob).toEqual(result.nativeBlob);
    expect(result.actualDecoded).toEqual(result.nativeDecoded);
  }
});

test('canvas keeps taint errors and dimension errors native', async ({ page }) => {
  await page.route('http://fingerprint-image.invalid/pixel.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>' }));
  await install(page, { noise: true });
  expect(await page.evaluate(async () => {
    const image = new Image(); image.src = 'http://fingerprint-image.invalid/pixel.svg'; await image.decode();
    const canvas = document.createElement('canvas'); const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const errors: string[] = [];
    for (const operation of [() => context.getImageData(0, 0, 1, 1), () => canvas.toDataURL(), () => canvas.toBlob(() => {})]) {
      try { operation(); } catch (error) { errors.push((error as Error).name); }
    }
    const clean = document.createElement('canvas').getContext('2d')!;
    try { clean.getImageData(0, 0, 0, 1); } catch (error) { errors.push((error as Error).name); }
    return errors;
  })).toEqual(['SecurityError', 'SecurityError', 'SecurityError', 'IndexSizeError']);
});

test('WebGL1 and WebGL2 return configured GPU labels only', async ({ page }) => {
  await install(page, { webglVendor: 'Profile Vendor', webglRenderer: 'Profile Renderer' });
  const results = await page.evaluate(() => ['webgl', 'webgl2'].map(kind => {
    const gl = document.createElement('canvas').getContext(kind) as WebGLRenderingContext | WebGL2RenderingContext | null;
    if (!gl) return null;
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return debug && [gl.getParameter(debug.UNMASKED_VENDOR_WEBGL), gl.getParameter(debug.UNMASKED_RENDERER_WEBGL), typeof gl.getParameter(gl.MAX_TEXTURE_SIZE)];
  }));
  expect(results).toEqual([['Profile Vendor', 'Profile Renderer', 'number'], ['Profile Vendor', 'Profile Renderer', 'number']]);
});

test('audio reads are deterministic copies with bounded noise, native data stays editable', async ({ page }) => {
  await install(page, { audioNoise: true });
  const audio = await page.evaluate(() => {
    const buffer = new AudioBuffer({ length: 16, numberOfChannels: 1, sampleRate: 44100 });
    buffer.copyToChannel(new Float32Array(16).fill(0.25), 0);
    const first = buffer.getChannelData(0), original = Array.from(first); first[0] = 99;
    const second = Array.from(buffer.getChannelData(0));
    const copy = new Float32Array(6); buffer.copyFromChannel(copy, 0, 3);
    buffer.copyToChannel(new Float32Array([0.5]), 0);
    const afterWrite = buffer.getChannelData(0)[0]!;
    const context = new OfflineAudioContext(1, 32, 44100), analyser = context.createAnalyser();
    const one = new Uint8Array(analyser.frequencyBinCount), two = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(one); analyser.getByteFrequencyData(two);
    const floats = new Float32Array(analyser.frequencyBinCount); analyser.getFloatFrequencyData(floats);
    return { original, second, copy: [...copy], afterWrite, stableFrequency: one.every((v, i) => v === two[i]), maximumFrequencyNoise: Math.max(...one), floatFiniteOrSilence: floats.every(v => Number.isFinite(v) || v === -Infinity) };
  });
  expect(audio.stableFrequency).toBe(true);
  expect(audio.maximumFrequencyNoise).toBeLessThanOrEqual(1);
  expect(audio.floatFiniteOrSilence).toBe(true);
  expect(audio.original).toEqual(audio.second);
  expect(audio.copy).toEqual(audio.original.slice(3, 9));
  expect(Math.abs(audio.afterWrite - 0.5)).toBeLessThanOrEqual(0.0000011);
  expect(audio.original.some(v => v !== 0.25)).toBe(true);
  for (const value of audio.original) expect(Math.abs(value - 0.25)).toBeLessThanOrEqual(0.0000011);
});

test('WebRTC blocking throws clearly and optional webdriver masking leaves other APIs usable', async ({ page }) => {
  await install(page, { webrtc: true, webdriver: true });
  expect(await page.evaluate(() => {
    let error = '';
    try { new RTCPeerConnection(); } catch (value) { error = (value as Error).name; }
    let aliasError = '';
    try { new (window as any).webkitRTCPeerConnection(); } catch (value) { aliasError = (value as Error).name; }
    return { error, aliasError, webdriver: navigator.webdriver, canvas: !!document.createElement('canvas').getContext('2d') };
  })).toEqual({ error: 'NotSupportedError', aliasError: 'NotSupportedError', webdriver: false, canvas: true });
});

test('disabled profile preserves native runtime references and outputs', async ({ page }) => {
  await page.evaluate(() => { (window as any).original = [Intl.DateTimeFormat, Date.prototype.getTimezoneOffset, HTMLCanvasElement.prototype.toDataURL, AudioBuffer.prototype.getChannelData, RTCPeerConnection, navigator.userAgent, navigator.webdriver]; });
  await install(page, { enabled: false, noise: true, audioNoise: true, timezone: 'America/New_York', locale: 'de-DE', webrtc: true, webdriver: true, uaMode: 'custom', uaCustom: 'Override' });
  expect(await page.evaluate(() => [(Intl.DateTimeFormat), Date.prototype.getTimezoneOffset, HTMLCanvasElement.prototype.toDataURL, AudioBuffer.prototype.getChannelData, RTCPeerConnection, navigator.userAgent, navigator.webdriver].every((value, i) => value === (window as any).original[i]))).toBe(true);
});
