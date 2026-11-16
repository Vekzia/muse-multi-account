import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { randomInt } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountSessionManager } from '../auth/token-auth.js';
import { AccountGateway, type AccountGatewayProxy } from './account-gateway.js';

const gateways: AccountGateway[] = [];
const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
});

async function freeRange(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const base = randomInt(20_000, 60_000);
    const probes: Server[] = [];
    try {
      for (let offset = 0; offset < 32; offset++) {
        const server = createServer();
        probes.push(server);
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(base + offset, '127.0.0.1', resolve);
        });
      }
      return base;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    } finally {
      await Promise.all(probes.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    }
  }
  throw new Error('No free account port range for fixture');
}

interface Response { status: number; headers: IncomingHttpHeaders; body: string }
function http(port: number, path = '/', options: { method?: string; body?: string; headers?: Record<string, string>; chunked?: boolean } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (options.chunked && options.body) {
      req.write(options.body.slice(0, 1));
      req.write(options.body.slice(1));
      req.end();
    } else req.end(options.body);
  });
}

function upgrade(port: number, cookie?: string, head = '', origin?: string, host = `127.0.0.1:${port}`): Promise<{ response: string; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    sockets.push(socket);
    socket.on('error', reject);
    socket.once('connect', () => socket.write([
      'GET /live?feed=1 HTTP/1.1', `Host: ${host}`, 'Connection: Upgrade', 'Upgrade: websocket',
      ...(cookie ? [`Cookie: ${cookie}`] : []), ...(origin ? [`Origin: ${origin}`] : []), '', head,
    ].join('\r\n')));
    let response = '';
    socket.on('data', (chunk) => {
      response += chunk.toString();
      if (response.includes('\r\n\r\n')) resolve({ response, socket });
    });
  });
}

async function fixture(options: { secure?: boolean; now?: () => number; basePort?: number; proxy?: AccountGatewayProxy; publicHost?: string; managementOrigin?: string } = {}) {
  const basePort = options.basePort ?? await freeRange();
  const session = new AccountSessionManager(options.now ? { now: options.now } : {});
  const accounts = new Map([[1, { id: 1 }], [2, { id: 2 }], [32, { id: 32 }]]);
  const proxy: AccountGatewayProxy = options.proxy ?? {
    async handle(req, reply, context) {
      const chunks: Buffer[] = [];
      if (req.body instanceof Readable) for await (const chunk of req.body) chunks.push(Buffer.from(chunk));
      const body = req.body instanceof Readable ? Buffer.concat(chunks).toString() : Buffer.isBuffer(req.body) ? req.body.toString() : req.body;
      reply.code(200);
      reply.headers({ 'content-type': 'application/json' });
      reply.send(JSON.stringify({
        accountId: context.accountId, localBase: context.localBase, upstreamPath: context.upstreamPath, localOrigin: context.localOrigin, url: req.url,
        body, streamed: req.body instanceof Readable,
        authorization: req.headers.authorization ?? null,
        authenticated: session.verifySession(req.headers.cookie?.toString().split(';').map((value) => value.trim()).find((value) => value.startsWith(`muse_session_${context.accountId}=`))?.split('=')[1], context.accountId),
      }));
    },
    async upgrade(socket, req, head, context) {
      const authenticated = session.verifySession(req.headers.cookie?.split(';').map((value) => value.trim()).find((value) => value.startsWith(`muse_session_${context.accountId}=`))?.split('=')[1], context.accountId);
      (socket as Socket).write([
        'HTTP/1.1 101 Switching Protocols', 'Connection: Upgrade', 'Upgrade: websocket',
        `X-Account: ${context.accountId}`, `X-Authenticated: ${authenticated}`, `X-Head: ${head.toString()}`, '', '',
      ].join('\r\n'));
    },
  };
  const gateway = new AccountGateway({ host: '127.0.0.1', basePort, accessToken: 'management-secret', store: { get: async (id) => accounts.get(id) }, proxy, session, secure: options.secure ?? false,
    ...(options.publicHost ? { publicHost: options.publicHost } : {}), ...(options.managementOrigin ? { managementOrigin: options.managementOrigin } : {}) });
  gateways.push(gateway);
  return { gateway, session, basePort, accounts };
}

