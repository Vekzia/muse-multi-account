import { createServer, type RequestListener, type Server } from 'node:http';
import { connect, createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { probeProxy } from './proxy-probe.js';

const servers: Server[] = [];
const tcpServers: TcpServer[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(tcpServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  })));
});

function fixture(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  server.on('connection', (socket) => sockets.push(socket));
  servers.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture did not bind');
    resolve(`http://127.0.0.1:${address.port}/probe`);
  }));
}

function proxyFixture(target: string, authorization?: string): Promise<string> {
  const targetUrl = new URL(target);
  const server = createServer();
  server.on('connection', (socket) => sockets.push(socket));
  server.on('connect', (request, client, head) => {
    if (authorization && request.headers['proxy-authorization'] !== authorization) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = connect(Number(targetUrl.port), targetUrl.hostname, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    sockets.push(upstream);
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('proxy fixture did not bind');
    resolve(`http://127.0.0.1:${address.port}`);
  }));
}

describe('probeProxy', () => {
  it('reports a local fixture status and latency without persisting cookies', async () => {
    const endpoint = await fixture((_request, response) => {
      response.setHeader('Set-Cookie', 'fixturePrivate=secret; Path=/');
      response.writeHead(204).end();
    });
    const result = await probeProxy(undefined, endpoint, 500);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(204);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it('returns false with status for non-success fixture responses', async () => {
    const endpoint = await fixture((_request, response) => response.writeHead(503).end('private failure'));
    const result = await probeProxy(undefined, endpoint, 500);
    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(result.error).toBe('Proxy probe returned HTTP 503');
  });

  it('uses an HTTP proxy connector when one is provided', async () => {
    let targetHits = 0;
    const target = await fixture((_request, response) => { targetHits++; response.writeHead(204).end(); });
    const proxy = await proxyFixture(target);
    const result = await probeProxy(proxy, target, 500);
    expect(result.ok).toBe(true);
    expect(targetHits).toBe(1);
  });

  it('sends decoded proxy authentication only to the proxy', async () => {
    let leakedHeader: string | undefined;
    const target = await fixture((request, response) => {
      leakedHeader = request.headers['proxy-authorization'];
      response.writeHead(204).end();
    });
    const proxy = await proxyFixture(target, 'Basic dXNlcjo=');
    const result = await probeProxy(proxy.replace('http://', 'http://user:@'), target, 500);
    expect(result.ok).toBe(true);
    expect(leakedHeader).toBeUndefined();
  });

  it('uses a real SOCKS5 tunnel to the local endpoint', async () => {
    let connects = 0;
    const target = await fixture((_request, response) => response.writeHead(204).end());
    const port = Number(new URL(target).port);
    const server = createTcpServer((socket) => {
      sockets.push(socket);
      socket.once('data', () => {
        socket.write(Buffer.from([5, 0]));
        socket.once('data', (request) => {
          if (request[0] !== 5 || request[1] !== 1 || request[3] !== 1 || request.readUInt16BE(8) !== port) {
            socket.destroy();
            return;
          }
          connects++;
          const upstream = connect(port, '127.0.0.1', () => {
            socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
            socket.pipe(upstream).pipe(socket);
          });
          sockets.push(upstream);
          upstream.on('error', () => socket.destroy());
        });
      });
    });
    tcpServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('SOCKS fixture did not bind');
    const result = await probeProxy(`socks5://127.0.0.1:${address.port}`, target, 500);
    expect(result).toMatchObject({ ok: true, status: 204 });
    expect(connects).toBe(1);
  });

  it('does not follow redirects to a different endpoint', async () => {
    let redirected = false;
    const target = await fixture((_request, response) => { redirected = true; response.writeHead(204).end(); });
    const endpoint = await fixture((_request, response) => response.writeHead(302, { Location: target }).end());
    expect(await probeProxy(null, endpoint, 500)).toMatchObject({ ok: false, status: 302 });
    expect(redirected).toBe(false);
  });

  it('times out a fixture that never responds with a fixed error', async () => {
    const endpoint = await fixture(() => undefined);
    const result = await probeProxy(undefined, endpoint, 25);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Proxy probe timed out');
    expect(result.error).not.toContain(endpoint);
  });

  it('bounds a stalled proxy CONNECT handshake by the requested timeout', async () => {
    const proxy = await fixture(() => undefined);
    servers.at(-1)!.on('connect', () => undefined);
    const started = performance.now();
    const result = await probeProxy(proxy.replace('/probe', ''), 'http://127.0.0.1:1/probe', 30);
    expect(result.error).toBe('Proxy probe timed out');
    expect(performance.now() - started).toBeLessThan(1000);
  }, 1500);

  it('redacts proxy credentials from connector errors', async () => {
    const result = await probeProxy('http://PRIVATE_USER:PRIVATE_PASSWORD@127.0.0.1:1', 'http://127.0.0.1:1/probe', 100);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Proxy probe failed');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  });

  it.each([
    ['not a URL', 'Invalid proxy configuration'],
    ['http://127.0.0.1:1', 'Proxy probe failed'],
  ])('uses fixed errors for invalid/unreachable proxy %s', async (proxy, error) => {
    const result = await probeProxy(proxy, 'http://127.0.0.1:1/probe', 100);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(error);
  });
});
