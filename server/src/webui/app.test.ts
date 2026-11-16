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
async function fixture(handler: (url: string, options: RequestInit) => Promise<unknown>, savedToken = 'secret', offline = false) {
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
    window: { setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimeout() {}, confirm: () => true, prompt: () => 'New account' },
    location: { reload() {} }, fetch, Headers, AbortController, TextDecoder, URL, ReadableStream, console,
  });
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  await flush();
  return { elements, calls, submitted, storage, timers, flush, get eventStream() { return eventStream; } };
}
const response = (body: unknown, status = 200) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
const account = { id: 1, name: 'Work', group: '', tags: [], proxy: '', proxyPool: [], version: 1, avatar: 'm' };

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
