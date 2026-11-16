import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as httpServer } from 'node:http';
import { connect } from 'node:net';
import { createServer } from './server.js';
import type { FastifyInstance } from 'fastify';

const disposals: (() => Promise<unknown>)[] = [];
afterEach(async () => { while (disposals.length) await disposals.pop()?.(); });
const token = 'integration-secret-12345678901234567890';
const auth = { authorization: `Bearer ${token}` };
async function setup(upstreamOrigin = 'http://127.0.0.1:9999', gatewayPort = 20780, publicPort?: number) {
  const dataDir = await mkdtemp(join(tmpdir(), 'muse-integration-'));
  disposals.push(() => rm(dataDir, { recursive: true, force: true }));
  const app = await createServer({ config: { bind: '127.0.0.1', port: 20779, accessToken: token, upstreamOrigin, dataDir, mode: 'development' }, logger: false, gatewayPort, publicHost: '127.0.0.1', ...(publicPort ? { publicPort } : {}) });
  disposals.push(() => app.close());
  return app;
}
async function account(app: FastifyInstance, name: string) {
  const r = await app.inject({ method: 'POST', url: '/api/accounts', headers: auth, payload: { name } });
  expect(r.statusCode).toBe(201);
  return r.json().account.id as number;
}
async function launch(app: FastifyInstance, id: number) {
  const r = await app.inject({ method: 'POST', url: '/api/session', headers: auth, payload: { accountId: id } });
  expect(r.statusCode).toBe(201);
  const response = await fetch(r.json().url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: r.json().token }), redirect: 'manual' });
  expect(response.status).toBe(302);
  return { origin: new URL(r.json().url).origin, cookie: response.headers.get('set-cookie')!.split(';')[0]! };
}

describe('server integration', () => {
  it('fails readiness when an account port is occupied instead of reporting healthy', async () => {
    const blocker = httpServer();
    await new Promise<void>(resolve => blocker.listen(20980, '127.0.0.1', resolve));
    disposals.push(() => new Promise<void>(resolve => blocker.close(() => resolve())));
    const app = await setup('http://127.0.0.1:9999', 20980);
    await expect(app.ready()).rejects.toThrow();
  });

  it('wires management assets, bearer API and account gateways', async () => {
    const app = await setup();
    await app.listen({ host: '127.0.0.1', port: 0 });
    expect((await app.inject('/')).headers['content-type']).toContain('text/html');
    expect((await app.inject('/api/accounts')).statusCode).toBe(401);
    const opened = await launch(app, await account(app, 'First'));
    expect(opened.cookie).toMatch(/^muse_session_1=/);
    expect((await fetch(opened.origin)).status).toBe(401);
    expect((await app.inject({ url: '/api/accounts', headers: { cookie: opened.cookie } })).statusCode).toBe(401);
  });

  it('does not let a partial authenticated request body lock other requests', async () => {
    const app = await setup();
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const socket = connect(port, '127.0.0.1');
    disposals.push(async () => { socket.destroy(); });
    await new Promise<void>(resolve => socket.once('connect', resolve));
    socket.write(`POST /api/accounts HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"name":"partial`);
    const response = await fetch(url + '/api/accounts', { headers: auth, signal: AbortSignal.timeout(1500) });
    expect(response.status).toBe(200);
  });

  it('uses the published management port for browser launch Origin validation', async () => {
    const app = await setup('http://127.0.0.1:9999', 20780, 9877);
    const id = await account(app, 'External port');
    const r = await app.inject({ method: 'POST', url: '/api/session', headers: auth, payload: { accountId: id } });
    const response = await fetch(r.json().url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://127.0.0.1:9877' }, body: new URLSearchParams({ token: r.json().token }), redirect: 'manual' });
    expect(response.status).toBe(302);
  });

  it('persists isolated upstream cookies and streams SSE through distinct origins', async () => {
    const upstream = httpServer((req, res) => {
      if (req.url === '/login') { res.setHeader('Set-Cookie', 'hatch_sess=fixture-session; HttpOnly; Path=/'); res.end('logged'); }
      else if (req.url === '/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: first\n\n'); setTimeout(() => res.end('data: last\n\n'), 50); }
      else { res.setHeader('Content-Type', 'text/plain'); res.end(req.headers.cookie ?? ''); }
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    disposals.push(() => new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections(); }));
    const app = await setup('http://127.0.0.1:' + (upstream.address() as { port: number }).port, 20880);
    const a = await launch(app, await account(app, 'A'));
    const b = await launch(app, await account(app, 'B'));
    expect(a.origin).not.toBe(b.origin);
    expect(await (await fetch(a.origin + '/login', { headers: { cookie: a.cookie } })).text()).toBe('logged');
    expect(await (await fetch(a.origin + '/echo', { headers: { cookie: a.cookie } })).text()).toContain('hatch_sess=');
    expect(await (await fetch(b.origin + '/echo', { headers: { cookie: b.cookie } })).text()).toBe('');
    expect(await (await fetch(a.origin + '/events', { headers: { cookie: a.cookie } })).text()).toContain('data: last');
    expect((await app.inject({ url: '/api/accounts/1/status', headers: auth })).json().status.logged).toBe(true);
    await app.inject({ method: 'POST', url: '/api/accounts/1/cookies/clear', headers: auth });
    expect((await fetch(a.origin, { headers: { cookie: a.cookie } })).status).toBe(401);
  });

  it('exports and restores a complete backup through protected routes', async () => {
    const app = await setup();
    const id = await account(app, 'Backup');
    const exported = await app.inject({ url: '/api/backup/export', headers: auth });
    expect(exported.statusCode).toBe(200);
    expect(exported.json().accounts[0].id).toBe(id);
    expect((await app.inject({ method: 'DELETE', url: '/api/accounts/' + id, headers: auth })).statusCode).toBe(204);
    const imported = await app.inject({ method: 'POST', url: '/api/backup/import?mode=replace', headers: auth, payload: exported.json() });
    expect(imported.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/accounts', headers: auth })).json().accounts[0].name).toBe('Backup');
  });
});
