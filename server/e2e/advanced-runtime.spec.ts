import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import type { Fingerprint } from '../src/types.js';
import { fingerprintScript } from '../src/fingerprint/script.js';
import { advancedFingerprintScript, workerBootstrapResponse } from '../src/fingerprint/advanced.js';
import { injectAccountFingerprint } from '../src/fingerprint/document.js';

const fp = (overrides: Record<string, unknown> = {}) => ({ enabled: true, seed: 42, uaMode: 'custom', uaCustom: 'Account Worker A', timezone: 'Europe/Berlin', locale: 'de-DE', platform: 'Win32', hardwareConcurrency: 6, screenWidth: 1920, webdriver: false, noise: false, webrtc: false, workerMode: 'profile', fontMode: 'native', webgpuMode: 'disabled', ...overrides }) as Fingerprint;
const snapshot = `({ua:navigator.userAgent,lang:navigator.language,langs:[...navigator.languages],platform:navigator.platform,cores:navigator.hardwareConcurrency,zone:new Intl.DateTimeFormat().resolvedOptions().timeZone,offset:new Date('2024-01-15T12:00:00Z').getTimezoneOffset(),gpu:typeof navigator.gpu})`;
const servers: Server[] = [];
test.afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });

async function fixture(page: Page, profile = fp(), csp = '') {
  const requests: string[] = [];
  let origin = '';
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, origin); requests.push(url.pathname + url.search);
    const options = { primaryOrigin: 'https://muse.ai', localOrigin: origin, additionalOrigins: { api: 'https://api.muse.ai' } };
    const wrapper = workerBootstrapResponse(profile, req.url!, options);
    if (wrapper) { res.writeHead(wrapper.status, wrapper.headers); res.end(wrapper.body); return; }
    if (url.pathname === '/__muse/fonts/DejaVuSans.ttf') {
      res.setHeader('content-type', 'font/ttf'); res.end(await readFile(new URL('../public/fonts/DejaVuSans.ttf', import.meta.url))); return;
    }
    if (url.pathname === '/jobs/data.json') { res.setHeader('content-type', 'application/json'); res.end('{"relative":"correct"}'); return; }
    if (url.pathname === '/__muse/origin/api/ping') { res.end('account-api'); return; }
    if (url.pathname === '/jobs/location.js') { res.setHeader('content-type', 'text/javascript'); res.end(`const bases=[self.location.href,self.location];Promise.all(bases.map(base=>fetch(new URL('./data.json',base)).then(response=>response.status))).then(statuses=>postMessage({statuses,entry:new URL(self.location).pathname,other:new URL('./data.json','https://external.invalid/path/source.js').href}));`); return; }
    if (url.pathname === '/jobs/shared-identity.js') { res.setHeader('content-type', 'text/javascript'); res.end('let count=0;onconnect=e=>{const port=e.ports[0];port.postMessage(++count)};'); return; }
    if (url.pathname === '/jobs/dep.js') { res.setHeader('content-type', 'text/javascript'); res.end('globalThis.dep="imported";'); return; }
    if (url.pathname === '/jobs/dep.mjs') { res.setHeader('content-type', 'text/javascript'); res.end('export const dep="imported";'); return; }
    if (url.pathname === '/jobs/font.js') { res.setHeader('content-type', 'text/javascript'); res.end(`const context=new OffscreenCanvas(1,1).getContext('2d');context.font='20px serif';const a=context.measureText('Hello WWW iii 123').width;context.font='20px monospace';postMessage({a,b:context.measureText('Hello WWW iii 123').width,font:context.font,faces:[...fonts].map(face=>({family:face.family,status:face.status}))});`); return; }
    if (url.pathname === '/jobs/child.js') { res.setHeader('content-type', 'text/javascript'); res.end(`postMessage(${snapshot})`); return; }
    if (url.pathname === '/jobs/nested.js') { res.setHeader('content-type', 'text/javascript'); res.end('const child=new Worker("./child.js");child.onmessage=e=>{postMessage(e.data);child.terminate()};'); return; }
    if (url.pathname === '/jobs/fail.js') { res.setHeader('content-type', 'text/javascript'); res.end('throw new Error("source boom")'); return; }
    if (url.pathname === '/jobs/worker.js') {
      res.setHeader('content-type', 'text/javascript');
      const module = url.searchParams.has('module'), shared = url.searchParams.has('shared');
      const load = module ? 'import {dep} from "./dep.mjs";' : 'importScripts("./dep.js");';
      const send = `async function send(port,message){port.postMessage({top,dep,message,data:await(await fetch('./data.json')).json(),request:await(await fetch(new Request('./data.json'))).json(),api:await(await fetch('https://api.muse.ai/ping')).text()})}`;
      res.end(`${load} const top=${snapshot};${send}${shared ? 'onconnect=e=>{const p=e.ports[0];p.onmessage=e=>send(p,e.data);p.start()}' : 'onmessage=e=>send(self,e.data)'}`); return;
    }
    if (url.pathname === '/jobs/page.html' || url.pathname === '/') {
      res.setHeader('content-type', 'text/html'); if (csp) res.setHeader('content-security-policy', csp);
      res.end('<!doctype html><html><head><script>' + (fingerprintScript(profile) ?? '') + (advancedFingerprintScript(profile, options) ?? '') + '</script></head><body><div id="sample" style="font:20px monospace">Hello WWW iii 123</div></body></html>'); return;
    }
    res.writeHead(404); res.end('missing');
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  await page.goto(origin + '/jobs/page.html');
  return { origin, requests };
}

