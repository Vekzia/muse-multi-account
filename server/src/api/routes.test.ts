import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountStore } from '../storage/account-store.js';
import { AccountCookieJar } from '../proxy/cookie-jar.js';
import { AccountSessionManager } from '../auth/token-auth.js';
import { registerApi, type ApiDependencies } from './routes.js';

const token = 'PRIVATE_ACCESS_TOKEN';
const headers = { authorization: `Bearer ${token}` };
const apps: FastifyInstance[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function setup(extra: Partial<ApiDependencies> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'muse-api-')); directories.push(dir);
  const accounts = new AccountStore(dir);
  const sessions = new AccountSessionManager();
  const logs: string[] = [];
  const app = Fastify({ logger: { stream: { write: (line: string) => { logs.push(line); } } } });
  apps.push(app);
  registerApi(app, { accounts, accessToken: token, sessions, ...extra });
  return { app, accounts, sessions, logs, dir };
}

describe('encoded API paths', () => {
  it.each(['/%61pi', '/a%70i', '/%61%70%69'])('authenticates matched and unknown encoded API routes: %s', async (prefix) => {
    const { app, accounts } = await setup({ launchAccount: async () => ({ url: 'http://localhost/launch', token: 'private' }) });
    const account = accounts.create({ name: 'unchanged' });
    expect((await app.inject({ method: 'POST', url: `${prefix}/accounts/${account.id}/fingerprint/generate`, payload: { mode: 'windows' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `${prefix}/session`, payload: { accountId: account.id } })).statusCode).toBe(401);
    expect((await app.inject({ url: `${prefix}/unknown` })).statusCode).toBe(401);
    expect(accounts.get(account.id)).toEqual(account);
  });

  it.each([{ enabled: 'true' }, { screenWidth: '1080' }, { script: 'alert(1)' }])('validates raw fingerprint data on decoded matched routes: %j', async (fp) => {
    const { app, accounts } = await setup();
    const account = accounts.create({ name: 'unchanged' });
    expect((await app.inject({ method: 'PATCH', url: `/api/%61ccounts/${account.id}`, headers, payload: { fp } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/%61ccounts', headers, payload: { name: 'new', fp } })).statusCode).toBe(400);
    expect(accounts.list()).toEqual([account]);
    expect((await app.inject({ method: 'POST', url: `/api/accounts/${account.id}/fingerprint/%67enerate`, headers, payload: { mode: 'windows', script: 'bad' } })).statusCode).toBe(400);
    expect(accounts.get(account.id)).toEqual(account);
  });
});

describe('fingerprint API', () => {
  it('creates and patches a complete fingerprint, deep-merges fields, and resets native without rotating seed', async () => {
    const { app } = await setup();
    const created = await app.inject({ method: 'POST', url: '/api/accounts', headers, payload: { name: 'profile', fp: { enabled: true, uaMode: 'custom', uaCustom: 'Browser/1', locale: 'zh-cn', screenWidth: 1920 } } });
    expect(created.statusCode).toBe(201);
    const account = created.json().account;
    expect(account.fp).toMatchObject({ enabled: true, uaCustom: 'Browser/1', locale: 'zh-CN', screenWidth: 1920 });
    expect(account.fp.seed).toBeGreaterThan(0);
    const patched = await app.inject({ method: 'PATCH', url: `/api/accounts/${account.id}`, headers: { ...headers, 'if-match': '1' }, payload: { fp: { timezone: 'Asia/Shanghai', audioNoise: true } } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().account.fp).toMatchObject({ ...account.fp, timezone: 'Asia/Shanghai', audioNoise: true });
    const reset = await app.inject({ method: 'PATCH', url: `/api/accounts/${account.id}`, headers, payload: { fp: null } });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().account.fp).toMatchObject({ enabled: false, seed: account.fp.seed, uaMode: 'system', timezone: '', audioNoise: false });
  });

  it.each([{ enabled: 'true' }, { screenWidth: '1080' }, { enabled: null }, { timezone: 'Invalid/Zone' }, { locale: 'en_US' }, { uaCustom: 'Browser\r\nX: yes' }, { pixelRatio: 20 }, { deviceMemory: 3 }, { seed: 0 }, { script: 'alert(1)' }])('rejects invalid typed fingerprint request before coercion or mutation: %j', async (fp) => {
    const { app, accounts } = await setup();
    const account = accounts.create({ name: 'original' });
    const response = await app.inject({ method: 'PATCH', url: `/api/accounts/${account.id}`, headers, payload: { name: 'changed', fp } });
    expect(response.statusCode).toBe(400);
    expect(accounts.get(account.id)).toEqual(account);
  });

  it('generates a fresh persisted profile with If-Match while keeping cookies and sessions', async () => {
    const { app, accounts, sessions, dir } = await setup();
    const account = accounts.create({ name: 'original', logged: true, proxy: 'http://PRIVATE_USER:PRIVATE_PASS@proxy.example:80' });
    const jars = new AccountCookieJar(dir);
    const jar = await jars.get(account.id);
    await jar.setCookie('sid=original; Path=/', 'https://example.com/');
    await jars.save(account.id, jar);
    const launch = sessions.issueLaunch(account.id);
    const url = `/api/accounts/${account.id}/fingerprint/generate`;
    expect((await app.inject({ method: 'POST', url, payload: { mode: 'windows' } })).statusCode).toBe(401);
    const response = await app.inject({ method: 'POST', url, headers: { ...headers, 'if-match': '"1"' }, payload: { mode: 'windows' } });
    expect(response.statusCode).toBe(200);
    const generated = response.json().account;
    expect(generated).toMatchObject({ name: 'original', logged: true, version: 2, fp: { enabled: true, uaMode: 'windows', platform: 'Win32' } });
    expect(generated.fp.seed).not.toBe(account.fp.seed);
    expect(response.body).not.toContain('PRIVATE_');
    expect(accounts.get(account.id)?.fp).toEqual(generated.fp);
    expect(new AccountStore(dir).get(account.id)?.fp).toEqual(generated.fp);
    expect(await (await new AccountCookieJar(dir).get(account.id)).getCookieString('https://example.com/')).toBe('sid=original');
    expect(sessions.consumeLaunch(launch.token, account.id)).toBe(true);
    expect((await app.inject({ method: 'POST', url, headers: { ...headers, 'if-match': '1' }, payload: { mode: 'macos' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url, headers, payload: { mode: 'system' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url, headers, payload: { mode: 'android', script: 'bad' } })).statusCode).toBe(400);
    expect(accounts.get(account.id)?.fp).toEqual(generated.fp);
  });

  it('publishes a change event for regenerated fingerprints on the authenticated SSE stream', async () => {
    const { app, accounts } = await setup();
    const account = accounts.create({ name: 'events' });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('API did not bind');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/events`, { headers });
    const reader = response.body!.getReader();
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('connected');
      const generated = await app.inject({ method: 'POST', url: `/api/accounts/${account.id}/fingerprint/generate`, headers, payload: { mode: 'android' } });
      expect(generated.statusCode).toBe(200);
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(`\"accountId\":${account.id}`);
    } finally { await reader.cancel(); }
  });

  it('dispatches authenticated fingerprint diagnostics through the existing session flow', async () => {
    const { app, accounts } = await setup({ launchAccount: async (id, target = 'muse') => ({ url: `http://localhost/${id}/${target}`, token: 'launch' }) });
    const account = accounts.create({ name: 'diagnostic' });
    for (const target of [undefined, 'fingerprint']) {
      const response = await app.inject({ method: 'POST', url: '/api/session', headers, payload: { accountId: account.id, ...(target ? { target } : {}) } });
      expect(response.statusCode).toBe(201);
      expect(response.json().url).toBe(`http://localhost/${account.id}/${target ?? 'muse'}`);
    }
    expect((await app.inject({ method: 'POST', url: '/api/session', headers, payload: { accountId: account.id, target: 'https://elsewhere.example/' } })).statusCode).toBe(400);
  });
});

describe('authenticated API', () => {
  it('leaves health public but authenticates all other API paths before body validation', async () => {
    const { app } = await setup();
    expect((await app.inject('/api/health')).statusCode).toBe(200);
    for (const authorization of [undefined, 'Bearer wrong', 'Basic PRIVATE_ACCESS_TOKEN']) {
      const response = await app.inject({ url: '/api/accounts', headers: authorization ? { authorization } : {} });
      expect(response.statusCode).toBe(401);
      expect(response.headers['www-authenticate']).toBe('Bearer');
    }
    expect((await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'a' } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/unknown' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/accounts', headers })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/accounts?token=PRIVATE_ACCESS_TOKEN' })).statusCode).toBe(401);
  });

  it('creates, reads, updates, selects and removes accounts with optimistic concurrency', async () => {
    const { app, accounts } = await setup();
    const created = await app.inject({ method: 'POST', url: '/api/accounts', headers, payload: { name: 'Alpha', group: 'Work', tags: ['one'], pinned: true } });
    expect(created.statusCode).toBe(201);
    const account = created.json().account;
    expect(account).toMatchObject({ name: 'Alpha', group: 'Work', version: 1 });
    const updated = await app.inject({ method: 'PATCH', url: `/api/accounts/${account.id}`, headers: { ...headers, 'if-match': '"1"' }, payload: { name: 'Beta' } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().account).toMatchObject({ name: 'Beta', version: 2 });
    expect((await app.inject({ method: 'PATCH', url: `/api/accounts/${account.id}`, headers: { ...headers, 'if-match': '1' }, payload: { name: 'Stale' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/accounts/${account.id}/select`, headers })).statusCode).toBe(200);
    expect(accounts.getCurrent()?.id).toBe(account.id);
    expect((await app.inject({ method: 'DELETE', url: `/api/accounts/${account.id}`, headers })).statusCode).toBe(204);
    expect((await app.inject({ url: `/api/accounts/${account.id}`, headers })).statusCode).toBe(404);
  });

  it('passes group, query and sort filters to the real account store', async () => {
    const { app, accounts } = await setup();
    accounts.create({ name: 'Zulu', group: 'Work' });
    accounts.create({ name: 'Alpha', group: 'Work' });
    accounts.create({ name: 'Other', group: 'Personal' });
    const result = await app.inject({ url: '/api/accounts?group=Work&sort=name', headers });
    expect(result.json().accounts.map((a: { name: string }) => a.name)).toEqual(['Alpha', 'Zulu']);
    expect((await app.inject({ url: '/api/accounts?query=alpha', headers })).json().accounts).toHaveLength(1);
    expect((await app.inject({ url: '/api/accounts?sort=invalid', headers })).statusCode).toBe(400);
  });

  it('rejects malformed ids, payloads and If-Match without reflecting private input', async () => {
    const { app } = await setup();
    expect((await app.inject({ url: '/api/accounts/-1', headers })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/accounts', headers, payload: { name: '', unexpected: token } })).statusCode).toBe(400);
    const response = await app.inject({ method: 'PATCH', url: '/api/accounts/1', headers: { ...headers, 'if-match': token }, payload: { name: 'x' } });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(token);
  });

  it('redacts account proxy credentials from responses and request logs', async () => {
    const { app, logs } = await setup();
    const response = await app.inject({ method: 'POST', url: '/api/accounts', headers, payload: { name: 'Private', proxy: 'http://PRIVATE_USER:PRIVATE_PASSWORD@proxy.example:8080', proxyPool: ['http://PRIVATE_USER:PRIVATE_PASSWORD@pool.example:8080'] } });
    expect(response.statusCode).toBe(201);
    expect(response.json().account.proxy).toContain('***:***@');
    expect(response.body).not.toContain('PRIVATE_');
    expect(logs.join('')).not.toContain('PRIVATE_');
  });

  it('returns fixed errors from injected proxy/status/cookie hooks and clears runtime state', async () => {
    let cleared = 0;
    const { app, accounts } = await setup({
      probeProxy: async () => ({ ok: false, latencyMs: 10, error: 'PRIVATE_PASSWORD' }),
      clearCookies: async (id) => { cleared = id; },
      getStatus: async () => ({ logged: true }),
    });
    const account = accounts.create({ name: 'One', proxy: 'http://proxy.example:8080', logged: true });
    const probe = await app.inject({ method: 'POST', url: `/api/accounts/${account.id}/proxy/test`, headers });
    expect(probe.statusCode).toBe(200);
    expect(probe.json()).toMatchObject({ ok: false, latencyMs: 10, error: 'Proxy probe failed' });
    expect((await app.inject({ url: `/api/accounts/${account.id}/status`, headers })).json().status.logged).toBe(true);
    expect((await app.inject({ method: 'POST', url: `/api/accounts/${account.id}/cookies/clear`, headers })).statusCode).toBe(200);
    expect(cleared).toBe(account.id);
    expect(accounts.get(account.id)?.logged).toBe(false);
  });

  it('runs account cleanup hooks before removing the account', async () => {
    let removedId = 0;
    const { app, accounts } = await setup({ deleteAccount: async (id) => { removedId = id; } });
    const account = accounts.create({ name: 'Cleanup' });
    const response = await app.inject({ method: 'DELETE', url: `/api/accounts/${account.id}`, headers });
    expect(response.statusCode).toBe(204);
    expect(removedId).toBe(account.id);
    expect(accounts.get(account.id)).toBeUndefined();
  });

  it('supports protected backup hooks and validates import mode before dispatch', async () => {
    let imported = '';
    const { app } = await setup({ backup: {
      export: async () => Buffer.from('{"schema":1}'),
      import: async (buffer, mode) => { imported = `${mode}:${buffer.toString()}`; return { imported: 1 }; },
    } });
    const exported = await app.inject({ url: '/api/backup/export', headers });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-disposition']).toContain('attachment');
    expect(exported.body).toBe('{"schema":1}');
    const result = await app.inject({ method: 'POST', url: '/api/backup/import?mode=merge', headers, payload: { schema: 1 } });
    expect(result.statusCode).toBe(200);
    expect(imported).toBe('merge:{"schema":1}');
    expect((await app.inject({ method: 'POST', url: '/api/backup/import?mode=wrong', headers, payload: {} })).statusCode).toBe(400);
  });

  it('keeps the authenticated SSE stream open across later account mutations', async () => {
    const { app } = await setup();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('API did not bind');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/events`, { headers });
    expect(response.ok).toBe(true);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('SSE body missing');
    const decoder = new TextDecoder();
    const readChunk = async () => decoder.decode((await reader.read()).value);
    expect(await readChunk()).toContain('connected');
    const mutation = await fetch(`http://127.0.0.1:${address.port}/api/accounts`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Streamed' }) });
    expect(mutation.status).toBe(201);
    expect(await readChunk()).toContain('change');
    await reader.cancel();
    await app.close();
  });

  it('issues account-bound one-time launch URLs only with a bearer token', async () => {
    const sessions = new AccountSessionManager();
    const { app, accounts } = await setup({ sessions, launchAccount: async (id) => ({ url: 'http://localhost:8788/__muse/launch', token: sessions.issueLaunch(id).token }) });
    const account = accounts.create({ name: 'One' });
    const result = await app.inject({ method: 'POST', url: '/api/session', headers, payload: { accountId: account.id } });
    expect(result.statusCode).toBe(201);
    expect(result.headers['cache-control']).toContain('no-store');
    expect(result.json().url).toBe('http://localhost:8788/__muse/launch');
    expect(sessions.consumeLaunch(result.json().token, account.id)).toBe(true);
    expect(sessions.consumeLaunch(result.json().token, account.id)).toBe(false);
    const session = sessions.issueSession(account.id);
    expect((await app.inject({ url: '/api/accounts', headers: { cookie: `muse_session=${session.token}` } })).statusCode).toBe(401);
  });
});
