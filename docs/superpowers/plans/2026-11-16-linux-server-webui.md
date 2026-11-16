# Linux Server WebUI v1.5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans task-by-task.

**Goal:** 在现有仓库新增 Linux `server/`，提供 token 保护的 Muse WebUI、每账号 Cookie Jar/代理、反向代理、账号整理、备份、Docker 和 CI。

**Architecture:** server 使用 TypeScript + Fastify，JSON Store 隔离持久层，tough-cookie 隔离账号 Cookie，ReverseProxy 处理 Muse HTTP/WebSocket 路由。Android app 不修改业务契约；根 README 增加 server 入口。

**Tech Stack:** Node.js 20+, TypeScript 5+, Fastify 4, undici, tough-cookie, ws, Vitest, Docker。

**Spec:** docs/superpowers/specs/2026-11-16-linux-server-webui-design.md

## Global Constraints

- `server/` 默认监听 `127.0.0.1:8787`；外部监听必须由 `MUSE_BIND` 显式配置。
- 管理 API 除 `/api/health` 必须校验 bearer token；token 不写日志、不放 query string。
- 每个账号使用独立 Cookie Jar、代理、下载目录和元数据；Cookie/代理密码不进日志。
- 反代只允许配置的 Muse upstream origin；不提供任意 URL SSRF 代理。
- 真实 Muse 请求不是 CI 依赖；测试使用本地 upstream fixture。
- Android `app/` 保持已有构建和测试通过；server 失败不得改变 Android 产物。

---

### Task 1: Server skeleton and storage

**Files:**
- Create: `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`, `server/.env.example`, `server/.gitignore`
- Create: `server/src/types.ts`, `server/src/config.ts`, `server/src/storage/json-store.ts`, `server/src/storage/account-store.ts`, `server/src/server.ts`
- Test: `server/src/**/*.test.ts` for config/store
- Modify: `.gitignore`, root `README.md`

**Interfaces:**
- `AccountStore.list(query?: {query?: string; group?: string; sort?: "manual"|"name"|"recent"}): Account[]`
- `AccountStore.create(input: AccountInput): Account`
- `AccountStore.update(id: number, patch: Partial<AccountInput>): Account`
- `AccountStore.remove(id: number): void`
- `AccountStore.setCurrent(id: number): Account`
- `JsonStore<T>.read(): T`, `write(next: T): void`
- `createServer(options: ServerOptions): Promise<FastifyInstance>`

- [ ] Write failing tests for JSON atomic write/reload, ID monotonicity, group/pin/name/recent ordering, null/invalid values and process-safe data directory.
- [ ] Run `cd server && npm test -- --runInBand`; expected failures identify absent modules.
- [ ] Implement package/tsconfig/Vitest and strict types with Node 20 target.
- [ ] Implement atomic JSON writes through temporary file + rename and account store compatible with Android fields.
- [ ] Add config parser requiring nonempty token in production mode and validating bind/port/upstream/data paths.
- [ ] Run `cd server && npm test`; expected all Task 1 tests pass.
- [ ] Run `npm run build` and commit `feat: add linux server foundation`.

### Task 2: Authenticated API and native WebUI

**Files:**
- Create: `server/src/auth/token-auth.ts`, `server/src/api/routes.ts`, `server/src/webui/assets.ts`, `server/public/index.html`, `server/public/app.js`, `server/public/styles.css`
- Test: `server/src/api/routes.test.ts`, `server/src/auth/token-auth.test.ts`
- Modify: `server/src/server.ts`, `server/package.json`

**Interfaces:**
- `requireBearerToken(expected: string, authorization?: string): boolean`
- `registerApi(app, deps): void`
- `GET /api/health` public; all other `/api/*` require bearer token.
- Account endpoints use JSON `{name, avatar, proxy, proxyPool, tags, group, pinned}` and return `{account}` or `{accounts}`.

- [ ] Write failing Fastify inject tests for missing/wrong/correct token, health, CRUD, 404/409, group/sort queries and no secret in responses/log capture.
- [ ] Implement auth hook and API route schemas with explicit status codes.
- [ ] Implement responsive WebUI that stores token only in sessionStorage, renders account drawer/table, proxy forms, group/sort controls, loading/error/empty states, and uses fetch/SSE.
- [ ] Run API tests and browserless static asset checks.
- [ ] Run `npm run build`; commit `feat: add authenticated server api and webui`.

### Task 3: Cookie Jar and proxy URL/probe

**Files:**
- Create: `server/src/proxy/proxy-url.ts`, `server/src/proxy/cookie-jar.ts`, `server/src/proxy/proxy-probe.ts`
- Test: `server/src/proxy/proxy-url.test.ts`, `cookie-jar.test.ts`, `proxy-probe.test.ts`
- Modify: `server/package.json`, `server/src/storage/account-store.ts`

