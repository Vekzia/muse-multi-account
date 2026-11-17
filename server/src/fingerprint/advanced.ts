import { createHash } from 'node:crypto';
import type { Fingerprint } from '../types.js';
import { fingerprintScript } from './script.js';

export const ADVANCED_WORKER_PATH = '/__muse/worker';
export const STANDARD_FONT_PATH = '/__muse/fonts/DejaVuSans.ttf';
export interface AdvancedFingerprintOptions {
  primaryOrigin: string;
  localOrigin: string;
  additionalOrigins?: Record<string, string>;
}
export interface WorkerBootstrapResponse { status: number; headers: Record<string, string>; body: string }
type AdvancedProfile = Fingerprint & { workerMode?: 'native' | 'profile'; fontMode?: 'native' | 'standard'; webgpuMode?: 'native' | 'disabled' };

function active(fp: AdvancedProfile): boolean {
  return fp.enabled === true && (fp.workerMode === 'profile' || fp.fontMode === 'standard' || fp.webgpuMode === 'disabled');
}
function literal(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

// A single self-contained runtime is also serialized into blob workers. No eval,
// fetch-and-reexecute, window or XMLHttpRequest dependency exists in worker code.
const runtime = String.raw`function install(config) {
'use strict';
const root = globalThis;
if (root.__museAdvancedInstalled) return;
Object.defineProperty(root, '__museAdvancedInstalled', { value: true });
const attempt = action => { try { return action(); } catch (_) {} };
const local = config.local || (root.location && root.location.origin);
const base = config.base || (root.document && root.document.baseURI) || (root.location && root.location.href);
const routes = config.routes;
if (config.worker && root.URL && root.location) {
  const Native = root.URL, wrapperHref = root.location.href;
  // Keep raw WorkerLocation native. Explicit URL construction with that wrapper
  // as its base must resolve as if the original entry resource started the worker.
  root.URL = new Proxy(Native, { construct(target, args, newTarget) {
    const next = Array.from(args);
    if (next.length && String(next[0]) === wrapperHref) next[0] = base;
    if (next.length > 1 && String(next[1]) === wrapperHref) next[1] = base;
    return Reflect.construct(target, next, newTarget);
  } });
}
function mapped(value) {
  const url = new URL(String(value), base);
  const origin = url.origin.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
  if (Object.prototype.hasOwnProperty.call(routes, origin)) {
    const result = new URL(local);
    if (url.protocol === 'ws:' || url.protocol === 'wss:') result.protocol = result.protocol === 'https:' ? 'wss:' : 'ws:';
    result.pathname = routes[origin] + url.pathname; result.search = url.search; result.hash = url.hash;
    return result.href;
  }
  return url.href;
}
function hide(object, name) {
  for (let cursor = object; cursor && cursor !== Object.prototype; cursor = Object.getPrototypeOf(cursor)) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
    if (descriptor && descriptor.configurable) attempt(() => { delete cursor[name]; });
  }
  if (object && name in object) attempt(() => Object.defineProperty(object, name, { configurable: true, get: () => undefined }));
}
if (config.gpu) hide(root.navigator, 'gpu');

let fontsReady;
if (config.font) {
  hide(root, 'queryLocalFonts');
  const family = '"Muse Standard", sans-serif';
  const fonts = root.document ? root.document.fonts : root.fonts;
  if (root.FontFace && fonts) attempt(() => {
    const face = new FontFace('Muse Standard', 'url(' + JSON.stringify(new URL(config.fontPath, local).href) + ')');
    fonts.add(face);
    // Failure leaves normal fallback metrics; never fabricate a loaded face/check.
    fontsReady = face.load().catch(() => undefined);
  });
  if (root.document) {
    const style = document.createElement('style');
    style.setAttribute('data-muse-standard-font', '');
    style.textContent = ':root,body,body *,body *::before,body *::after{font-family:' + family + '!important}';
    (document.head || document.documentElement).appendChild(style);
  }
  for (const name of ['CanvasRenderingContext2D', 'OffscreenCanvasRenderingContext2D']) attempt(() => {
    const prototype = root[name] && root[name].prototype;
    if (!prototype) return;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'font');
    if (!descriptor || !descriptor.set || !descriptor.get) return;
    function normalize(context) {
      const canonical = descriptor.get.call(context);
      const match = /^(.*?\b\d+(?:\.\d+)?px)(?:\s*\/\s*[^\s]+)?\s+.+$/.exec(canonical);
      if (match) descriptor.set.call(context, match[1] + ' ' + family);
    }
    Object.defineProperty(prototype, 'font', { ...descriptor, set(value) {
      // The native setter validates first, preserving invalid-assignment behavior.
      descriptor.set.call(this, value); normalize(this);
    } });
    for (const method of ['measureText', 'fillText', 'strokeText']) {
      const native = prototype[method];
      if (native) prototype[method] = function() { normalize(this); return Reflect.apply(native, this, arguments); };
    }
  });
}

if (config.worker) {
  if (root.Request) {
    const Native = root.Request;
    root.Request = new Proxy(Native, { construct(target, args, newTarget) {
      if (!args.length || args[0] instanceof Native) return Reflect.construct(target, args, newTarget);
      const next = Array.from(args); next[0] = mapped(next[0]);
      return Reflect.construct(target, next, newTarget);
    } });
  }
  if (root.fetch) {
    const native = root.fetch;
    root.fetch = function(input, init) {
      const target = mapped(input instanceof Request ? input.url : input);
      const isLocal = new URL(target).origin === local;
      if (input instanceof Request) {
        const source = new Request(input, init);
        const options = { method: source.method, headers: source.headers, mode: isLocal ? 'same-origin' : source.mode,
          credentials: isLocal ? 'same-origin' : source.credentials, cache: source.cache, redirect: source.redirect,
          referrer: source.referrer, referrerPolicy: source.referrerPolicy, integrity: source.integrity, signal: source.signal };
        if (source.method !== 'GET' && source.method !== 'HEAD') { options.body = source.body; options.duplex = 'half'; }
        return native.call(this, target, options);
      }
      return native.call(this, target, isLocal ? Object.assign({}, init, { credentials: 'same-origin', mode: 'same-origin' }) : init);
    };
  }
  if (root.importScripts) {
    const native = root.importScripts;
    root.importScripts = function() { return Reflect.apply(native, this, Array.from(arguments, mapped)); };
  }
  if (root.WebSocket) {
    const Native = root.WebSocket;
    root.WebSocket = new Proxy(Native, { construct(target, args, newTarget) {
      const next = Array.from(args); next[0] = mapped(next[0]); return Reflect.construct(target, next, newTarget);
    } });
  }
}

// Remember caller-created Blob values without reading/re-evaluating their text.
// A private URL snapshots the source at construction, just as native Worker does,
// so immediately revoking the caller URL cannot race the deferred source import.
const blobs = new Map(), blobWrappers = new Map(), pendingBlobs = new Map();
let blobSequence = 0;
const nativeCreateURL = root.URL && URL.createObjectURL;
const nativeRevokeURL = root.URL && URL.revokeObjectURL;
if (nativeCreateURL && nativeRevokeURL) {
  URL.createObjectURL = function(value) {
    const url = nativeCreateURL.call(this, value);
    if (value instanceof Blob) blobs.set(url, value);
    return url;
  };
  URL.revokeObjectURL = function(value) {
    const source = String(value);
    blobs.delete(source);
    const variants = blobWrappers.get(source);
    if (variants) {
      for (const record of variants.values()) {
        record.revoked = true;
        nativeRevokeURL.call(URL, record.url);
        if (record.ready && record.privateSource) nativeRevokeURL.call(URL, record.privateSource);
      }
      blobWrappers.delete(source);
    }
    return nativeRevokeURL.call(this, source);
  };
}
function wrapSource(input, type, sharedName) {
  const sourceBase = root.document ? root.document.baseURI : base;
  const source = new URL(String(input), sourceBase);
  // Do not map remote worker constructors into our origin. Native constructors
  // retain their same-origin, file:, data:, CSP and Trusted Types checks.
  if (source.origin !== local || source.username || source.password) return input;
  if (source.protocol === 'http:' || source.protocol === 'https:') {
    if (source.pathname.startsWith('/__muse/') && !Object.values(routes).some(prefix => prefix && source.pathname.startsWith(prefix + '/'))) return input;
    const wrapper = new URL(config.workerPath, local);
    wrapper.search = new URLSearchParams({ src: source.href, type, v: config.version }).toString();
    return wrapper.href;
  }
  if (source.protocol !== 'blob:' || !root.Blob || !URL.createObjectURL) return input;
  let variants = blobWrappers.get(source.href);
  if (!variants) { variants = new Map(); blobWrappers.set(source.href, variants); }
  const key = type + (sharedName === null ? ':dedicated:' + ++blobSequence : ':shared:' + sharedName);
  if (!variants.has(key)) {
    const blob = blobs.get(source.href);
    const privateSource = blob ? nativeCreateURL.call(URL, blob) : '';
    const record = { url: '', privateSource, ready: false, revoked: false, channel: null, cleanup: null };
    record.cleanup = () => {
      if (record.channel) record.channel.close();
      nativeRevokeURL.call(URL, record.url);
      if (privateSource) nativeRevokeURL.call(URL, privateSource);
      pendingBlobs.delete(record.url); variants.delete(key);
    };
    const readyChannel = privateSource && root.BroadcastChannel ? 'muse-worker-' + privateSource : '';
    if (readyChannel) {
      const channel = new BroadcastChannel(readyChannel); record.channel = channel;
      channel.onmessage = () => {
        record.ready = true;
        if (record.revoked || sharedName === null) record.cleanup();
        channel.close();
      };
    }
    const child = Object.assign({}, config, { worker: true, source: privateSource || source.href, base: sourceBase, type, readyChannel });
    const code = (config.core || '') + '(' + install.toString() + ')(' + JSON.stringify(child) + ');';
    record.url = nativeCreateURL.call(URL, new Blob([code], { type: 'text/javascript' }));
    variants.set(key, record); pendingBlobs.set(record.url, record);
  }
  return variants.get(key).url;
}
for (const name of ['Worker', 'SharedWorker']) attempt(() => {
  const Native = root[name];
  if (!Native) return;
  root[name] = new Proxy(Native, { construct(target, args, newTarget) {
    if (!args.length) return Reflect.construct(target, args, newTarget);
    // Leave native validation of malformed option dictionaries in place.
    const options = args[1];
    const type = options && typeof options === 'object' && options.type === 'module' ? 'module' : 'classic';
    const sharedName = name === 'SharedWorker' ? (typeof options === 'string' ? options : String(options && options.name || '')) : null;
    const next = Array.from(args); next[0] = wrapSource(next[0], type, sharedName);
    const record = pendingBlobs.get(next[0]);
    try {
      const worker = Reflect.construct(target, next, newTarget);
      if (record) {
        worker.addEventListener('error', record.cleanup, { once: true });
        if (name === 'Worker') {
          const terminate = worker.terminate;
          worker.terminate = function() { record.cleanup(); return Reflect.apply(terminate, this, arguments); };
        }
      }
      return worker;
    } catch (error) { if (record) record.cleanup(); throw error; }
  } });
});

if (config.worker && config.source) {
  const ready = () => {
    if (config.readyChannel && root.BroadcastChannel) {
      const channel = new BroadcastChannel(config.readyChannel); channel.postMessage('ready'); channel.close();
    }
  };
  const load = () => {
    try {
      if (config.type === 'module') return import(config.source).finally(ready);
      try { return root.importScripts(config.source); } finally { ready(); }
    } catch (error) { ready(); throw error; }
  };
  if (config.type === 'module' || fontsReady) {
    // Dynamic import/font loading yields to the event loop. Preserve startup
    // message and SharedWorker connect delivery until source handlers exist.
    const queued = [];
    const capture = event => { queued.push(event); event.stopImmediatePropagation(); };
    for (const type of ['message', 'connect']) root.addEventListener(type, capture);
    const release = () => {
      for (const type of ['message', 'connect']) root.removeEventListener(type, capture);
      for (const event of queued) root.dispatchEvent(new MessageEvent(event.type, {
        data: event.data, origin: event.origin, lastEventId: event.lastEventId, source: event.source, ports: event.ports
      }));
    };
    Promise.resolve(fontsReady).then(load).then(release, error => {
      for (const type of ['message', 'connect']) root.removeEventListener(type, capture);
      setTimeout(() => { throw error; }, 0);
    });
  } else load();
}
}`;

function configuration(fp: AdvancedProfile, options?: AdvancedFingerprintOptions) {
  const routes: Record<string, string> = {};
  if (options) {
    const primary = new URL(options.primaryOrigin);
    routes[primary.origin] = '';
    if (primary.hostname === 'muse.ai') routes['https://www.muse.ai'] = '';
    for (const [alias, origin] of Object.entries(options.additionalOrigins ?? {})) routes[new URL(origin).origin] = '/__muse/origin/' + alias;
  }
  // Window-only APIs in fingerprintScript are individually guarded. Explicitly
  // clear screen/pixelRatio to avoid inventing window globals in worker realms.
  const core = fp.workerMode === 'profile' ? fingerprintScript({ ...fp, screenWidth: 0, screenHeight: 0, pixelRatio: 0 }) ?? '' : '';
  const config = { gpu: fp.webgpuMode === 'disabled', font: fp.fontMode === 'standard', core,
    local: options ? new URL(options.localOrigin).origin : '', routes,
    workerPath: ADVANCED_WORKER_PATH, fontPath: STANDARD_FONT_PATH };
  // Version the profile, not request origins: the public page API permits omitted
  // mapping options while the authenticated gateway always has concrete origins.
  const version = createHash('sha256').update(JSON.stringify([config.gpu, config.font, core])).digest('hex').slice(0, 24);
  return { ...config, version };
}

/** Install after the page fingerprint runtime, before any upstream script. */
export function advancedFingerprintScript(fp: AdvancedProfile, options?: AdvancedFingerprintOptions): string | null {
  if (!active(fp)) return null;
  return `(${runtime})(${literal(configuration(fp, options))});`;
}

/**
 * Call only on an authenticated account gateway GET before proxying upstream.
 * This helper never fetches source or permits arbitrary upstream URLs. The
 * returned JS imports the actual resource with native browser loading rules.
 * ServiceWorker registration/existing controllers deliberately remain native.
 */
export function workerBootstrapResponse(fp: AdvancedProfile, requestUrl: string, options: AdvancedFingerprintOptions): WorkerBootstrapResponse | null {
  const request = new URL(requestUrl, options.localOrigin);
  if (request.pathname !== ADVANCED_WORKER_PATH) return null;
  const headers = { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' };
  const response = (status: number, body: string): WorkerBootstrapResponse => ({ status, headers, body });
  if (!active(fp)) return response(404, '/* Worker policies are native. */');
  let source: URL;
  const type = request.searchParams.get('type');
  try { source = new URL(request.searchParams.get('src') ?? ''); } catch { return response(400, '/* Invalid worker source. */'); }
  if (request.searchParams.getAll('src').length !== 1 || request.searchParams.getAll('type').length !== 1
    || (type !== 'classic' && type !== 'module') || !['http:', 'https:'].includes(source.protocol)
    || source.origin !== new URL(options.localOrigin).origin || source.username || source.password
    || (source.pathname.startsWith('/__muse/') && !Object.keys(options.additionalOrigins ?? {}).some(alias => source.pathname.startsWith('/__muse/origin/' + alias + '/')))) return response(400, '/* Invalid worker source. */');
  const config = configuration(fp, options);
  const version = request.searchParams.get('v');
  if (version && version !== config.version) return response(409, '/* Browser profile changed; reload the page. */');
  return response(200, config.core + `(${runtime})(${literal({ ...config, worker: true, source: source.href, base: source.href, type })});`);
}
