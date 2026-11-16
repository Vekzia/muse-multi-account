import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CookieJar } from 'tough-cookie';
import { loadConfig } from './config.js';
import type { AccountInput, ServerConfig } from './types.js';
import { AccountStore } from './storage/account-store.js';
import { AccountCookieJar } from './proxy/cookie-jar.js';
import { probeProxy } from './proxy/proxy-probe.js';
import { createReverseProxy } from './proxy/reverse-proxy.js';
import { AccountSessionManager, accountSessionCookieName, requireBearerToken } from './auth/token-auth.js';
import { AccountGateway } from './gateway/account-gateway.js';
import { registerApi } from './api/routes.js';
import { exportBackup, importBackup, type AccountRecord } from './api/backup.js';
import { registerWebUi } from './webui/assets.js';

export interface ServerOptions {
  config?: ServerConfig;
  logger?: FastifyServerOptions['logger'];
  gatewayPort?: number;
  gatewayCount?: number;
  publicHost?: string;
  publicPort?: number;
  secure?: boolean;
  additionalOrigins?: Record<string, string>;
}

/** Serializes management transactions and cookie writes without blocking streaming responses. */
class OperationQueue {
  private tail: Promise<void> = Promise.resolve();
  async acquire(): Promise<() => void> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    return release;
  }
  async run<T>(action: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try { return await action(); } finally { release(); }
  }
}