async function runWorker(page: Page, path: string, module = false, shared = false) {
  return page.evaluate(({ path, module, shared }) => new Promise<any>((resolve, reject) => {
    const worker = shared ? new SharedWorker(path, { type: module ? 'module' : 'classic', name: 'advanced-test' }) : new Worker(path, { type: module ? 'module' : 'classic' });
    const port = worker instanceof SharedWorker ? worker.port : worker;
    const timer = setTimeout(() => reject(new Error('worker response timed out')), 7000);
    worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message || 'worker failed')); };
    port.onmessage = event => { clearTimeout(timer); resolve(event.data); if (worker instanceof SharedWorker) worker.port.close(); else worker.terminate(); };
    if (port instanceof MessagePort) port.start();
    port.postMessage('immediate message');
  }), { path, module, shared });
}

for (const module of [false, true]) for (const shared of [false, true]) {
  test(`${shared ? 'SharedWorker' : 'Dedicated Worker'} ${module ? 'module' : 'classic'} installs before source, preserves early messages and relative imports/fetch`, async ({ page }) => {
    await fixture(page);
    const result = await runWorker(page, '/jobs/worker.js?' + new URLSearchParams({ ...(module ? { module: '1' } : {}), ...(shared ? { shared: '1' } : {}) }), module, shared);
    expect(result.top).toEqual({ ua: 'Account Worker A', lang: 'de-DE', langs: ['de-DE', 'de'], platform: 'Win32', cores: 6, zone: 'Europe/Berlin', offset: -60, gpu: 'undefined' });
    expect(result).toMatchObject({ dep: 'imported', message: 'immediate message', data: { relative: 'correct' }, request: { relative: 'correct' }, api: 'account-api' });
  });
}

test('explicit worker location URL bases resolve relative resources identically to native mode', async ({ browser }) => {
  const pages = await Promise.all([0, 1].map(() => browser.newPage()));
  try {
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i]!;
      await fixture(page, fp(i === 1 ? { workerMode: 'native', webgpuMode: 'native' } : {}));
      for (const module of [false, true]) expect(await runWorker(page, '/jobs/location.js', module)).toEqual({ statuses: [200, 200], entry: '/jobs/location.js', other: 'https://external.invalid/path/data.json' });
    }
  } finally { await Promise.all(pages.map(page => page.close())); }
});

test('leading fake fingerprint markers never swallow advanced document installation', async ({ page }) => {
  await fixture(page);
  const html = '<!doctype html><!-- <script data-muse-fingerprint>fake()</script> --><html><head><script>window.seenAdvanced=typeof navigator.gpu</script></head></html>';
  const injected = injectAccountFingerprint(html, fp());
  await page.goto('about:blank');
  await page.setContent(injected);
  expect(await page.evaluate(() => ({ seen: (window as any).seenAdvanced, count: document.querySelectorAll('script[data-muse-advanced]').length, mode: document.compatMode }))).toEqual({ seen: 'undefined', count: 1, mode: 'CSS1Compat' });
});