**Interfaces:**
- `parseProxy(raw: string): ParsedProxy` rejecting unsupported scheme/host/port and userinfo when upstream connector cannot handle it; `redactProxy(proxy): string`
- `AccountCookieJar.get(id): Promise<ToughCookieJar>`, `load(id)`, `save(id, jar)`, `clear(id)`
- `probeProxy(proxy, endpoint, timeoutMs): Promise<{ok:boolean; status?:number; latencyMs:number; error?:string}>`

- [ ] Write failing tests for accepted HTTP/HTTPS/SOCKS5, invalid schemes/ports, redaction, Set-Cookie persistence per account, clear isolation, probe timeout/status and no secret in errors.
- [ ] Implement proxy parsing and cookie file persistence with atomic writes.
- [ ] Implement local HTTP fixture probe; tests never depend on public Muse.
- [ ] Run focused tests and build.
- [ ] Commit `feat: add per-account cookies and proxy probes`.

### Task 4: HTTP reverse proxy and WebSocket bridge

**Files:**
- Create: `server/src/proxy/upstream.ts`, `server/src/proxy/response-rewriter.ts`, `server/src/proxy/reverse-proxy.ts`, `server/src/proxy/ws-proxy.ts`
- Test: `server/src/proxy/response-rewriter.test.ts`, `reverse-proxy.test.ts`, `ws-proxy.test.ts`
- Modify: `server/src/server.ts`, `server/src/api/routes.ts`

**Interfaces:**
- `rewriteMuseText(body, localBase, upstreamOrigin): string`
- `rewriteLocation(value, localBase, upstreamOrigin): string | undefined`
- `createReverseProxy(deps): { handle(request, reply): Promise<void>; upgrade(socket, request): Promise<void> }`
- `isAllowedUpstream(url, configuredOrigin): boolean`

- [ ] Write fixture tests for request path mapping, absolute/relative Muse URLs, Location rewriting, Set-Cookie Jar persistence, hop-by-hop header removal, compressed/non-text passthrough, upstream errors and blocked external origin.
- [ ] Implement HTTP proxy through the account agent and Cookie Jar; stream binary files, decode/re-encode only text with known charset.
- [ ] Implement response header policy: hide upstream Set-Cookie from browser, rewrite Location, remove framing/CSP headers only for the proxied Muse page.
- [ ] Implement WebSocket upgrade route with token/account validation, bidirectional message forwarding, close/error cleanup.
- [ ] Run all proxy fixture tests and build.
- [ ] Commit `feat: add account-aware Muse reverse proxy`.

### Task 5: Backup, Docker, documentation and CI

**Files:**
- Create: `server/src/api/backup.ts`, `server/src/api/backup.test.ts`, `server/Dockerfile`, `server/docker-compose.yml`, `server/README.md`, `.github/workflows/server.yml`
- Modify: `server/src/server.ts`, root `docker-compose.yml`, root `README.md`, `.gitignore`

**Interfaces:**
- `exportBackup(store, jars): Promise<Buffer>` and `importBackup(buffer, store, jars, mode): Promise<ImportResult>`
- `/api/backup/export`, `/api/backup/import` bearer-protected.
- Docker healthcheck `GET /api/health`.

- [ ] Write failing backup roundtrip/merge/replace/invalid token/size-limit tests.
- [ ] Implement backup format with schema/version, account metadata and Cookie Jar data; reject duplicate IDs and malformed records before mutation; use existing `BackupCrypto` compatible envelope where practical or document server format.
- [ ] Add Docker image and compose volume `/data/muse`, non-root runtime, environment validation and healthcheck.
- [ ] Add server GitHub Actions Node 20 install, npm ci, test, build, Docker build; upload test output.
- [ ] Update root README with Linux server quick start, LAN/domain routes, token, proxy/Cookie/fingerprint limitations, and Android build commands.
- [ ] Run `npm test`, `npm run build`, `docker build`, Android regression command and actionlint.
- [ ] Commit `feat: add linux server deployment and ci`.

### Task 6: Integration review and publication

**Files:**
- Modify: docs/verification/v1.5.md
- Test: all Android and server suites

- [ ] Run `git diff --check`, server full tests/build, Android `assembleDebug assembleRelease testDebugUnitTest lintDebug`.
- [ ] Run local HTTP fixture smoke: start server with random token, create two accounts, set different proxy metadata, fetch health/API, export/import, request blocked invalid upstream.
- [ ] Run Docker compose health smoke if Docker is available.
- [ ] Perform static review of SSRF boundary, auth, Cookie separation, WebSocket cleanup, backup mutation ordering and UI empty/error states.
- [ ] Record exact commands/results and known device/runtime limits in `docs/verification/v1.5.md`.
- [ ] Commit verification evidence, push feature branch to fork, run server/Android workflows, verify remote SHA and CI conclusions.
