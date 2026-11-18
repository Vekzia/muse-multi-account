import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Account, AccountInput, AccountListQuery, AccountPatch } from '../types.js';
import { requireBearerToken, type AccountSessionManager } from '../auth/token-auth.js';
import { parseProxy, redactProxy } from '../proxy/proxy-url.js';
import { fingerprintSchema, normalizeFingerprint, type FingerprintPreset } from '../fingerprint/profile.js';
import { keepAliveSchema, normalizeKeepAlive } from '../storage/account-store.js';
import { publicVmState } from '../session/probe.js';
import { SESSION_ERROR_MESSAGES, type SessionStatus } from '../session/maintenance.js';
import type { RegionStatus } from '../proxy/account-region.js';

export interface ApiAccountStore {
  list(query?: AccountListQuery): Account[];
  get(id: number): Account | undefined;
  create(input: AccountInput): Account;
  update(id: number, patch: AccountPatch, expectedVersion?: number): Account;
  generateFingerprint?(id: number, mode: FingerprintPreset, expectedVersion?: number): Account;
  remove(id: number): void;
  setCurrent(id: number): Account;
  getCurrent?(): Account | null | undefined;
}
export interface ApiDependencies {
  accessToken: string;
  accounts: ApiAccountStore;
  sessions?: AccountSessionManager;
  launchAccount?: (id: number, target?: 'muse' | 'fingerprint') => Promise<{ url: string; token: string }>;
  probeProxy?: (proxy: string | undefined, endpoint: string, timeoutMs: number) => Promise<{ ok: boolean; status?: number; latencyMs: number; error?: string }>;
  probeEndpoint?: string;
  proxyRegion?: {
    status(id: number): RegionStatus;
    sync(id: number): Promise<RegionStatus>;
  };
  failoverProxy?: (id: number) => Promise<Account>;
  clearCookies?: (id: number) => Promise<void>;
  /** Cleans external account resources; the route removes the store record afterwards. */
  deleteAccount?: (id: number) => Promise<void>;
  getStatus?: (id: number) => Promise<{ logged: boolean }>;
  sessionMaintenance?: {
    status(id: number): unknown;
    check(id: number): Promise<unknown>;
    /** Called after keepAlive changes have been persisted. */
    configure?(id: number): void;
  };
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
  fp: { ...fingerprintSchema, type: ['object', 'null'] },
  keepAlive: { ...keepAliveSchema, type: ['object', 'null'] },
};
const accountBody = { type: 'object', additionalProperties: false, properties: accountProperties };

function publicAccount(account: Account): Account {
  return {
    id: account.id, name: account.name, avatar: account.avatar, proxy: account.proxy ? redactProxy(account.proxy) : '',
    proxyPool: account.proxyPool.map((proxy) => redactProxy(proxy)), tags: account.tags, group: account.group,
    pinned: account.pinned, logged: account.logged, lastUsedAt: account.lastUsedAt, version: account.version, fp: account.fp,
    keepAlive: normalizeKeepAlive(account.keepAlive),
  };
}
function fail(statusCode: number): never { throw Object.assign(new Error('API request failed'), { statusCode }); }

/** Reject raw values before Fastify/AJV can coerce scalars or remove extra keys. */
function validateAccountBody(raw: Record<string, unknown>): void {
  for (const key of Object.keys(raw)) if (!Object.hasOwn(accountProperties, key)) fail(400);
  if (Object.hasOwn(raw, 'name') && typeof raw.name !== 'string') fail(400);
  for (const key of ['avatar', 'proxy', 'group']) {
    if (Object.hasOwn(raw, key) && raw[key] !== null && typeof raw[key] !== 'string') fail(400);
  }
  if (Object.hasOwn(raw, 'pinned') && raw.pinned !== null && typeof raw.pinned !== 'boolean') fail(400);
  for (const key of ['proxyPool', 'tags']) {
    const value = raw[key];
    if (Object.hasOwn(raw, key) && value !== null && (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))) fail(400);
  }
  if (Object.hasOwn(raw, 'fp') && raw.fp !== null) {
    normalizeFingerprint(raw.fp, 1);
    for (const key of Object.keys(raw.fp as object)) if (!Object.hasOwn(fingerprintSchema.properties, key)) fail(400);
  }
  if (Object.hasOwn(raw, 'keepAlive')) normalizeKeepAlive(raw.keepAlive);
}
const sessionStates = new Set<SessionStatus['state']>(['disabled', 'unknown', 'checking', 'healthy', 'auth_expired', 'blocked', 'error']);

/** The dependency is intentionally unknown: expose only the stable public status contract. */
function publicSessionStatus(value: unknown): SessionStatus {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const timestamp = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {
    state: sessionStates.has(raw.state as SessionStatus['state']) ? raw.state as SessionStatus['state'] : 'unknown',
    lastCheck: timestamp(raw.lastCheck), lastSuccess: timestamp(raw.lastSuccess), nextCheck: timestamp(raw.nextCheck),
    lastError: typeof raw.lastError === 'string' && Object.values(SESSION_ERROR_MESSAGES).includes(raw.lastError) ? raw.lastError : null,
    vmState: publicVmState(raw.vmState) ?? null,
    cookieExpiresAt: timestamp(raw.cookieExpiresAt),
  };
}

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

