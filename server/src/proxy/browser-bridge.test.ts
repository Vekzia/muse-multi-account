import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { browserBridge, injectBrowserBridge } from './browser-bridge.js';

const primary = 'https://muse.ai';
const localOrigin = 'http://127.0.0.1:43123';
const origins = { api: 'https://api.muse.ai' };
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function browser() {
  const fetchCalls: Array<{ input: FetchInput; init: FetchInit }> = [];
  const response = new Response('native response');
  const xhrOpens: unknown[][] = [];
  const xhrSends: Array<{ body: unknown; withCredentials: boolean }> = [];
  const socketCalls: unknown[][] = [];

  // Only the network boundary is replaced. The bridge, URL parsing, Request
  // construction, headers and body streams all execute their real code.
  class NativeXHR {
    withCredentials = false;
    open(...args: unknown[]) { xhrOpens.push(args); }
    send(body?: unknown) { xhrSends.push({ body, withCredentials: this.withCredentials }); }
  }
  class NativeSocket {
    static readonly OPEN = 1;
    constructor(...args: unknown[]) { socketCalls.push(args); }
  }
  const window = {
    fetch: async (input: FetchInput, init?: FetchInit) => {
      fetchCalls.push({ input, init });
      return response;
    },
    XMLHttpRequest: NativeXHR,
    WebSocket: NativeSocket,
  };
  const context = createContext({
    window, XMLHttpRequest: NativeXHR, URL, Request, Headers, Response,
    location: new URL('/account/library', localOrigin),
  });
  const run = (script: string) => runInContext(script, context);
  return { window, context, run, fetchCalls, response, xhrOpens, xhrSends, socketCalls, NativeSocket };
}

function bridgedBrowser() {
  const fixture = browser();
  fixture.run(browserBridge(primary, localOrigin, origins));
  return fixture;
}

describe('generated browser bridge', () => {
  it('maps API fetch to the account origin and enables the local session despite credentials: omit', async () => {
    const { window, fetchCalls, response } = bridgedBrowser();
    const init = { credentials: 'omit' as const, mode: 'cors' as const, headers: { 'x-test': 'retained' } };

    expect(await window.fetch('https://api.muse.ai/videos?limit=2#page', init)).toBe(response);

    expect(fetchCalls).toHaveLength(1);
    const call = fetchCalls[0]!;
    expect(call.input).toBe('http://127.0.0.1:43123/__muse/origin/api/videos?limit=2#page');
    expect(call.init).toMatchObject({ credentials: 'same-origin', mode: 'same-origin' });
    expect(new Request(call.input, call.init).headers.get('x-test')).toBe('retained');
    expect(init).toEqual({ credentials: 'omit', mode: 'cors', headers: { 'x-test': 'retained' } });
  });

  it('passes unknown external fetches through without adding credentials or changing argument identity', async () => {
    const { window, fetchCalls } = bridgedBrowser();
    const url = 'https://api.muse.ai.other.test/collect';
    const init = { headers: { 'x-test': 'external' } };
    const request = new Request('https://other.test/upload', {
      method: 'POST', body: 'external body', credentials: 'omit',
    });

    await window.fetch(url);
    await window.fetch(url, init);
    await window.fetch(request);

    expect(fetchCalls).toHaveLength(3);
    expect(fetchCalls[0]!.input).toBe(url);
    expect(fetchCalls[0]!.init).toBeUndefined();
    expect(fetchCalls[1]!.input).toBe(url);
    expect(fetchCalls[1]!.init).toBe(init);
    expect(fetchCalls[1]!.init).not.toHaveProperty('credentials');
    expect(fetchCalls[2]!.input).toBe(request);
    expect(fetchCalls[2]!.init).toBeUndefined();
    expect(request.credentials).toBe('omit');
    expect(await request.text()).toBe('external body');
  });

  it('retains a mapped Request body, method and headers while enabling same-origin credentials', async () => {
    const { window, fetchCalls } = bridgedBrowser();
    const request = new Request('https://api.muse.ai/videos', {
      method: 'POST', credentials: 'omit',
      headers: { 'content-type': 'application/json', 'x-request-id': 'request-123' },
      body: '{"title":"test upload"}',
    });

    await window.fetch(request);

    expect(fetchCalls).toHaveLength(1);
    const call = fetchCalls[0]!;
    const actual = new Request(call.input, call.init);
    expect(actual.url).toBe('http://127.0.0.1:43123/__muse/origin/api/videos');
    expect(actual.method).toBe('POST');
    expect(actual.credentials).toBe('same-origin');
    expect(actual.mode).toBe('same-origin');
    expect(actual.headers.get('content-type')).toBe('application/json');
    expect(actual.headers.get('x-request-id')).toBe('request-123');
    expect(await actual.text()).toBe('{"title":"test upload"}');
  });

  it('honors fetch init body and header overrides for a mapped Request', async () => {
    const { window, fetchCalls } = bridgedBrowser();
    const request = new Request('https://api.muse.ai/videos/1', {
      method: 'POST', body: 'original', headers: { 'x-original': 'old' },
    });
    await window.fetch(request, {
      method: 'PUT', body: 'replacement', headers: { 'x-replacement': 'new' }, credentials: 'omit',
    });

    const call = fetchCalls[0]!;
    const actual = new Request(call.input, call.init);
    expect(actual.method).toBe('PUT');
    expect(actual.headers.get('x-replacement')).toBe('new');
    expect(actual.headers.has('x-original')).toBe(false);
    expect(await actual.text()).toBe('replacement');
    expect(actual.credentials).toBe('same-origin');
  });

  it('maps XMLHttpRequest URLs, retains open/send arguments and enables credentials at send time', () => {
    const { window, xhrOpens, xhrSends } = bridgedBrowser();
    const xhr = new window.XMLHttpRequest();
    xhr.open('POST', 'https://api.muse.ai/videos?draft=1', true, 'user', 'password');
    xhr.withCredentials = false;
    xhr.send('upload body');

    expect(xhrOpens).toEqual([
      ['POST', 'http://127.0.0.1:43123/__muse/origin/api/videos?draft=1', true, 'user', 'password'],
    ]);
    expect(xhrSends).toEqual([{ body: 'upload body', withCredentials: true }]);
  });

  it('leaves unknown external XMLHttpRequest URLs and credentials unchanged', () => {
    const { window, xhrOpens, xhrSends } = bridgedBrowser();
    const xhr = new window.XMLHttpRequest();
    xhr.open('GET', 'https://other.test/data', true);
    xhr.send();

    expect(xhrOpens).toEqual([['GET', 'https://other.test/data', true]]);
    expect(xhrSends).toEqual([{ body: undefined, withCredentials: false }]);
  });

  it('maps WebSocket scheme, API path and protocols while preserving the native instance', () => {
    const { window, socketCalls, NativeSocket } = bridgedBrowser();
    const protocols = ['muse.v1', 'json'];
    const socket = new window.WebSocket('wss://api.muse.ai/events?token=abc', protocols);
    new window.WebSocket('wss://muse.ai/live');
    new window.WebSocket('wss://other.test/live');

    expect(socketCalls).toEqual([
      ['ws://127.0.0.1:43123/__muse/origin/api/events?token=abc', ['muse.v1', 'json']],
      ['ws://127.0.0.1:43123/live'],
      ['wss://other.test/live'],
    ]);
    expect(socketCalls[0]![1]).toBe(protocols);
    expect(socket).toBeInstanceOf(NativeSocket);
    expect(socket).toBeInstanceOf(window.WebSocket);
    expect(window.WebSocket.OPEN).toBe(1);
  });

  it('keeps WebSocket connections secure for an HTTPS account origin', () => {
    const fixture = browser();
    fixture.run(browserBridge(primary, 'https://account.test', origins));
    new fixture.window.WebSocket('wss://api.muse.ai/events');
    expect(fixture.socketCalls).toEqual([['wss://account.test/__muse/origin/api/events']]);
  });
});

