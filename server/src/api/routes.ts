import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Account, AccountInput, AccountListQuery, AccountPatch } from '../types.js';
import { requireBearerToken, type AccountSessionManager } from '../auth/token-auth.js';
import { parseProxy, redactProxy } from '../proxy/proxy-url.js';

export interface ApiAccountStore {
  list(query?: AccountListQuery): Account[];
  get(id: number): Account | undefined;
  create(input: AccountInput): Account;
  update(id: number, patch: AccountPatch, expectedVersion?: number): Account;
  remove(id: number): void;
  setCurrent(id: number): Account;
  getCurrent?(): Account | null | undefined;
}
export interface ApiDependencies {
  accessToken: string;
  accounts: ApiAccountStore;
  sessions?: AccountSessionManager;
  launchAccount?: (id: number) => Promise<{ url: string; token: string }>;
  probeProxy?: (proxy: string | undefined, endpoint: string, timeoutMs: number) => Promise<{ ok: boolean; status?: number; latencyMs: number; error?: string }>;
  probeEndpoint?: string;
  failoverProxy?: (id: number) => Promise<Account>;
  clearCookies?: (id: number) => Promise<void>;
  /** Cleans external account resources; the route removes the store record afterwards. */
  deleteAccount?: (id: number) => Promise<void>;
  getStatus?: (id: number) => Promise<{ logged: boolean }>;
  backup?: {
    export: () => Promise<Buffer>;
    import: (buffer: Buffer, mode: 'merge' | 'replace') => Promise<unknown>;
  };
  events?: { subscribe: (listener: (event: { type: string; accountId?: number }) => void) => () => void };
}

const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
const idSchema = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } } };
const stringField = { type: ['string', 'null'], maxLength: 2_048 };
const accountProperties = {
  name: { type: 'string', minLength: 1, maxLength: 120, pattern: '\\S' },
  avatar: stringField, proxy: stringField,
  proxyPool: { type: ['array', 'null'], maxItems: 100, items: { type: 'string', maxLength: 2_048 } },
  tags: { type: ['array', 'null'], maxItems: 100, items: { type: 'string', maxLength: 120 } },
  group: { type: ['string', 'null'], maxLength: 120 }, pinned: { type: ['boolean', 'null'] },
};
const accountBody = { type: 'object', additionalProperties: false, properties: accountProperties };

function publicAccount(account: Account): Account {
  return {
    id: account.id, name: account.name, avatar: account.avatar, proxy: account.proxy ? redactProxy(account.proxy) : '',
    proxyPool: account.proxyPool.map((proxy) => redactProxy(proxy)), tags: account.tags, group: account.group,
    pinned: account.pinned, logged: account.logged, lastUsedAt: account.lastUsedAt, version: account.version, fp: account.fp,
  };
}
function fail(statusCode: number): never { throw Object.assign(new Error('API request failed'), { statusCode }); }
function version(request: FastifyRequest): number | undefined {
  const value = request.headers['if-match'];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^(?:[1-9]\d*|"[1-9]\d*")$/.test(value)) fail(400);
  const parsed = Number(value.replaceAll('"', ''));
  if (!Number.isSafeInteger(parsed)) fail(400);
  return parsed;
}
function id(request: FastifyRequest): number { return Number((request.params as { id: number }).id); }
function validateProxyPatch(patch: AccountPatch): void {
  try {
    if (patch.proxy) parseProxy(patch.proxy);
    for (const proxy of patch.proxyPool ?? []) parseProxy(proxy);
  } catch { fail(400); }
}
function errorStatus(error: unknown): number {
  if (error && typeof error === 'object') {
    const record = error as { statusCode?: number; status?: number; code?: number | string; validation?: unknown; message?: string };
    if (record.validation) return 400;
    const status = record.statusCode ?? record.status ?? record.code;
    if (typeof status === 'number' && [400, 401, 404, 409, 413, 503].includes(status)) return status;
    if (record.code === 'NOT_FOUND') return 404;
    if (record.code === 'CONFLICT') return 409;
  }
  return 500;
}
const errors: Record<number, string> = { 400: 'Invalid request', 401: 'Authentication required', 404: 'Account not found', 409: 'Account changed. Refresh and retry.', 413: 'Backup is too large', 503: 'Operation is not configured', 500: 'Operation failed' };