async function launch(f: Awaited<ReturnType<typeof fixture>>, id = 1, type = 'application/x-www-form-urlencoded') {
  const { token } = f.session.issueLaunch(id);
  const body = type === 'application/json' ? JSON.stringify({ token }) : new URLSearchParams({ token }).toString();
  return http(f.gateway.portFor(id), '/__muse/launch', { method: 'POST', headers: { 'content-type': type }, body });
}
function cookie(response: Response): string { return response.headers['set-cookie']![0]!.split(';')[0]!; }

describe('AccountGateway', () => {
  it('maps bounded account IDs to deterministic ports without putting launch tokens in URLs', async () => {
    const { gateway } = await fixture({ basePort: 8_788 });
    expect(gateway.portFor(1)).toBe(8_788);
    expect(gateway.portFor(2)).toBe(8_789);
    expect(gateway.portFor(32)).toBe(8_819);
    expect(gateway.launch(2, 'one-time-secret')).toBe('http://127.0.0.1:8789/__muse/launch');
    for (const id of [0, -1, 33, 1.5, NaN, Infinity]) expect(() => gateway.portFor(id)).toThrow();
    expect(() => gateway.launch(33, 'secret')).toThrow();
  });

  it('validates the entire port range and supports bracketed IPv6 launch URLs', () => {
    const options = { host: '::1', accessToken: 'management', store: { get: () => ({ id: 1 }) }, proxy: {} as AccountGatewayProxy, session: new AccountSessionManager() };
    for (const basePort of [0, -1, 65_505, 1.5, NaN]) expect(() => new AccountGateway({ ...options, basePort })).toThrow();
    expect(new AccountGateway({ ...options, basePort: 65_504 }).launch(32, 'secret')).toBe('http://[::1]:65535/__muse/launch');
    expect(new AccountGateway({ ...options, basePort: 64_512, portCount: 1_024 }).portFor(1_024)).toBe(65_535);
    expect(() => new AccountGateway({ ...options, basePort: 64_513, portCount: 1_024 })).toThrow();
  });

  it('supports a smaller configured port range while retaining deterministic mapping', async () => {
    const f = await fixture({ basePort: await freeRange() });
    const small = new AccountGateway({ host: '127.0.0.1', basePort: f.basePort, portCount: 2, accessToken: 'management', store: { get: (id) => ({ id }) }, proxy: {} as AccountGatewayProxy, session: new AccountSessionManager() });
    gateways.push(small);
    await small.start();
    expect(small.portFor(2)).toBe(f.basePort + 1);
    expect(() => small.portFor(3)).toThrow(/between 1 and 2/);
    expect((await http(f.basePort + 1)).status).toBe(401);
    await expect(http(f.basePort + 2)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    for (const portCount of [0, -1, 1.5, 1_025, NaN]) {
      expect(() => new AccountGateway({ host: '127.0.0.1', basePort: f.basePort, portCount, accessToken: 'management', store: { get: () => undefined }, proxy: {} as AccountGatewayProxy, session: new AccountSessionManager() })).toThrow();
    }
  });

  it.each(['application/x-www-form-urlencoded', 'application/json'])('exchanges a one-use %s launch for an account cookie at the root path', async (type) => {
    const f = await fixture();
    await f.gateway.start();
    const token = f.session.issueLaunch(1).token;
    const options = { method: 'POST', headers: { 'content-type': type }, body: type === 'application/json' ? JSON.stringify({ token }) : new URLSearchParams({ token }).toString() };
    const response = await http(f.basePort, '/__muse/launch', options);
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/');
    const value = response.headers['set-cookie']![0]!;
    expect(value).toMatch(/^muse_session_1=/);
    expect(value).toMatch(/; Path=\/;/);
    expect(value).toContain('; HttpOnly');
    expect(value).toContain('; SameSite=Lax');
    expect(value).not.toContain('; Secure');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).not.toContain(token);
    expect((await http(f.basePort, '/__muse/launch', options)).status).toBe(401);
    const page = await http(f.basePort, '/', { headers: { cookie: cookie(response) } });
    expect(page.status).toBe(200);
    expect(JSON.parse(page.body)).toMatchObject({ accountId: 1, localBase: '', url: '/', authorization: null, authenticated: true });
  });

  it('rejects wrong-account and expired launch tokens without consuming the correct account token', async () => {
    let now = 1_000;
    const f = await fixture({ now: () => now });
    await f.gateway.start();
    const { token } = f.session.issueLaunch(1, 100);
    const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) };
    expect((await http(f.basePort + 1, '/__muse/launch', options)).status).toBe(401);
    expect((await http(f.basePort, '/__muse/launch', options)).status).toBe(302);
    const expired = f.session.issueLaunch(1, 100);
    now = 1_100;
    const response = await http(f.basePort, '/__muse/launch', { ...options, body: JSON.stringify({ token: expired.token }) });
    expect(response.status).toBe(401);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.body).not.toContain(expired.token);
  });

  it('rejects GET, query-token, duplicate-token, malformed and unsupported launch input', async () => {
    const f = await fixture();
    await f.gateway.start();
    const { token } = f.session.issueLaunch(1);
    expect((await http(f.basePort, `/__muse/launch?token=${token}`)).status).toBe(405);
    expect((await http(f.basePort, `/__muse/launch?token=${token}`, { method: 'POST', body: '', headers: { 'content-type': 'application/json' } })).status).toBe(400);
    for (const body of ['{', 'null', '[]', '{"token":12}', '{}']) {
      expect((await http(f.basePort, '/__muse/launch', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status).toBe(400);
    }
    expect((await http(f.basePort, '/__muse/launch', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${token}&token=${token}` })).status).toBe(400);
    expect((await http(f.basePort, '/__muse/launch', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: token })).status).toBe(415);
    expect(f.session.consumeLaunch(token, 1)).toBe(true);
  });

  it.each([false, true])('limits launch bodies to 8KiB, including chunked=%s', async (chunked) => {
    const f = await fixture();
    await f.gateway.start();
    const { token } = f.session.issueLaunch(1);
    const prefix = `token=${token}&padding=`;
    const tooLarge = prefix + 'x'.repeat(8_193 - Buffer.byteLength(prefix));
    const response = await http(f.basePort, '/__muse/launch', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: tooLarge, chunked });
    expect(response.status).toBe(413);
    expect(response.headers['set-cookie']).toBeUndefined();
    const exact = prefix + 'x'.repeat(8_192 - Buffer.byteLength(prefix));
    expect((await http(f.basePort, '/__muse/launch', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: exact, chunked })).status).toBe(302);
  });

  it('denies HTTP without a valid account cookie even with the management bearer', async () => {
    const f = await fixture();
    await f.gateway.start();
    for (const headers of [{}, { authorization: 'Bearer management-secret' }, { cookie: 'muse_session_1=wrong' }]) {
      const response = await http(f.basePort, '/', { headers });
      expect(response.status).toBe(401);
      expect(response.body).toMatch(/session/i);
      expect(response.headers['cache-control']).toContain('no-store');
    }
  });

  it('keeps accounts independent with all browser cookies present and rejects duplicate or mismatched values', async () => {
    const f = await fixture({ secure: true });
    await f.gateway.start();
    const first = await launch(f, 1);
    const second = await launch(f, 2);
    expect(first.headers['set-cookie']![0]).toContain('; Secure');
    const both = `${cookie(first)}; ${cookie(second)}`;
    expect((await http(f.basePort, '/', { headers: { cookie: both } })).status).toBe(200);
    expect((await http(f.basePort + 1, '/', { headers: { cookie: both } })).status).toBe(200);
    expect((await http(f.basePort + 1, '/', { headers: { cookie: cookie(first).replace('muse_session_1=', 'muse_session_2=') } })).status).toBe(401);
    expect((await http(f.basePort, '/', { headers: { cookie: `${cookie(first)}; ${cookie(first)}` } })).status).toBe(401);
  });

  it('expires HTTP and WebSocket sessions using the shared session manager', async () => {
    let now = 1_000;
    const f = await fixture({ now: () => now });
    await f.gateway.start();
    const token = f.session.issueSession(1, 100).token;
    now = 1_100;
    const value = `muse_session_1=${token}`;
    expect((await http(f.basePort, '/', { headers: { cookie: value } })).status).toBe(401);
    expect((await upgrade(f.basePort, value)).response).toContain('HTTP/1.1 401');
  });

  it('authenticates upgrades before proxy dispatch and forwards the account context and head', async () => {
    const f = await fixture();
    await f.gateway.start();
    expect((await upgrade(f.basePort)).response).toContain('HTTP/1.1 401');
    const response = await launch(f);
    expect((await upgrade(f.basePort + 1, cookie(response))).response).toContain('HTTP/1.1 401');
    const upgraded = await upgrade(f.basePort, cookie(response), 'first-frame');
    expect(upgraded.response).toContain('HTTP/1.1 101');
    expect(upgraded.response).toContain('X-Account: 1');
    expect(upgraded.response).toContain('X-Authenticated: true');
    expect(upgraded.response).toContain('X-Head: first-frame');
  });

  it('preserves proxied paths and bounded request bodies at the account root', async () => {
    const f = await fixture();
    await f.gateway.start();
    const response = await launch(f);
    const headers = { cookie: cookie(response), 'content-type': 'application/json' };
    const proxied = await http(f.basePort, '/api/message?tab=1', { method: 'POST', headers, body: '{"hello":"world"}' });
    expect(JSON.parse(proxied.body)).toMatchObject({ url: '/api/message?tab=1', accountId: 1, localBase: '', body: '{"hello":"world"}' });
    const uploaded = await http(f.basePort, '/api/message', { method: 'POST', headers, body: 'x'.repeat(8_193), chunked: true });
    expect(uploaded.status).toBe(200);
    expect(JSON.parse(uploaded.body)).toMatchObject({ body: 'x'.repeat(8_193), streamed: true, localOrigin: `http://127.0.0.1:${f.basePort}` });
    expect((await http(f.basePort, '/api/message', { method: 'POST', headers: { ...headers, 'content-length': String(25 * 1_024 * 1_024 + 1) } })).status).toBe(413);
  });

  it('keeps the 413 response when a chunked upload exceeds 25MiB and the proxy catches its stream error', async () => {
    const f = await fixture({ proxy: {
      async handle(req, reply) {
        try {
          for await (const _chunk of req.body as Readable) { /* Drain without buffering the fixture upload. */ }
          reply.code(200); reply.send('uploaded');
        } catch { reply.code(502); reply.send('Upstream request failed'); }
      },
      async upgrade() {},
    } });
    await f.gateway.start();
    const response = await launch(f);
    const result = await http(f.basePort, '/upload', { method: 'POST', headers: { cookie: cookie(response) }, body: 'x'.repeat(25 * 1_024 * 1_024 + 1), chunked: true });
    expect(result.status).toBe(413);
    expect(result.body).not.toContain('Upstream request failed');
  });

  it('checks live store state for new and removed accounts', async () => {
    const f = await fixture();
    await f.gateway.start();
    expect((await http(f.basePort + 2)).status).toBe(404);
    f.accounts.set(3, { id: 3 });
    const response = await launch(f, 3);
    expect((await http(f.basePort + 2, '/', { headers: { cookie: cookie(response) } })).status).toBe(200);
    f.accounts.delete(3);
    expect((await http(f.basePort + 2, '/', { headers: { cookie: cookie(response) } })).status).toBe(404);
    expect((await upgrade(f.basePort + 2, cookie(response))).response).toContain('HTTP/1.1 404');
    expect((await launch(f, 3)).status).toBe(404);
  });

  it('closes every listener and active upgraded socket and supports repeated start/stop', async () => {
    const f = await fixture();
    await Promise.all([f.gateway.start(), f.gateway.start()]);
    const response = await launch(f);
    const upgraded = await upgrade(f.basePort, cookie(response));
    const closed = new Promise<void>((resolve) => upgraded.socket.once('close', () => resolve()));
    await f.gateway.stop();
    await closed;
    await expect(http(f.basePort)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    await expect(http(f.basePort + 31)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    await f.gateway.stop();
    await f.gateway.start();
    expect((await http(f.basePort)).status).toBe(401);
    expect((await http(f.basePort + 31)).status).toBe(401);
  });

  it('isolates account origins for browser mutations and WebSocket upgrades', async () => {
    const f = await fixture();
    await f.gateway.start();
    const first = await launch(f, 1);
    const second = await launch(f, 2);
    const shared = `${cookie(first)}; ${cookie(second)}`;
    const originA = `http://127.0.0.1:${f.basePort}`;
    const originB = `http://127.0.0.1:${f.basePort + 1}`;
    for (const origin of [originA, 'null', 'https://evil.example']) {
      expect((await http(f.basePort + 1, '/api/save', { method: 'POST', headers: { cookie: shared, origin }, body: 'x' })).status).toBe(403);
      expect((await upgrade(f.basePort + 1, shared, '', origin)).response).toContain('HTTP/1.1 403');
    }
    const valid = await http(f.basePort + 1, '/api/save', { method: 'POST', headers: { cookie: shared, origin: originB }, body: 'x' });
    expect(valid.status).toBe(200);
    expect(valid.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect((await upgrade(f.basePort + 1, shared, '', originB)).response).toContain('HTTP/1.1 101');
    expect((await upgrade(f.basePort + 1, shared, '', originB, `evil.example:${f.basePort + 1}`)).response).toContain('HTTP/1.1 403');
    expect((await http(f.basePort + 1, '/', { headers: { cookie: shared } })).status).toBe(200);
  });

  it('accepts management-origin launches while blocking unrelated origins without consuming the token', async () => {
    const f = await fixture({ managementOrigin: 'https://manager.example:9443', publicHost: 'accounts.example' });
    await f.gateway.start();
    expect(f.gateway.launch(1, 'private')).toBe(`http://accounts.example:${f.basePort}/__muse/launch`);
    const token = f.session.issueLaunch(1).token;
    const options = { method: 'POST', body: JSON.stringify({ token }), headers: { 'content-type': 'application/json', origin: 'https://evil.example', host: `accounts.example:${f.basePort}` } };
    expect((await http(f.basePort, '/__muse/launch', options)).status).toBe(403);
    expect((await http(f.basePort, '/__muse/launch', { ...options, headers: { ...options.headers, origin: 'https://manager.example:9443' } })).status).toBe(302);
  });

  it('pipes streaming proxy replies through the node HTTP adapter', async () => {
    const f = await fixture({ proxy: {
      async handle(_req, reply) {
        reply.code(206);
        reply.headers({ 'content-type': 'video/mp4', unused: undefined });
        reply.send(Readable.from([Buffer.from('video-'), Buffer.from('fixture')]));
      },
      async upgrade() {},
    } });
    await f.gateway.start();
    const response = await launch(f);
    const media = await http(f.basePort, '/movie.mp4', { headers: { cookie: cookie(response) } });
    expect(media.status).toBe(206);
    expect(media.body).toBe('video-fixture');
    expect(media.headers['content-type']).toBe('video/mp4');
  });

  it('rolls back already-open listeners when a later account port is occupied', async () => {
    const basePort = await freeRange();
    const blocker = createServer();
    servers.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(basePort + 2, '127.0.0.1', resolve));
    const f = await fixture({ basePort });
    await expect(f.gateway.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await expect(http(basePort)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    await expect(http(basePort + 1)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    await f.gateway.stop();
  });
});