// These fixtures contain inline classic scripts only; evaluate them in HTML
// order so assertions observe what an application script sees at startup.
function executeInlineScripts(html: string, fixture: ReturnType<typeof browser>) {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)];
  for (const script of scripts) fixture.run(script[1]!);
  return scripts;
}

describe('injectBrowserBridge', () => {
  it.each([
    '<html><head data-app="muse">APP</head><body></body></html>',
    '<HTML><HEAD>APP</HEAD><BODY></BODY></HTML>',
    'APP<div>headless document</div>',
  ])('executes the bridge before application scripts in %s', (template) => {
    const fixture = browser();
    const app = '<script>window.fetch("https://api.muse.ai/startup",{credentials:"omit"});</script>';
    const output = injectBrowserBridge(template.replace('APP', app), primary, localOrigin, origins);
    const scripts = executeInlineScripts(output, fixture);

    expect(scripts).toHaveLength(2);
    expect(scripts[0]![0]).toMatch(/^<script data-muse-gateway>/);
    expect(fixture.fetchCalls).toHaveLength(1);
    expect(fixture.fetchCalls[0]!.input).toBe('http://127.0.0.1:43123/__muse/origin/api/startup');
    expect(fixture.fetchCalls[0]!.init).toMatchObject({ credentials: 'same-origin', mode: 'same-origin' });
  });

  it('escapes less-than characters so configuration cannot terminate the injected script', () => {
    const fixture = browser();
    // Adversarial input to the serializer; startup validation is deliberately
    // bypassed here to test escaping independently of alias validation.
    const alias = '</script><script>window.injected=true</script>';
    const app = '<script>window.fetch("https://api.muse.ai/startup");</script>';
    const html = injectBrowserBridge('<head>' + app + '</head>', primary, localOrigin, {
      [alias]: 'https://api.muse.ai',
    });
    const scripts = executeInlineScripts(html, fixture);

    expect(scripts).toHaveLength(2);
    expect(scripts[0]![1]).not.toContain('<');
    expect(fixture.context.window.injected).toBeUndefined();
    expect(fixture.fetchCalls).toHaveLength(1);
    expect(fixture.fetchCalls[0]!.input).toBe(
      'http://127.0.0.1:43123/__muse/origin/%3C/script%3E%3Cscript%3Ewindow.injected=true%3C/script%3E/startup',
    );
    expect(fixture.fetchCalls[0]!.init).toMatchObject({ credentials: 'same-origin' });
  });
});
