import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

class Element {
  value = ''; hidden = false; textContent = ''; innerHTML = ''; className = ''; checked = false; disabled = false; open = false;
  method = ''; action = ''; target = ''; name = ''; type = ''; files: Array<{ text(): Promise<string> }> = []; src = ''; children: Element[] = [];
  handlers = new Map<string, (event: { preventDefault(): void }) => unknown>();
  attributes: Record<string, string> = {};
  classList = { add() {}, remove() {}, toggle() { return true; } };
  constructor(public id = '') {}
  addEventListener(name: string, handler: (event: { preventDefault(): void }) => unknown) { this.handlers.set(name, handler); }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  dataset: Record<string, string> = {};
  querySelectorAll() {
    if (this.id !== 'account-list') return [];
    const rows = [...this.innerHTML.matchAll(/data-account-id="(\d+)"/g)].map((match) => {
      const row = new Element(); row.dataset.accountId = match[1]!; return row;
    });
    this.children = rows;
    return rows;
  }
  showModal() { this.open = true; } close() { this.open = false; } focus() {}
  appendChild(element: Element) { this.children.push(element); } remove() {}
  submit() {}
  async trigger(name: string) { await this.handlers.get(name)?.({ preventDefault() {} }); }
}
async function fixture(handler: (url: string, options: RequestInit) => Promise<unknown>, savedToken = 'secret', offline = false, confirm = (_message: string) => true) {
  const html = await readFile(new URL('../../public/index.html', import.meta.url), 'utf8');
  const code = await readFile(new URL('../../public/app.js', import.meta.url), 'utf8');
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1]!, new Element(match[1])]));
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const submitted: Element[] = [];
  const storage = new Map(savedToken ? [['muse.accessToken', savedToken]] : []);
  const timers: Array<() => void> = [];
  let eventStream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const fetch = async (url: string, options: RequestInit = {}) => {
    calls.push({ url, options });
    if (url === '/api/events') {
      if (offline) throw new TypeError('Connection failed');
      return { ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start(controller) { eventStream = controller; } }) };
    }
    return handler(url, options);
  };
  runInNewContext(code, {
    document: { getElementById: (id: string) => elements.get(id), body: new Element('body'), createElement: () => { const el = new Element(); el.submit = () => { submitted.push(el); }; return el; } },
    sessionStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    localStorage: { setItem: () => { throw new Error('Persistent token storage used'); } },
    window: { setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimeout() {}, confirm, prompt: () => 'New account' },
    location: { reload() {} }, fetch, Headers, AbortController, TextDecoder, URL, ReadableStream, console,
  });
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  await flush();
  return { elements, calls, submitted, storage, timers, flush, get eventStream() { return eventStream; } };
}
const response = (body: unknown, status = 200) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
const account = { id: 1, name: 'Work', group: '', tags: [], proxy: '', proxyPool: [], version: 1, avatar: 'm' };
const fp = { enabled: false, uaMode: 'system', uaCustom: '', timezone: '', locale: '', platform: '', screenWidth: 0, screenHeight: 0, pixelRatio: 0, hardwareConcurrency: 0, deviceMemory: 0, webglVendor: '', webglRenderer: '', seed: 123456, noise: false, audioNoise: false, webrtc: false, webdriver: false };
const fpAccount = { ...account, fp };

function field(page: Awaited<ReturnType<typeof fixture>>, id: string) {
  const element = page.elements.get(id);
  expect(element, `UI field ${id} exists`).toBeDefined();
  return element!;
}

async function change(page: Awaited<ReturnType<typeof fixture>>, id: string, value: string | boolean) {
  const element = field(page, id);
  if (typeof value === 'boolean') element.checked = value; else element.value = value;
  await element.trigger('input');
  await element.trigger('change');
}