test('nested workers receive the same profile and resolve against the original source', async ({ page }) => {
  await fixture(page);
  expect(await runWorker(page, '/jobs/nested.js')).toMatchObject({ ua: 'Account Worker A', lang: 'de-DE', cores: 6 });
});

for (const module of [false, true]) test(`blob ${module ? 'module' : 'classic'} workers retain origin, relative fetch and early delivery`, async ({ page }) => {
  await fixture(page);
  const path = await page.evaluate(({ snapshot, module }) => URL.createObjectURL(new Blob([`${module ? '' : 'importScripts("./dep.js");'} const top=${snapshot};onmessage=async e=>postMessage({top,data:await(await fetch('./data.json')).json(),message:e.data});`], { type: 'text/javascript' })), { snapshot, module });
  try { expect(await runWorker(page, path, module)).toMatchObject({ top: { ua: 'Account Worker A', gpu: 'undefined' }, data: { relative: 'correct' }, message: 'immediate message' }); }
  finally { await page.evaluate(path => URL.revokeObjectURL(path), path); }
});

for (const type of ['classic', 'module'] as const) for (const shared of [false, true]) test(`blob ${shared ? 'shared' : 'dedicated'} ${type} accepts immediate caller URL revocation`, async ({ page }) => {
  await fixture(page);
  const result = await page.evaluate(({ type, snapshot, shared }) => new Promise((resolve, reject) => {
    const body = shared ? `onconnect=e=>e.ports[0].postMessage(${snapshot})` : `postMessage(${snapshot})`;
    const url = URL.createObjectURL(new Blob([body], { type: 'text/javascript' }));
    const worker = shared ? new SharedWorker(url, { type }) : new Worker(url, { type }); URL.revokeObjectURL(url);
    const timer = setTimeout(() => reject(new Error('blob timed out')), 7000);
    const port = worker instanceof SharedWorker ? worker.port : worker;
    port.onmessage = event => { clearTimeout(timer); if (worker instanceof SharedWorker) worker.port.close(); else worker.terminate(); resolve(event.data); };
    worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
    if (port instanceof MessagePort) port.start();
  }), { type, snapshot, shared });
  expect(result).toMatchObject({ ua: 'Account Worker A' });
});

test('SharedWorker deterministic wrapper URLs preserve named instance reuse', async ({ page }) => {
  const { requests } = await fixture(page);
  const counts = await page.evaluate(async () => {
    const first = new SharedWorker('/jobs/shared-identity.js', 'same-name');
    const a = await new Promise<number>(resolve => { first.port.onmessage = e => resolve(e.data); first.port.start(); });
    const second = new SharedWorker('/jobs/shared-identity.js', 'same-name');
    const b = await new Promise<number>(resolve => { second.port.onmessage = e => resolve(e.data); second.port.start(); });
    first.port.close(); second.port.close(); return [a, b];
  });
  expect(counts).toEqual([1, 2]);
  expect(new Set(requests.filter(path => path.startsWith('/__muse/worker'))).size).toBe(1);
});

test('profiles are stable within an account and independent across account configuration', async ({ browser }) => {
  const pages = await Promise.all([0, 1, 2].map(() => browser.newPage()));
  try {
    const values = [];
    for (let i = 0; i < pages.length; i++) {
      await fixture(pages[i]!, fp(i === 2 ? { seed: 99, uaCustom: 'Account Worker B', hardwareConcurrency: 12, timezone: 'Asia/Tokyo' } : {}));
      values.push(await runWorker(pages[i]!, '/jobs/child.js'));
    }
    expect(values[0]).toEqual(values[1]); expect(values[2]).toMatchObject({ ua: 'Account Worker B', cores: 12, zone: 'Asia/Tokyo', offset: -540 });
  } finally { await Promise.all(pages.map(page => page.close())); }
});