/** Register all management routes with bearer-only authorization. */
export function registerApi(app: FastifyInstance, deps: ApiDependencies): void {
  // onRequest runs before parsing/validation and also covers unknown /api paths.
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (path !== '/api' && !path?.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    if (path === '/api/health' && request.method === 'GET') return;
    if (!requireBearerToken(deps.accessToken, request.headers.authorization)) {
      return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: errors[401] });
    }
  });
  const getAccount = (accountId: number): Account => {
    const account = deps.accounts.get(accountId);
    if (!account) fail(404);
    return account;
  };
  const listeners = new Set<(event: { type: string; accountId?: number }) => void>();
  const publish = (type: string, accountId?: number) => {
    const event = accountId === undefined ? { type } : { type, accountId };
    for (const listener of listeners) listener(event);
  };
  const guarded = (handler: (request: FastifyRequest, reply: FastifyReply) => unknown | Promise<unknown>) => async (request: FastifyRequest, reply: FastifyReply) => {
    try { return await handler(request, reply); } catch (error) {
      const status = errorStatus(error);
      return reply.code(status).send({ error: errors[status] ?? errors[500] });
    }
  };
  // Fastify's default schema errors include property names but never body values.
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/accounts', { schema: { querystring: { type: 'object', properties: { query: { type: 'string', maxLength: 200 }, group: { type: 'string', maxLength: 120 }, sort: { enum: ['manual', 'name', 'recent'] } } } } }, guarded(async (request) => ({ accounts: deps.accounts.list(request.query as AccountListQuery).map(publicAccount), currentId: deps.accounts.getCurrent?.()?.id ?? null })));
  app.get('/api/accounts/:id', { schema: { params: idSchema } }, guarded(async (request) => ({ account: publicAccount(getAccount(id(request))) })));
  app.post('/api/accounts', { schema: { body: { ...accountBody, required: ['name'] } } }, guarded(async (request, reply) => {
    const input = request.body as AccountInput; validateProxyPatch(input);
    const account = deps.accounts.create(input); publish('accounts', account.id);
    return reply.code(201).send({ account: publicAccount(account) });
  }));
  app.patch('/api/accounts/:id', { schema: { params: idSchema, body: { ...accountBody, minProperties: 1 } } }, guarded(async (request) => {
    const expected = version(request); const patch = request.body as AccountPatch; validateProxyPatch(patch);
    const account = deps.accounts.update(id(request), patch, expected); publish('account', account.id);
    return { account: publicAccount(account) };
  }));
  app.delete('/api/accounts/:id', { schema: { params: idSchema } }, guarded(async (request, reply) => {
    const expected = version(request); const account = getAccount(id(request));
    if (expected !== undefined && account.version !== expected) fail(409);
    await deps.deleteAccount?.(account.id);
    deps.accounts.remove(account.id); deps.sessions?.revokeAccount(account.id); publish('accounts', account.id);
    return reply.code(204).send();
  }));
  app.post('/api/accounts/:id/select', { schema: { params: idSchema } }, guarded(async (request) => {
    const account = deps.accounts.setCurrent(id(request)); publish('selected', account.id);
    return { account: publicAccount(account) };
  }));
  app.get('/api/accounts/:id/status', { schema: { params: idSchema } }, guarded(async (request) => {
    const account = getAccount(id(request));
    const status = deps.getStatus ? await deps.getStatus(account.id) : { logged: account.logged };
    return { status: { logged: Boolean(status.logged) } };
  }));
  app.post('/api/accounts/:id/proxy/test', { schema: { params: idSchema } }, guarded(async (request) => {
    const account = getAccount(id(request)); if (!deps.probeProxy) fail(503);
    const result = await deps.probeProxy(account.proxy || undefined, deps.probeEndpoint ?? 'https://www.gstatic.com/generate_204', 10_000);
    publish('proxy', account.id);
    return { ok: result.ok, latencyMs: result.latencyMs, ...(result.status === undefined ? {} : { status: result.status }), ...(result.ok ? {} : { error: 'Proxy probe failed' }) };
  }));
  app.post('/api/accounts/:id/proxy/failover', { schema: { params: idSchema } }, guarded(async (request) => {
    const current = getAccount(id(request)); if (!deps.failoverProxy) fail(503);
    const account = await deps.failoverProxy(current.id); publish('proxy', account.id);
    return { account: publicAccount(account) };
  }));
  app.post('/api/accounts/:id/cookies/clear', { schema: { params: idSchema } }, guarded(async (request) => {
    const account = getAccount(id(request)); if (!deps.clearCookies) fail(503);
    await deps.clearCookies(account.id); deps.accounts.update(account.id, { logged: false }); deps.sessions?.revokeAccount(account.id); publish('status', account.id);
    return { ok: true };
  }));
  app.post('/api/session', { schema: { body: { type: 'object', additionalProperties: false, required: ['accountId'], properties: { accountId: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } } } } }, guarded(async (request, reply) => {
    const account = getAccount((request.body as { accountId: number }).accountId);
    if (!deps.launchAccount) fail(503);
    const launch = await deps.launchAccount(account.id);
    return reply.code(201).send({ url: launch.url, token: launch.token });
  }));
  app.get('/api/backup/export', guarded(async (_request, reply) => {
    if (!deps.backup) fail(503);
    const data = await deps.backup.export();
    return reply.type('application/json').header('Content-Disposition', 'attachment; filename="muse-backup.json"').send(data);
  }));
  app.post('/api/backup/import', { bodyLimit: MAX_BACKUP_BYTES, schema: { querystring: { type: 'object', properties: { mode: { enum: ['merge', 'replace'] } }, required: ['mode'] }, body: { type: 'object' } } }, guarded(async (request) => {
    if (!deps.backup) fail(503);
    const result = await deps.backup.import(Buffer.from(JSON.stringify(request.body)), (request.query as { mode: 'merge' | 'replace' }).mode);
    publish('accounts'); return { result };
  }));
  const streams = new Set<() => void>();
  app.get('/api/events', async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    reply.raw.write('data: {"type":"connected"}\n\n');
    const send = (event: { type: string; accountId?: number }) => {
      if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify({ type: 'change', ...(Number.isSafeInteger(event.accountId) ? { accountId: event.accountId } : {}) })}\n\n`);
    };
    listeners.add(send);
    const unsubscribe = deps.events?.subscribe(send);
    const heartbeat = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n'); }, 20_000);
    heartbeat.unref();
    const close = () => { clearInterval(heartbeat); listeners.delete(send); unsubscribe?.(); streams.delete(close); reply.raw.end(); };
    streams.add(close); request.raw.on('close', close);
  });
  app.addHook('preClose', async () => { for (const close of streams) close(); });
}