/** Use the router's decoded match, not raw URL spelling, for security decisions. */
function apiPath(request: FastifyRequest): string {
  const matched = request.routeOptions.url;
  if (matched === '/api' || matched?.startsWith('/api/')) return matched;
  // Unknown API paths still require authentication, including encoded prefixes.
  const raw = request.url.split('?')[0] ?? '';
  try { return decodeURIComponent(raw); } catch { return raw; }
}

/** Register all management routes with bearer-only authorization. */
export function registerApi(app: FastifyInstance, deps: ApiDependencies): void {
  // onRequest runs before parsing/validation and also covers unknown /api paths.
  app.addHook('onRequest', async (request, reply) => {
    const path = apiPath(request);
    if (path !== '/api' && !path?.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    if (path === '/api/health' && request.method === 'GET') return;
    if (!requireBearerToken(deps.accessToken, request.headers.authorization)) {
      return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: errors[401] });
    }
  });
  // AJV defaults coerce scalar values and strip unknown fields. Validate raw
  // account bodies first so invalid updates cannot silently change meaning.
  app.addHook('preValidation', async (request) => {
    const path = apiPath(request);
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return;
    const raw = body as Record<string, unknown>;
    if ((request.method === 'POST' && path === '/api/accounts') || (request.method === 'PATCH' && /^\/api\/accounts\/[^/]+$/.test(path))) {
      validateAccountBody(raw);
    }
    if (request.method === 'POST' && /^\/api\/accounts\/[^/]+\/fingerprint\/generate$/.test(path)) {
      if (Object.keys(raw).some((key) => key !== 'mode') || !['windows', 'macos', 'android'].includes(raw.mode as string)) fail(400);
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
    const account = deps.accounts.create(input);
    if (Object.hasOwn(input, 'keepAlive')) deps.sessionMaintenance?.configure?.(account.id);
    publish('accounts', account.id);
    return reply.code(201).send({ account: publicAccount(account) });
  }));
  app.patch('/api/accounts/:id', { schema: { params: idSchema, body: { ...accountBody, minProperties: 1 } } }, guarded(async (request) => {
    const expected = version(request); const patch = request.body as AccountPatch; validateProxyPatch(patch);
    const account = deps.accounts.update(id(request), patch, expected);
    if (Object.hasOwn(patch, 'keepAlive')) deps.sessionMaintenance?.configure?.(account.id);
    publish('account', account.id);
    return { account: publicAccount(account) };
  }));
  app.post('/api/accounts/:id/fingerprint/generate', { schema: { params: idSchema, body: { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { enum: ['windows', 'macos', 'android'] } } } } }, guarded(async (request) => {
    const expected = version(request); const current = getAccount(id(request));
    if (!deps.accounts.generateFingerprint) fail(503);
    const account = deps.accounts.generateFingerprint(current.id, (request.body as { mode: FingerprintPreset }).mode, expected);
    publish('account', account.id);
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
  app.get('/api/accounts/:id/session', { schema: { params: idSchema } }, guarded(async (request) => {
    const account = getAccount(id(request)); if (!deps.sessionMaintenance) fail(503);
    return { status: publicSessionStatus(deps.sessionMaintenance.status(account.id)) };
  }));
  app.post('/api/accounts/:id/session/check', { schema: { params: idSchema } }, guarded(async (request) => {
    const account = getAccount(id(request)); if (!deps.sessionMaintenance) fail(503);
    const status = publicSessionStatus(await deps.sessionMaintenance.check(account.id));
    publish('status', account.id);
    return { status };
  }));
  app.get('/api/accounts/:id/proxy/region', { schema: { params: idSchema } }, guarded(async (request) => {
    const account = getAccount(id(request)); if (!deps.proxyRegion) fail(503);
    return { region: deps.proxyRegion.status(account.id) };
  }));
  app.post('/api/accounts/:id/proxy/region/sync', { schema: { params: idSchema } }, guarded(async (request) => {
    const account = getAccount(id(request)); if (!deps.proxyRegion) fail(503);
    const region = await deps.proxyRegion.sync(account.id); publish('proxy', account.id);
    return { region };
  }));
  app.post('/api/accounts/:id/proxy/test', { schema: { params: idSchema } }, guarded(async (request) => {
    const account = getAccount(id(request)); if (!deps.probeProxy) fail(503);
    const result = await deps.probeProxy(account.proxy || undefined, deps.probeEndpoint ?? 'https://www.gstatic.com/generate_204', 10_000);
    if (result.ok && deps.proxyRegion) await deps.proxyRegion.sync(account.id);
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
  app.post('/api/session', { schema: { body: { type: 'object', additionalProperties: false, required: ['accountId'], properties: { accountId: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, target: { enum: ['muse', 'fingerprint'] } } } } }, guarded(async (request, reply) => {
    const body = request.body as { accountId: number; target?: 'muse' | 'fingerprint' };
    const account = getAccount(body.accountId);
    if (!deps.launchAccount) fail(503);
    const launch = await deps.launchAccount(account.id, body.target ?? 'muse');
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