test('disabled and all-native modes preserve Worker and GPU behavior', async ({ browser }) => {
  const pages = await Promise.all([0, 1, 2].map(() => browser.newPage()));
  try {
    const results = [], pageGpu = [], pageFonts = [];
    for (let i = 0; i < pages.length; i++) {
      const profile = fp(i === 0 ? { enabled: false } : i === 1 ? { workerMode: 'native', webgpuMode: 'native' } : { workerMode: 'native', webgpuMode: 'disabled' });
      const { requests } = await fixture(pages[i]!, profile);
      results.push(await runWorker(pages[i]!, '/jobs/child.js'));
      pageGpu.push(await pages[i]!.evaluate(() => typeof (navigator as any).gpu));
      pageFonts.push(await pages[i]!.evaluate(() => getComputedStyle(document.querySelector('#sample')!).fontFamily));
      expect(requests.some(path => path.startsWith('/__muse/worker'))).toBe(i === 2);
    }
    expect(results[1]).toEqual(results[0]); expect(results[2]).toEqual({ ...results[0], gpu: 'undefined' });
    expect(pageGpu[1]).toBe(pageGpu[0]); expect(pageGpu[2]).toBe('undefined');
    expect(pageFonts).toEqual(['monospace', 'monospace', 'monospace']);
  } finally { await Promise.all(pages.map(page => page.close())); }
});

test('same-origin and file restrictions are preserved and source errors reach onerror', async ({ page }) => {
  const { requests } = await fixture(page);
  expect(await page.evaluate(async () => {
    const errors = [];
    for (const source of ['https://other.invalid/worker.js', 'file:///tmp/worker.js']) {
      try { const worker = new Worker(source); worker.terminate(); errors.push('allowed'); } catch (error) { errors.push((error as DOMException).name); }
    }
    return errors;
  })).toEqual(['SecurityError', 'SecurityError']);
  await expect(runWorker(page, '/jobs/fail.js')).rejects.toThrow('source boom');
  expect(requests.filter(path => path.startsWith('/__muse/worker')).length).toBe(1);
});

test('worker constructors follow a later document base URI', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { const base = document.createElement('base'); base.href = '/alternate/'; document.head.appendChild(base); });
  await expect(runWorker(page, '../jobs/child.js')).resolves.toMatchObject({ ua: 'Account Worker A' });
  await page.evaluate(() => { document.querySelector('base')!.href = '/'; });
  await expect(runWorker(page, 'jobs/child.js')).resolves.toMatchObject({ ua: 'Account Worker A' });
});

test('worker-src CSP remains enforced', async ({ page }) => {
  const { requests } = await fixture(page, fp(), "script-src 'self' 'unsafe-inline'; worker-src 'none'");
  await expect(runWorker(page, '/jobs/child.js')).rejects.toThrow('worker failed');
  expect(requests.some(path => path.startsWith('/__muse/worker'))).toBe(false);
});

test('standard fonts load before Worker source performs OffscreenCanvas measurements', async ({ page }) => {
  await fixture(page, fp({ fontMode: 'standard' }));
  const result = await runWorker(page, '/jobs/font.js');
  expect(result.a).toBe(result.b); expect(result.a).toBe(186); expect(result.font).toContain('Muse Standard');
  expect(result.faces).toEqual([{ family: '"Muse Standard"', status: 'loaded' }]);
});

test('standard fonts use bundled bytes for CSS and canvas metrics and keep FontFaceSet.check honest', async ({ page }) => {
  const { requests } = await fixture(page, fp({ fontMode: 'standard' }));
  const result = await page.evaluate(async () => {
    await document.fonts.load('20px "Muse Standard"'); await document.fonts.ready;
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d')!;
    context.font = '20px serif'; const serif = context.measureText('Hello WWW iii 123').width;
    context.font = '20px monospace'; const mono = context.measureText('Hello WWW iii 123').width;
    const font = context.font; context.font = 'not a valid font';
    const face = [...document.fonts].find(face => face.family.replaceAll('"', '') === 'Muse Standard');
    return { serif, mono, font, invalid: context.font, family: getComputedStyle(document.querySelector('#sample')!).fontFamily, loaded: face?.status, faces: [...document.fonts].map(face => ({family: face.family, status: face.status})), check: document.fonts.check('20px "Muse Standard"'), local: typeof (window as any).queryLocalFonts };
  });
  expect(result.serif).toBe(result.mono); expect(result.serif).toBeGreaterThan(100);
  expect(result.font).toContain('Muse Standard'); expect(result.invalid).toBe(result.font);
  expect(result.family).toContain('Muse Standard'); expect(result.loaded, JSON.stringify(result)).toBe('loaded'); expect(result.check).toBe(true); expect(result.local).toBe('undefined');
  expect(requests).toContain('/__muse/fonts/DejaVuSans.ttf');
});