describe('native WebUI behavior', () => {
  it('shows an empty state and authenticates both fetch and SSE without a URL token', async () => {
    const page = await fixture(() => response({ accounts: [] }));
    expect(page.elements.get('empty-state')?.hidden).toBe(false);
    expect(page.elements.get('loading-state')?.hidden).toBe(true);
    expect(page.calls.map((call) => call.url)).toContain('/api/events');
    for (const call of page.calls) {
      expect(new Headers(call.options.headers).get('Authorization')).toBe('Bearer secret');
      expect(call.url).not.toContain('secret');
    }
  });

  it('keeps load failure distinct from an empty account list and marks the connection offline', async () => {
    const page = await fixture(async () => { throw new TypeError('Connection failed'); }, 'secret', true);
    expect(page.elements.get('error-state')?.hidden).toBe(false);
    expect(page.elements.get('empty-state')?.hidden).toBe(true);
    expect(page.elements.get('connection-state')?.textContent).toBe('离线');
  });

  it('launches an isolated gateway with a single-use token in POST body and an inline target', async () => {
    const page = await fixture((url) => response(url === '/api/session' ? { url: 'http://localhost:8788/__muse/launch', token: 'one-time-secret' } : { accounts: [account] }));
    await page.elements.get('launch-button')?.trigger('click');
    expect(page.submitted).toHaveLength(1);
    expect(page.submitted[0]).toMatchObject({ method: 'POST', action: 'http://localhost:8788/__muse/launch', target: 'muse-workspace' });
    expect(page.submitted[0]?.children[0]).toMatchObject({ type: 'hidden', name: 'token', value: 'one-time-secret' });
    expect(page.submitted[0]?.action).not.toContain('secret');
  });

  it('does not save redacted proxy passwords back to the server', async () => {
    const privateAccount = { ...account, proxy: 'http://***:***@proxy.example:8080', proxyPool: ['http://***:***@pool.example:8080'] };
    const page = await fixture(() => response({ accounts: [privateAccount] }));
    await page.elements.get('proxy-form')?.trigger('submit');
    expect(page.calls.filter((call) => call.options.method === 'PATCH')).toHaveLength(0);
    page.elements.get('proxy-input')!.value = 'http://new-proxy.example:8080';
    await page.elements.get('proxy-form')?.trigger('submit');
    const patch = page.calls.find((call) => call.options.method === 'PATCH');
    expect(JSON.parse(String(patch?.options.body))).toEqual({ proxy: 'http://new-proxy.example:8080' });
  });

  it('refreshes the selected account login badge after its Muse frame loads', async () => {
    const page = await fixture((url) => response(url.endsWith('/status') ? { status: { logged: true } } : { accounts: [account] }));
    await page.elements.get('muse-frame')?.trigger('load');
    await page.flush();
    expect(page.calls.map((call) => call.url)).toContain('/api/accounts/1/status');
    expect(page.elements.get('account-status')?.textContent).toBe('Muse 会话正在使用。');
  });

  it('clears the old workspace before creating an account and relaunches the new account when open', async () => {
    const created = { ...account, id: 2, name: 'New account', version: 1 };
    const page = await fixture((url, options) => {
      if (url === '/api/session') {
        const id = JSON.parse(String(options.body)).accountId;
        return response({ url: `http://localhost:${8787 + id}/__muse/launch`, token: `launch-${id}` });
      }
      if (url === '/api/accounts' && options.method === 'POST') return response({ account: created }, 201);
      return response({ accounts: [account] });
    });
    await page.elements.get('launch-button')?.trigger('click');
    expect(page.submitted).toHaveLength(1);
    await page.elements.get('new-account-button')?.trigger('click');
    await page.flush();
    expect(page.elements.get('muse-frame')?.src).toBe('about:blank');
    expect(page.submitted).toHaveLength(2);
    expect(page.submitted[1]?.action).toBe('http://localhost:8789/__muse/launch');
    expect(JSON.parse(String(page.calls.find((call) => call.url === '/api/accounts')?.options.body || '{}'))).not.toHaveProperty('token');
  });

  it('ignores a delayed launch for account A after the user selects account B', async () => {
    const other = { ...account, id: 2, name: 'Other' };
    let resolveLaunch!: (value: unknown) => void;
    const delayed = new Promise((resolve) => { resolveLaunch = resolve; });
    const page = await fixture((url) => {
      if (url === '/api/session') return delayed;
      if (url === '/api/accounts/2/select') return response({ account: other });
      return response({ accounts: [account, other] });
    });
    const opening = page.elements.get('launch-button')!.trigger('click');
    await page.flush();
    await page.elements.get('account-list')!.children.find((row) => row.dataset.accountId === '2')!.trigger('click');
    resolveLaunch(await response({ url: 'http://localhost:8788/__muse/launch', token: 'old-launch' }));
    await opening;
    expect(page.elements.get('account-title')?.textContent).toBe('Other');
    expect(page.submitted).toHaveLength(0);
  });

  it.each([
    ['name-input', 'account-form', 'Local draft'],
    ['proxy-input', 'proxy-form', 'http://draft.example:8080'],
  ])('keeps dirty %s after SSE updates and submits its original version for a 409', async (field, form, draft) => {
    let reads = 0;
    const page = await fixture((url, options) => {
      if (options.method === 'PATCH') return response({ error: 'Account changed. Refresh and retry.' }, 409);
      if (url.startsWith('/api/accounts?')) return response({ accounts: [++reads === 1 ? account : { ...account, name: 'Remote name', version: 2, logged: true }] });
      return response({ accounts: [account] });
    });
    page.elements.get(field)!.value = draft;
    await page.elements.get(field)?.trigger('input');
    page.eventStream?.enqueue(new TextEncoder().encode('data: {"type":"change"}\n\n'));
    await page.flush();
    expect(reads).toBe(2);
    expect(page.elements.get(field)?.value).toBe(draft);
    expect(page.elements.get('account-list')?.innerHTML).toContain('Remote name');
    expect(page.elements.get('account-status')?.textContent).toBe('Muse 会话正在使用。');
    await page.elements.get(form)?.trigger('submit');
    const patch = page.calls.find((call) => call.options.method === 'PATCH');
    expect(new Headers(patch?.options.headers).get('If-Match')).toBe('1');
    expect(page.elements.get(field)?.value).toBe(draft);
    expect(page.elements.get('notice')?.textContent).toContain('刷新后重试');
  });

  it('renders disabled fingerprint defaults and the stable backend seed', async () => {
    const page = await fixture(() => response({ accounts: [fpAccount] }));
    expect(field(page, 'fp-enabled').checked).toBe(false);
    expect(field(page, 'fp-seed').value).toBe('123456');
    expect(field(page, 'fp-mode').value).toBe('system');
    expect(field(page, 'fp-save').disabled).toBe(true);
  });

  it('keeps independent fingerprint, account and proxy drafts through SSE and preserves the fingerprint baseline on conflict', async () => {
    let reads = 0;
    const page = await fixture((url, options) => {
      if (options.method === 'PATCH') return response({ error: 'Account changed. Refresh and retry.' }, 409);
      if (url.startsWith('/api/accounts?')) return response({ accounts: [++reads === 1 ? fpAccount : { ...fpAccount, name: 'Remote', version: 2, fp: { ...fp, timezone: 'Asia/Tokyo' } }] });
      return response({ accounts: [fpAccount] });
    });
    await change(page, 'fp-locale', 'zh-CN');
    await change(page, 'name-input', 'Local name');
    await change(page, 'proxy-input', 'http://draft.example:8080');
    page.eventStream?.enqueue(new TextEncoder().encode('data: {"type":"change"}\n\n'));
    await page.flush();
    expect(field(page, 'fp-locale').value).toBe('zh-CN');
    expect(field(page, 'fp-timezone').value).toBe('');
    await field(page, 'fp-form').trigger('submit');
    const patch = page.calls.find((call) => call.options.method === 'PATCH')!;
    expect(new Headers(patch.options.headers).get('If-Match')).toBe('1');
    expect(JSON.parse(String(patch.options.body))).toMatchObject({ fp: { locale: 'zh-CN' } });
    expect(field(page, 'fp-locale').value).toBe('zh-CN');
    expect(field(page, 'name-input').value).toBe('Local name');
    expect(field(page, 'proxy-input').value).toBe('http://draft.example:8080');
    expect(field(page, 'fp-status').textContent).toContain('冲突');
  });

  it('saves validated fingerprint only, keeping unrelated drafts and omitting the readonly seed', async () => {
    const page = await fixture((url, options) => options.method === 'PATCH'
      ? response({ account: { ...fpAccount, version: 2, fp: { ...fp, enabled: true, locale: 'zh-CN', screenWidth: 1920 } } })
      : response({ accounts: [fpAccount] }));
    await change(page, 'name-input', 'Local name');
    await change(page, 'proxy-input', 'http://draft.example:8080');
    await change(page, 'fp-enabled', true);
    await change(page, 'fp-locale', 'zh-CN');
    await change(page, 'fp-width', '1920');
    field(page, 'fp-seed').value = '9';
    await field(page, 'fp-form').trigger('submit');
    const patch = page.calls.find((call) => call.options.method === 'PATCH')!;
    const body = JSON.parse(String(patch.options.body));
    expect(Object.keys(body)).toEqual(['fp']);
    expect(body.fp).toMatchObject({ enabled: true, locale: 'zh-CN', screenWidth: 1920 });
    expect(body.fp).not.toHaveProperty('seed');
    expect(field(page, 'fp-seed').value).toBe('123456');
    expect(field(page, 'fp-save').disabled).toBe(true);
    expect(field(page, 'name-input').value).toBe('Local name');
    expect(field(page, 'proxy-input').value).toBe('http://draft.example:8080');
  });

  it.each([
    ['fp-timezone', 'Mars/Olympus'], ['fp-locale', 'bad_locale'], ['fp-width', '-1'],
    ['fp-width', '16385'], ['fp-ratio', 'Infinity'], ['fp-cores', '1.5'], ['fp-memory', '-1'],
    ['fp-ratio', '0.1'], ['fp-cores', '257'], ['fp-memory', '3'],
    ['fp-custom', 'UA\r\nInjected: yes'], ['fp-custom', 'UA🙂'],
  ])('validates %s before sending fingerprint changes', async (id, value) => {
    const page = await fixture(() => response({ accounts: [fpAccount] }));
    await change(page, id, value);
    await field(page, 'fp-form').trigger('submit');
    expect(page.calls.filter((call) => call.options.method === 'PATCH')).toHaveLength(0);
    expect(field(page, 'fp-status').textContent).toBeTruthy();
  });

  it.each(['windows', 'macos', 'android'])('generates %s with confirmation and original version, retaining account drafts', async (mode) => {
    const confirmations: string[] = [];
    const page = await fixture((url) => url.endsWith('/fingerprint/generate')
      ? response({ account: { ...fpAccount, version: 2, fp: { ...fp, enabled: true, uaMode: mode, seed: 987654, screenWidth: 1920 } } })
      : response({ accounts: [fpAccount] }), 'secret', false, (message) => { confirmations.push(message); return true; });
    await change(page, 'name-input', 'Local name');
    await change(page, 'fp-mode', mode);
    await field(page, 'fp-generate').trigger('click');
    const generated = page.calls.find((call) => call.url.endsWith('/fingerprint/generate'))!;
    expect(generated.options.method).toBe('POST');
    expect(new Headers(generated.options.headers).get('If-Match')).toBe('1');
    expect(JSON.parse(String(generated.options.body))).toEqual({ mode });
    expect(confirmations).toHaveLength(1);
    expect(field(page, 'fp-seed').value).toBe('987654');
    expect(field(page, 'fp-width').value).toBe('1920');
    expect(field(page, 'fp-enabled').checked).toBe(true);
    expect(field(page, 'name-input').value).toBe('Local name');
    expect(page.calls.some((call) => call.url.includes('/cookies') || call.options.method === 'DELETE')).toBe(false);
  });

  it('cancels regeneration without a request and requires a supported preset', async () => {
    const page = await fixture(() => response({ accounts: [fpAccount] }), 'secret', false, () => false);
    await field(page, 'fp-generate').trigger('click');
    expect(field(page, 'fp-status').textContent).toContain('预设');
    await change(page, 'fp-mode', 'windows');
    await field(page, 'fp-generate').trigger('click');
    expect(page.calls.some((call) => call.url.endsWith('/fingerprint/generate'))).toBe(false);
  });

  it('resets native fingerprint with PATCH and preserves the backend seed', async () => {
    const page = await fixture((url, options) => options.method === 'PATCH'
      ? response({ account: { ...fpAccount, version: 2 } })
      : response({ accounts: [{ ...fpAccount, fp: { ...fp, enabled: true, uaMode: 'windows', noise: true } }] }));
    await field(page, 'fp-reset').trigger('click');
    const patch = page.calls.find((call) => call.options.method === 'PATCH')!;
    expect(patch.url).toBe('/api/accounts/1');
    expect(JSON.parse(String(patch.options.body))).toEqual({ fp: null });
    expect(field(page, 'fp-enabled').checked).toBe(false);
    expect(field(page, 'fp-seed').value).toBe('123456');
    expect(page.calls.some((call) => call.options.method === 'DELETE')).toBe(false);
  });

  it('launches selfcheck through the hidden POST token form and reopens that same target after save', async () => {
    const confirmations: string[] = [];
    const page = await fixture((url, options) => {
      if (url === '/api/session') return response({ url: 'http://localhost:8788/__muse/launch', token: 'check-token' });
      if (options.method === 'PATCH') return response({ account: { ...fpAccount, version: 2, fp: { ...fp, locale: 'zh-CN' } } });
      return response({ accounts: [fpAccount] });
    }, 'secret', false, (message) => { confirmations.push(message); return true; });
    await field(page, 'fp-check').trigger('click');
    await change(page, 'fp-locale', 'zh-CN');
    await field(page, 'fp-form').trigger('submit');
    const sessions = page.calls.filter((call) => call.url === '/api/session');
    expect(sessions.map((call) => JSON.parse(String(call.options.body)))).toEqual([{ accountId: 1, target: 'fingerprint' }, { accountId: 1, target: 'fingerprint' }]);
    expect(page.submitted).toHaveLength(2);
    expect(page.submitted[1]).toMatchObject({ method: 'POST', target: 'muse-workspace' });
    expect(page.submitted[1]?.children[0]).toMatchObject({ type: 'hidden', name: 'token', value: 'check-token' });
    expect(confirmations[0]).toContain('重新打开');
  });

  it('does not relaunch or overwrite B when a fingerprint save for A finishes late', async () => {
    const other = { ...fpAccount, id: 2, name: 'Other', fp: { ...fp, locale: 'en-US' } };
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => { finish = resolve; });
    const page = await fixture((url, options) => {
      if (url === '/api/session') return response({ url: 'http://localhost:8788/__muse/launch', token: 'launch' });
      if (options.method === 'PATCH') return pending;
      if (url === '/api/accounts/2/select') return response({ account: other });
      return response({ accounts: [fpAccount, other] });
    });
    await field(page, 'launch-button').trigger('click');
    await change(page, 'fp-locale', 'zh-CN');
    const saving = field(page, 'fp-form').trigger('submit');
    await page.flush();
    await field(page, 'account-list').children.find((row) => row.dataset.accountId === '2')!.trigger('click');
    await change(page, 'fp-locale', 'de-DE');
    const sessionsBefore = page.calls.filter((call) => call.url === '/api/session').length;
    finish(await response({ account: { ...fpAccount, version: 2, fp: { ...fp, locale: 'zh-CN' } } }));
    await saving;
    expect(field(page, 'account-title').textContent).toBe('Other');
    expect(field(page, 'fp-locale').value).toBe('de-DE');
    expect(page.calls.filter((call) => call.url === '/api/session')).toHaveLength(sessionsBefore);
  });

  it('restores each account fingerprint draft and can discard it to the latest remote baseline', async () => {
    const other = { ...fpAccount, id: 2, name: 'Other', version: 4 };
    const remote = { ...fpAccount, version: 3, fp: { ...fp, locale: 'en-US' } };
    const page = await fixture((url) => {
      if (url === '/api/accounts/1/select') return response({ account: remote });
      if (url === '/api/accounts/2/select') return response({ account: other });
      return response({ accounts: [fpAccount, other] });
    });
    await change(page, 'fp-locale', 'zh-CN');
    await field(page, 'account-list').children.find((row) => row.dataset.accountId === '2')!.trigger('click');
    await change(page, 'fp-locale', 'de-DE');
    await field(page, 'account-list').children.find((row) => row.dataset.accountId === '1')!.trigger('click');
    expect(field(page, 'fp-locale').value).toBe('zh-CN');
    expect(field(page, 'fp-status').textContent).toContain('冲突');
    await field(page, 'fp-discard').trigger('click');
    expect(field(page, 'fp-locale').value).toBe('en-US');
    expect(field(page, 'fp-save').disabled).toBe(true);
    await field(page, 'account-list').children.find((row) => row.dataset.accountId === '2')!.trigger('click');
    expect(field(page, 'fp-locale').value).toBe('de-DE');
  });

  it('clears dirty state only when fields match the original fingerprint baseline', async () => {
    const page = await fixture(() => response({ accounts: [fpAccount] }));
    await change(page, 'fp-locale', 'zh-CN');
    expect(field(page, 'fp-save').disabled).toBe(false);
    await change(page, 'fp-locale', '');
    expect(field(page, 'fp-save').disabled).toBe(true);
    expect(field(page, 'fp-discard').disabled).toBe(true);
  });

  it('keeps a later Muse target and renders the saved fingerprint when selfcheck save completes', async () => {
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => { finish = resolve; });
    const page = await fixture((url, options) => {
      if (url === '/api/session') return response({ url: 'http://localhost:8788/__muse/launch', token: 'launch' });
      if (options.method === 'PATCH') return pending;
      return response({ accounts: [fpAccount] });
    });
    await field(page, 'fp-check').trigger('click');
    await change(page, 'fp-locale', 'zh-cn');
    const saving = field(page, 'fp-form').trigger('submit');
    await page.flush();
    // A newer launch supersedes the pending operation's saved launch generation.
    await field(page, 'launch-button').trigger('click');
    finish(await response({ account: { ...fpAccount, version: 2, fp: { ...fp, locale: 'zh-CN' } } }));
    await saving;
    const sessions = page.calls.filter((call) => call.url === '/api/session');
    expect(sessions).toHaveLength(2);
    expect(JSON.parse(String(sessions[1]!.options.body))).toEqual({ accountId: 1 });
    expect(field(page, 'fp-locale').value).toBe('zh-CN');
    expect(field(page, 'fp-save').disabled).toBe(true);
  });

  it('does not show a late generated seed on another account or relaunch it', async () => {
    const other = { ...fpAccount, id: 2, name: 'Other', fp: { ...fp, seed: 222 } };
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => { finish = resolve; });
    const page = await fixture((url) => {
      if (url.endsWith('/fingerprint/generate')) return pending;
      if (url === '/api/accounts/2/select') return response({ account: other });
      return response({ accounts: [fpAccount, other] });
    });
    await change(page, 'fp-mode', 'android');
    const generating = field(page, 'fp-generate').trigger('click');
    await page.flush();
    expect(field(page, 'fp-form').attributes['aria-busy']).toBe('true');
    await field(page, 'account-list').children.find((row) => row.dataset.accountId === '2')!.trigger('click');
    await change(page, 'fp-locale', 'de-DE');
    finish(await response({ account: { ...fpAccount, version: 2, fp: { ...fp, seed: 999, uaMode: 'android' } } }));
    await generating;
    expect(field(page, 'fp-seed').value).toBe('222');
    expect(field(page, 'fp-locale').value).toBe('de-DE');
    expect(field(page, 'fp-save').disabled).toBe(false);
    expect(page.calls.some((call) => call.url === '/api/session')).toBe(false);
  });

  it('cancels saving an open account before writing or reopening', async () => {
    const page = await fixture((url) => response(url === '/api/session' ? { url: 'http://localhost:8788/__muse/launch', token: 'launch' } : { accounts: [fpAccount] }), 'secret', false, () => false);
    await field(page, 'launch-button').trigger('click');
    await change(page, 'fp-locale', 'zh-CN');
    await field(page, 'fp-form').trigger('submit');
    expect(page.calls.filter((call) => call.options.method === 'PATCH')).toHaveLength(0);
    expect(page.submitted).toHaveLength(1);
    expect(field(page, 'fp-locale').value).toBe('zh-CN');
  });

  it('defaults new fingerprint policies to native and keeps them in the saved schema', async () => {
    const page = await fixture((url, options) => options.method === 'PATCH'
      ? response({ account: { ...fpAccount, version: 2, fp: { ...fp, tlsProfile: 'chrome142', workerMode: 'profile', fontMode: 'standard', webgpuMode: 'disabled' } } })
      : response({ accounts: [fpAccount] }));
    for (const id of ['fp-tls', 'fp-worker', 'fp-font', 'fp-webgpu']) expect(field(page, id).value).toBe('native');
    await change(page, 'fp-tls', 'chrome142');
    await change(page, 'fp-worker', 'profile');
    await change(page, 'fp-font', 'standard');
    await change(page, 'fp-webgpu', 'disabled');
    await field(page, 'fp-form').trigger('submit');
    const patch = page.calls.find((call) => call.options.method === 'PATCH')!;
    expect(new Headers(patch.options.headers).get('If-Match')).toBe('1');
    expect(JSON.parse(String(patch.options.body))).toMatchObject({ fp: { tlsProfile: 'chrome142', workerMode: 'profile', fontMode: 'standard', webgpuMode: 'disabled' } });
    expect(field(page, 'fp-tls').value).toBe('chrome142');
    expect(field(page, 'fp-save').disabled).toBe(true);
  });

  it.each(['fp-tls', 'fp-worker', 'fp-font', 'fp-webgpu'])('rejects unsupported %s policies before a request', async (id) => {
    const page = await fixture(() => response({ accounts: [fpAccount] }));
    await change(page, id, 'invalid');
    await field(page, 'fp-form').trigger('submit');
    expect(page.calls.filter((call) => call.options.method === 'PATCH')).toHaveLength(0);
    expect(field(page, id).attributes['aria-invalid']).toBe('true');
    expect(field(page, 'fp-advanced').open).toBe(true);
  });

  it('retains saved policies after generation and renders native policies after reset', async () => {
    const policies = { tlsProfile: 'chrome131', workerMode: 'profile', fontMode: 'standard', webgpuMode: 'disabled' };
    const page = await fixture((url, options) => {
      if (url.endsWith('/fingerprint/generate')) return response({ account: { ...fpAccount, version: 2, fp: { ...fp, ...policies, uaMode: 'windows', seed: 999 } } });
      if (options.method === 'PATCH') return response({ account: { ...fpAccount, version: 3 } });
      return response({ accounts: [{ ...fpAccount, fp: { ...fp, ...policies } }] });
    });
    await change(page, 'fp-mode', 'windows');
    await field(page, 'fp-generate').trigger('click');
    expect(field(page, 'fp-tls').value).toBe('chrome131');
    expect(field(page, 'fp-worker').value).toBe('profile');
    expect(field(page, 'fp-font').value).toBe('standard');
    expect(field(page, 'fp-webgpu').value).toBe('disabled');
    await field(page, 'fp-reset').trigger('click');
    for (const id of ['fp-tls', 'fp-worker', 'fp-font', 'fp-webgpu']) expect(field(page, id).value).toBe('native');
  });

  it('defaults session maintenance to opt-in without waking VMs or starting a timer', async () => {
    const page = await fixture((url) => response(url.endsWith('/session') ? { status: { state: 'disabled' } } : { accounts: [account] }));
    expect(field(page, 'session-enabled').checked).toBe(false);
    expect(field(page, 'session-wake').checked).toBe(false);
    expect(field(page, 'session-interval').value).toBe('360');
    expect(field(page, 'session-save').disabled).toBe(true);
    expect(field(page, 'session-state').textContent).toBe('已停用');
    expect(field(page, 'session-cookie-expiry').textContent).toBe('未提供到期时间');
    expect(page.calls.filter((call) => call.url.endsWith('/session/check'))).toHaveLength(0);
    expect(page.timers).toHaveLength(0);
    await change(page, 'session-enabled', true);
    expect(field(page, 'session-wake').checked).toBe(false);
  });

  it('saves only keepAlive with If-Match while preserving account and fingerprint drafts', async () => {
    const keepAlive = { enabled: true, intervalMinutes: 60, wakeVm: false };
    const page = await fixture((url, options) => {
      if (options.method === 'PATCH') return response({ account: { ...fpAccount, version: 2, keepAlive } });
      if (url.endsWith('/session')) return response({ status: { state: 'unknown' } });
      return response({ accounts: [fpAccount] });
    });
    await change(page, 'name-input', 'Local name');
    await change(page, 'fp-worker', 'profile');
    await change(page, 'session-enabled', true);
    await change(page, 'session-interval', '60');
    await field(page, 'session-form').trigger('submit');
    const patch = page.calls.find((call) => call.options.method === 'PATCH')!;
    expect(patch.url).toBe('/api/accounts/1');
    expect(new Headers(patch.options.headers).get('If-Match')).toBe('1');
    expect(JSON.parse(String(patch.options.body))).toEqual({ keepAlive });
    expect(field(page, 'session-save').disabled).toBe(true);
    expect(field(page, 'session-wake').checked).toBe(false);
    expect(field(page, 'name-input').value).toBe('Local name');
    expect(field(page, 'fp-worker').value).toBe('profile');
    expect(field(page, 'fp-save').disabled).toBe(false);
  });

  it.each(['', '29', '1441', '60.5', 'Infinity', '-30', 'not a number'])('rejects invalid maintenance interval %s without PATCH', async (value) => {
    const page = await fixture((url) => response(url.endsWith('/session') ? { status: { state: 'disabled' } } : { accounts: [account] }));
    await change(page, 'session-enabled', true);
    await change(page, 'session-interval', value);
    await field(page, 'session-form').trigger('submit');
    expect(page.calls.filter((call) => call.options.method === 'PATCH')).toHaveLength(0);
    expect(field(page, 'session-interval').attributes['aria-invalid']).toBe('true');
    expect(field(page, 'session-status').textContent).toContain('30');
  });

  it.each([30, 1440])('accepts maintenance boundary %i and explicit VM wake preference', async (intervalMinutes) => {
    const keepAlive = { enabled: true, intervalMinutes, wakeVm: true };
    const page = await fixture((url, options) => {
      if (options.method === 'PATCH') return response({ account: { ...account, version: 2, keepAlive } });
      return response(url.endsWith('/session') ? { status: { state: 'disabled' } } : { accounts: [account] });
    });
    await change(page, 'session-enabled', true);
    await change(page, 'session-interval', String(intervalMinutes));
    await change(page, 'session-wake', true);
    await field(page, 'session-form').trigger('submit');
    expect(JSON.parse(String(page.calls.find((call) => call.options.method === 'PATCH')!.options.body))).toEqual({ keepAlive });
  });

  it('keeps independent maintenance drafts on SSE and preserves the original version on conflict', async () => {
    let reads = 0;
    const page = await fixture((url, options) => {
      if (options.method === 'PATCH') return response({ error: 'sensitive server failure' }, 409);
      if (url.endsWith('/session')) return response({ status: { state: 'healthy' } });
      return response({ accounts: [++reads === 1 ? account : { ...account, version: 2, keepAlive: { enabled: true, intervalMinutes: 120, wakeVm: true } }] });
    });
    await change(page, 'session-interval', '60');
    page.eventStream?.enqueue(new TextEncoder().encode('data: {"type":"session"}\n\n'));
    await page.flush();
    expect(field(page, 'session-interval').value).toBe('60');
    expect(field(page, 'session-enabled').checked).toBe(false);
    expect(field(page, 'session-wake').checked).toBe(false);
    await field(page, 'session-form').trigger('submit');
    expect(new Headers(page.calls.find((call) => call.options.method === 'PATCH')!.options.headers).get('If-Match')).toBe('1');
    expect(field(page, 'session-status').textContent).toContain('冲突');
    expect(field(page, 'session-status').textContent).not.toContain('sensitive');
    await field(page, 'session-discard').trigger('click');
    expect(field(page, 'session-interval').value).toBe('120');
    expect(field(page, 'session-wake').checked).toBe(true);
    expect(field(page, 'session-save').disabled).toBe(true);
  });

  it('clears maintenance dirty state only when the original baseline is restored', async () => {
    const page = await fixture((url) => response(url.endsWith('/session') ? { status: { state: 'disabled' } } : { accounts: [account] }));
    await change(page, 'session-interval', '60');
    expect(field(page, 'session-save').disabled).toBe(false);
    await change(page, 'session-interval', '360');
    expect(field(page, 'session-save').disabled).toBe(true);
    expect(field(page, 'session-discard').disabled).toBe(true);
  });

  it.each([
    ['healthy', '会话有效'], ['auth_expired', '需要登录'], ['blocked', '访问受限'],
    ['error', '检查失败'], ['disabled', '已停用'], ['unknown', '尚未确认'], ['checking', '正在检查'],
  ])('maps %s without exposing upstream text or removing the admin token', async (state, label) => {
    const page = await fixture((url) => response(url.endsWith('/session') ? { status: { state, error: 'secret-cookie-value' } } : { accounts: [account] }));
    expect(field(page, 'session-state').textContent).toBe(label);
    expect(field(page, 'session-check-status').textContent).not.toContain('secret-cookie-value');
    expect(page.storage.get('muse.accessToken')).toBe('secret');
    expect(field(page, 'token-dialog').open).toBe(false);
    if (state === 'auth_expired') expect(field(page, 'session-check-status').textContent).toContain('打开 Muse');
    if (state === 'blocked') expect(field(page, 'session-check-status').textContent).toContain('不代表退出登录');
  });

  it.each([
    ['RUNNING', '运行中'], ['SLEEPING', '休眠'], ['STOPPED', '已停止'], ['SUSPENDED', '已挂起'],
    ['STARTING', '启动中'], ['STOPPING', '停止中'], ['DISABLED', '已停用'], ['PENDING', '准备中'],
    ['UNKNOWN', '未知'], ['running', '运行中'], ['unexpected-secret-value', '未知'],
  ])('renders engine VM state %s as a recognized Chinese label', async (vmState, label) => {
    const page = await fixture((url) => response(url.endsWith('/session') ? { status: { state: 'healthy', vmState } } : { accounts: [account] }));
    expect(field(page, 'session-vm-state').textContent).toBe(label);
    expect(field(page, 'session-state').textContent).toBe('会话有效');
  });

  it('normalizes wrapped and plain session status and displays real server timestamps only', async () => {
    const stamp = Date.parse('2026-11-17T00:00:00.000Z');
    const page = await fixture((url) => {
      if (url.endsWith('/session/check')) return response({ state: 'healthy', lastCheck: stamp, lastSuccess: stamp, nextCheck: Date.parse('2026-11-17T06:00:00.000Z'), cookieExpiresAt: Date.parse('2026-11-18T02:00:00.000Z'), vmState: 'sleeping' });
      return response(url.endsWith('/session') ? { status: { state: 'unknown' } } : { accounts: [account] });
    });
    await field(page, 'session-check').trigger('click');
    const check = page.calls.find((call) => call.url.endsWith('/session/check'))!;
    expect(check.options.method).toBe('POST');
    expect(check.options.body).toBeUndefined();
    expect(field(page, 'session-state').textContent).toBe('会话有效');
    expect(field(page, 'session-last-check').textContent).toBe(new Date(stamp).toLocaleString('zh-CN'));
    expect(field(page, 'session-last-success').textContent).toBe(new Date(stamp).toLocaleString('zh-CN'));
    expect(field(page, 'session-next-check').textContent).toBe(new Date('2026-11-17T06:00:00.000Z').toLocaleString('zh-CN'));
    expect(field(page, 'session-cookie-expiry').textContent).toBe(new Date('2026-11-18T02:00:00.000Z').toLocaleString('zh-CN'));
    expect(field(page, 'session-vm-state').textContent).toBe('休眠');
    expect(page.timers).toHaveLength(0);
  });

  it.each([401, 403, 500])('handles check API HTTP%i without echoing sensitive errors', async (status) => {
    const page = await fixture((url) => {
      if (url.endsWith('/session/check')) return response({ error: 'Authorization: Bearer secret-cookie-value' }, status);
      return response(url.endsWith('/session') ? { status: { state: 'unknown' } } : { accounts: [account] });
    });
    await field(page, 'session-check').trigger('click');
    expect(page.storage.has('muse.accessToken')).toBe(status !== 401);
    expect(field(page, 'token-dialog').open).toBe(status === 401);
    expect(field(page, 'session-check-status').textContent).not.toContain('secret-cookie-value');
    expect(field(page, 'session-check').disabled).toBe(false);
  });

  it('deduplicates manual checks and ignores a previous GET that finishes after the check', async () => {
    let resolveRead!: (value: unknown) => void;
    let resolveCheck!: (value: unknown) => void;
    const reading = new Promise((resolve) => { resolveRead = resolve; });
    const checking = new Promise((resolve) => { resolveCheck = resolve; });
    const page = await fixture((url) => url.endsWith('/session/check') ? checking : url.endsWith('/session') ? reading : response({ accounts: [account] }));
    const pending = field(page, 'session-check').trigger('click');
    await page.flush();
    expect(field(page, 'session-state').textContent).toBe('正在检查');
    expect(field(page, 'session-check').disabled).toBe(true);
    await field(page, 'session-check').trigger('click');
    expect(page.calls.filter((call) => call.url.endsWith('/session/check'))).toHaveLength(1);
    resolveCheck(await response({ status: { state: 'healthy' } }));
    await pending;
    resolveRead(await response({ status: { state: 'auth_expired' } }));
    await page.flush();
    expect(field(page, 'session-state').textContent).toBe('会话有效');
    expect(field(page, 'session-check').disabled).toBe(false);
  });

  it.each(['read', 'check', 'save'])('ignores delayed session %s for A after switching to B', async (action) => {
    const other = { ...account, id: 2, name: 'Other' };
    let finish!: (value: unknown) => void;
    const delayed = new Promise((resolve) => { finish = resolve; });
    const page = await fixture((url, options) => {
      if (url === '/api/accounts/1/session' && action === 'read') return delayed;
      if (url === '/api/accounts/1/session/check' && action === 'check') return delayed;
      if (options.method === 'PATCH') return delayed;
      if (url.endsWith('/session')) return response({ status: { state: 'unknown' } });
      if (url.endsWith('/select')) return response({ account: other });
      return response({ accounts: [account, other] });
    });
    let pending: Promise<void> | undefined;
    if (action === 'check') pending = field(page, 'session-check').trigger('click');
    if (action === 'save') {
      await change(page, 'session-interval', '60');
      pending = field(page, 'session-form').trigger('submit');
    }
    await page.flush();
    await field(page, 'account-list').children.find((row) => row.dataset.accountId === '2')!.trigger('click');
    await change(page, 'session-interval', '120');
    finish(await response(action === 'save' ? { account: { ...account, version: 2, keepAlive: { enabled: true, intervalMinutes: 60, wakeVm: true } } } : { status: { state: 'auth_expired' } }));
    await pending;
    await page.flush();
    expect(field(page, 'account-title').textContent).toBe('Other');
    expect(field(page, 'session-interval').value).toBe('120');
    expect(field(page, 'session-state').textContent).toBe('尚未确认');
    expect(field(page, 'session-save').disabled).toBe(false);
  });

  it.each(['export', 'import'])('clears an expired token when backup %s returns 401', async (action) => {
    const page = await fixture((url) => url.includes('/api/backup') ? response({ error: 'Authentication required' }, 401) : response({ accounts: [account] }));
    if (action === 'export') await page.elements.get('export-button')?.trigger('click');
    else {
      page.elements.get('import-mode')!.value = 'merge';
      page.elements.get('backup-file')!.files = [{ text: async () => '{"schema":1}' }];
      await page.elements.get('backup-file')?.trigger('change');
    }
    expect(page.calls.some((call) => call.url.startsWith(`/api/backup/${action}`))).toBe(true);
    expect(page.storage.has('muse.accessToken')).toBe(false);
    expect(page.elements.get('token-dialog')?.open).toBe(true);
  });

  it('clears rejected tokens and reopens the password prompt', async () => {
    const page = await fixture(() => response({ error: 'Authentication required' }, 401));
    expect(page.storage.has('muse.accessToken')).toBe(false);
    expect(page.elements.get('token-dialog')?.open).toBe(true);
  });
});