export async function createServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 10 * 1024 * 1024, requestTimeout: 30_000 });
  const accounts = new AccountStore(config.dataDir);
  const jars = new AccountCookieJar(config.dataDir);
  const sessions = new AccountSessionManager();
  const queue = new OperationQueue();
  const publicHost = options.publicHost ?? '127.0.0.1';
  const gatewayCount = options.gatewayCount ?? 32;
  const gatewayPort = options.gatewayPort ?? config.port + 1;
  const proxy = createReverseProxy({
    accessToken: config.accessToken,
    upstreamOrigin: config.upstreamOrigin,
    getAccount: (id) => accounts.get(id),
    getCookieJar: (id) => jars.get(id),
    authorize: (request, id) => sessions.accountFromSessionCookie(request.headers.cookie, id, accountSessionCookieName(id)),
    additionalOrigins: options.additionalOrigins ?? {
      api: 'https://api.muse.ai',
      production: 'https://production.museai.com',
    },
    saveCookieJar: (id, jar) => queue.run(async () => {
      // A clear/import swaps the cached jar. Late responses must not resurrect old state.
      if (accounts.get(id) && await jars.get(id) === jar) await jars.save(id, jar as CookieJar);
    }),
  });
  const gateways = new AccountGateway({
    host: config.bind, bindHost: config.bind, publicHost, basePort: gatewayPort,
    accessToken: config.accessToken, store: accounts, proxy, session: sessions,
    secure: options.secure ?? false,
    portCount: gatewayCount,
    managementOrigin: `${options.secure ? 'https' : 'http'}://${publicHost}:${options.publicPort ?? config.port}`,
  });
  let listening = false;
  const locks = new WeakMap<object, () => void>();
  app.addHook('preHandler', async (request) => {
    const path = request.url.split('?')[0] ?? '';
    if (path.startsWith('/api/') && path !== '/api/events' && path !== '/api/health'
        && requireBearerToken(config.accessToken, request.headers.authorization)) {
      locks.set(request, await queue.acquire());
    }
  });
  const unlock = (request: object) => { const release = locks.get(request); locks.delete(request); release?.(); };
  app.addHook('onResponse', async (request) => { unlock(request); });
  app.addHook('onError', async (request) => { unlock(request); });
  const backupStore = {
    list: () => accounts.list(),
    create: (record: AccountRecord) => accounts.create(record),
    update: (id: number, record: Partial<AccountRecord>) => accounts.update(id, record),
    remove: (id: number) => accounts.remove(id),
    replaceAll: (records: AccountRecord[]) => {
      for (const record of records) gateways.portFor(record.id);
      accounts.replaceAll(records);
    },
  };
  const backupJars = { get: (id: number) => jars.get(id), restore: (id: number, data: unknown) => jars.restore(id, data), clear: (id: number) => jars.clear(id) };
  registerApi(app, {
    accessToken: config.accessToken,
    accounts: {
      list: (query) => accounts.list(query), get: (id) => accounts.get(id),
      getCurrent: () => accounts.getCurrent(),
      create: (input: AccountInput) => {
        try { gateways.portFor(accounts.peekNextId()); }
        catch { throw Object.assign(new Error('Account gateway range exhausted; increase MUSE_ACCOUNT_PORT_COUNT'), { statusCode: 409 }); }
        return accounts.create(input);
      },
      update: (id, patch, version) => accounts.update(id, patch, version),
      remove: (id) => accounts.remove(id), setCurrent: (id) => accounts.setCurrent(id),
    },
    sessions,
    launchAccount: async (id) => {
      gateways.portFor(id);
      if (!listening) throw Object.assign(new Error('Gateway not listening'), { statusCode: 503 });
      const launch = sessions.issueLaunch(id);
      return { url: gateways.launch(id, launch.token), token: launch.token };
    },
    probeProxy,
    failoverProxy: async (id) => {
      const account = accounts.get(id)!;
      const candidates = [...new Set([account.proxy, ...account.proxyPool].filter(Boolean))];
      if (candidates.length < 2) throw Object.assign(new Error('No alternative proxy'), { statusCode: 409 });
      return accounts.update(id, { proxy: candidates[(candidates.indexOf(account.proxy) + 1) % candidates.length]! });
    },
    clearCookies: async (id) => {
      sessions.revokeAccount(id);
      await jars.restore(id, new CookieJar().toJSON());
    },
    deleteAccount: async (id) => {
      sessions.revokeAccount(id);
      await jars.clear(id);
    },
    getStatus: async (id) => {
      const cookies = await (await jars.get(id)).getCookies(config.upstreamOrigin);
      return { logged: cookies.some((cookie) => cookie.key === 'hatch_sess' && Boolean(cookie.value)) };
    },
    backup: {
      export: () => exportBackup(backupStore, backupJars),
      import: async (data, mode) => {
        const previousIds = accounts.list().map(account => account.id);
        const result = await importBackup(data, backupStore, backupJars, mode);
        for (const id of new Set([...previousIds, ...accounts.list().map(account => account.id)])) sessions.revokeAccount(id);
        return result;
      },
    },
  });
  registerWebUi(app, { publicDir: resolve(dirname(fileURLToPath(import.meta.url)), '../public') });
  app.addHook('onReady', async () => { await gateways.start(); listening = true; });
  app.addHook('preClose', async () => { listening = false; await gateways.stop(); });
  app.setErrorHandler((error, _request, reply) => {
    const code = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
    const status = typeof code === 'number' && code >= 400 && code < 500 ? code : 500;
    reply.code(status).send({ error: status === 400 ? 'Invalid request' : status === 413 ? 'Request too large' : 'Request failed' });
  });
  app.decorate('museConfig', config);
  return app;
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.accessToken) {
    if (config.bind !== '127.0.0.1' && config.bind !== '::1' && config.bind !== 'localhost') throw new Error('MUSE_ACCESS_TOKEN is required for network access');
    config.accessToken = randomBytes(32).toString('base64url');
    // Explicit first-run local setup secret; request logs never contain it.
    process.stdout.write(`First-run access token: ${config.accessToken}\n`);
  }
  const publicHost = process.env.MUSE_PUBLIC_HOST?.trim() || (config.bind === '0.0.0.0' || config.bind === '::' ? '' : config.bind);
  if (!publicHost) throw new Error('Set MUSE_PUBLIC_HOST to the hostname or LAN IP clients use');
  const gatewayPort = Number(process.env.MUSE_ACCOUNT_PORT_START ?? config.port + 1);
  const gatewayCount = Number(process.env.MUSE_ACCOUNT_PORT_COUNT ?? 32);
  const publicPort = Number(process.env.MUSE_PUBLIC_PORT ?? config.port);
  if (!Number.isSafeInteger(publicPort) || publicPort < 1 || publicPort > 65535) throw new Error('Invalid MUSE_PUBLIC_PORT');
  const app = await createServer({ config, publicHost, publicPort, gatewayPort, gatewayCount });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
  try { await app.listen({ host: config.bind, port: config.port }); }
  catch { await app.close(); throw new Error('Server startup failed; check bind address and port availability'); }
  process.stdout.write(`Muse WebUI listening at http://${publicHost}:${config.port}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : 'Server startup failed'}\n`); process.exitCode = 1; });
}
