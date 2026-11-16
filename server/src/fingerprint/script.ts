import type { Fingerprint } from '../types.js';
import { fingerprintUserAgent } from './profile.js';

// This is a document-realm shim, not browser/worker emulation. Keep runtime code
// as readable JavaScript: the server build deliberately has no DOM dependency.
const runtime = String.raw`
'use strict';
const root = globalThis;
if (root.__museFingerprintInstalled) return;
Object.defineProperty(root, '__museFingerprintInstalled', { value: true });
const attempt = action => { try { action(); } catch (_) { /* Optional/locked API. */ } };
const getter = (object, key, value) => attempt(() => Object.defineProperty(object, key, {
  configurable: true, enumerable: true, get: () => value
}));
const replace = (object, key, value) => Object.defineProperty(object, key, {
  ...Object.getOwnPropertyDescriptor(object, key), value
});
const nav = root.navigator;
if (config.ua) {
  getter(nav, 'userAgent', config.ua);
  // Native high-entropy hints would contradict the configured HTTP and JS UA.
  getter(nav, 'userAgentData', undefined);
}
if (config.platform) getter(nav, 'platform', config.platform);
if (config.locale) {
  const languages = Object.freeze([...new Set([config.locale, config.locale.split('-')[0]])]);
  getter(nav, 'language', config.locale);
  getter(nav, 'languages', languages);
}
for (const key of ['hardwareConcurrency', 'deviceMemory']) {
  if (config[key] > 0) getter(nav, key, config[key]);
}
if (config.webdriver) getter(nav, 'webdriver', false);
for (const [field, name] of [['screenWidth', 'width'], ['screenHeight', 'height']]) {
  if (config[field] > 0) {
    getter(root.screen, name, config[field]);
    getter(root.screen, 'avail' + name[0].toUpperCase() + name.slice(1), config[field]);
  }
}
if (config.pixelRatio > 0) getter(root, 'devicePixelRatio', config.pixelRatio);

const NativeDateTimeFormat = root.Intl && Intl.DateTimeFormat;
function defaultOptions(options) {
  if (!config.timezone || options === null) return options;
  if (options !== undefined && options.timeZone !== undefined) return options;
  // Preserve inherited/non-enumerable options and leave caller objects untouched.
  return Object.defineProperty(Object.create(options === undefined ? null : Object(options)),
    'timeZone', { value: config.timezone, enumerable: true });
}
if (config.locale || config.timezone) {
  for (const name of ['DateTimeFormat', 'NumberFormat', 'Collator', 'PluralRules',
    'RelativeTimeFormat', 'ListFormat', 'DisplayNames', 'Segmenter']) attempt(() => {
    const Native = Intl[name];
    if (!Native || (name !== 'DateTimeFormat' && !config.locale)) return;
    const argsFor = args => {
      const out = Array.from(args);
      if (out[0] === undefined && config.locale) out[0] = config.locale;
      if (name === 'DateTimeFormat') out[1] = defaultOptions(out[1]);
      return out;
    };
    const Wrapped = new Proxy(Native, {
      apply(target, receiver, args) { return Reflect.apply(target, receiver, argsFor(args)); },
      construct(target, args, NewTarget) { return Reflect.construct(target, argsFor(args), NewTarget); }
    });
    replace(Native.prototype, 'constructor', Wrapped);
    replace(Intl, name, Wrapped);
  });
  for (const method of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) attempt(() => {
    const native = Date.prototype[method];
    replace(Date.prototype, method, function(locales, options) {
      return native.call(this, locales === undefined && config.locale ? config.locale : locales, defaultOptions(options));
    });
  });
}
if (config.timezone) attempt(() => {
  const formatter = new NativeDateTimeFormat('en-US', {
    timeZone: config.timezone, timeZoneName: 'longOffset'
  });
  const nativeTime = Date.prototype.getTime;
  const nativeOffset = Date.prototype.getTimezoneOffset;
  const offsets = new Map();
  replace(Date.prototype, 'getTimezoneOffset', function() {
    const time = nativeTime.call(this);
    if (!Number.isFinite(time)) return NaN;
    const key = Math.floor(time / 1000);
    if (offsets.has(key)) return offsets.get(key);
    const zone = formatter.formatToParts(time).find(part => part.type === 'timeZoneName').value;
    const match = /^GMT([+-])(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(zone);
    const offset = zone === 'GMT' ? 0 : match
      ? (match[1] === '+' ? -1 : 1) * (+match[2] * 60 + +match[3] + +(match[4] || 0) / 60)
      : nativeOffset.call(this);
    if (offsets.size >= 512) offsets.clear();
    offsets.set(key, offset);
    return offset;
  });
});
// Date local getters/setters, parsing and toString remain native. Explicit Intl
// timeZone/locale always wins. Workers and other browsing contexts are untouched.

const seed = config.seed >>> 0;
function delta(x, y, channel) {
  let hash = seed ^ Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263) ^ Math.imul(channel + 1, 1274126177);
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
  return ((hash ^ (hash >>> 16)) >>> 0) % 3 - 1;
}
const clampByte = value => Math.max(0, Math.min(255, value));
if (config.noise) attempt(() => {
  const context = root.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype;
  const canvas = root.HTMLCanvasElement && HTMLCanvasElement.prototype;
  if (!context || !canvas) return;
  const read = context.getImageData, put = context.putImageData;
  const draw = context.drawImage, getContext = canvas.getContext;
  const attributes = context.getContextAttributes;
  function supported(target) {
    if (!target) return false;
    const options = attributes && attributes.call(target);
    return !options || ((!options.colorSpace || options.colorSpace === 'srgb')
      && (!options.colorType || options.colorType === 'unorm8'));
  }
  function pixels(image, x, y, width, height) {
    if ((image.colorSpace && image.colorSpace !== 'srgb') || !(image.data instanceof Uint8ClampedArray)) return image;
    for (let row = 0; row < image.height; row++) for (let col = 0; col < image.width; col++) {
      const px = x + col, py = y + row, index = (row * image.width + col) * 4;
      // Preserve out-of-bounds transparency and premultiplied-alpha roundtrips.
      if (px < 0 || py < 0 || px >= width || py >= height || image.data[index + 3] !== 255) continue;
      for (let channel = 0; channel < 3; channel++) {
        image.data[index + channel] = clampByte(image.data[index + channel] + delta(px, py, channel));
      }
    }
    return image;
  }
  replace(context, 'getImageData', function(sx, sy, sw, sh) {
    const image = read.apply(this, arguments); // Keep native bounds/taint errors.
    if (!supported(this)) return image;
    const x = Math.trunc(Number(sx)), y = Math.trunc(Number(sy));
    return pixels(image, x + (sw < 0 ? -image.width : 0), y + (sh < 0 ? -image.height : 0), this.canvas.width, this.canvas.height);
  });
  function snapshot(source) {
    if (!source.width || !source.height) return source;
    // Keep wide-gamut/HDR and non-2D exports native; sRGB cloning loses color.
    if (!supported(getContext.call(source, '2d'))) return source;
    const copy = source.ownerDocument.createElement('canvas');
    copy.width = source.width; copy.height = source.height;
    const target = getContext.call(copy, '2d');
    if (!target) return source;
    draw.call(target, source, 0, 0);
    const image = read.call(target, 0, 0, copy.width, copy.height);
    put.call(target, pixels(image, 0, 0, copy.width, copy.height), 0, 0);
    return copy;
  }
  for (const name of ['toDataURL', 'toBlob']) attempt(() => {
    const native = canvas[name];
    if (native) replace(canvas, name, function() { return native.apply(snapshot(this), arguments); });
  });
});
for (const name of ['WebGLRenderingContext', 'WebGL2RenderingContext']) attempt(() => {
  if (!config.webglVendor && !config.webglRenderer) return;
  const prototype = root[name] && root[name].prototype;
  if (!prototype) return;
  const native = prototype.getParameter;
  replace(prototype, 'getParameter', function(parameter) {
    const value = native.apply(this, arguments);
    if (parameter === 37445 && config.webglVendor) return config.webglVendor;
    if (parameter === 37446 && config.webglRenderer) return config.webglRenderer;
    return value;
  });
});

if (config.audioNoise) {
  // Copies intentionally break getChannelData's live writable-view semantics.
  // Use copyToChannel to edit a buffer. No playback buffer or time-domain data is changed.
  attempt(() => {
    const prototype = root.AudioBuffer && AudioBuffer.prototype;
    if (!prototype) return;
    const native = prototype.getChannelData, copy = prototype.copyFromChannel;
    function perturb(data, channel, start, length) {
      for (let i = 0; i < length; i++) if (Number.isFinite(data[i])) data[i] += delta(start + i, channel, 7) * 0.000001;
      return data;
    }
    replace(prototype, 'getChannelData', function(channel) {
      const data = native.apply(this, arguments).slice();
      return perturb(data, Number(channel) >>> 0, 0, data.length);
    });
    if (copy) replace(prototype, 'copyFromChannel', function(destination, channel, start = 0) {
      const result = copy.apply(this, arguments);
      const offset = Number(start) >>> 0;
      perturb(destination, Number(channel) >>> 0, offset, Math.min(destination.length, Math.max(0, this.length - offset)));
      return result;
    });
  });
  for (const name of ['getFloatFrequencyData', 'getByteFrequencyData']) attempt(() => {
    const prototype = root.AnalyserNode && AnalyserNode.prototype;
    if (!prototype || !prototype[name]) return;
    const native = prototype[name], bytes = name === 'getByteFrequencyData';
    replace(prototype, name, function(destination) {
      const result = native.apply(this, arguments);
      const length = Math.min(destination.length, this.frequencyBinCount);
      for (let i = 0; i < length; i++) if (Number.isFinite(destination[i])) {
        const change = delta(i, 0, 11);
        destination[i] = bytes ? clampByte(destination[i] + change) : destination[i] + change * 0.000001;
      }
      return result;
    });
  });
}
if (config.webrtc) {
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection']) attempt(() => {
    const Native = root[name];
    if (!Native) return;
    const blocked = () => { throw new DOMException('WebRTC is disabled by this browser profile', 'NotSupportedError'); };
    replace(root, name, new Proxy(Native, { apply: blocked, construct: blocked }));
  });
}
`;

/** Input is the shared normalized profile. No user-controlled text becomes code. */
export function fingerprintScript(fp: Fingerprint): string | null {
  if (fp.enabled !== true) return null;
  const config = JSON.stringify({ ...fp, ua: fingerprintUserAgent(fp) })
    .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `(function(config){${runtime}})(${config});`;
}

/** Preserve a leading doctype while installing before any upstream executable content. */
export function injectFingerprint(html: string, fp: Fingerprint): string {
  const script = fingerprintScript(fp);
  if (script === null) return html;
  const tag = '<script data-muse-fingerprint>' + script + '</script>';
  let position = /^(?:\uFEFF|\s|<!--[^]*?-->|<!doctype\b[^>]*>)*/i.exec(html)![0].length;
  // Only scan the leading containers; ignore fake tags in comments/attributes.
  for (const name of ['html', 'head']) {
    const match = /^<(html|head)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/i.exec(html.slice(position));
    if (match?.[1]?.toLowerCase() === name) {
      position += match[0].length;
      position += /^(?:\s|<!--[^]*?-->)*/.exec(html.slice(position))![0].length;
    }
  }
  if (html.startsWith('<script data-muse-fingerprint>', position)) return html;
  return html.slice(0, position) + tag + html.slice(position);
}
