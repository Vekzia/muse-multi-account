# Muse multi-account server v1.6

The Linux package runs the management WebUI, bearer-protected Fastify 5 API, per-account proxies, and persistent Cookie Jars. Tests use Vitest 4; persistence uses atomic JSON file replacement. It requires Node 20.19+ for local builds; the Docker image uses Node 22 Debian slim. Account metadata and Cookie Jars live under `MUSE_DATA_DIR` (default `./server-data`, relative to the process working directory).

## Local quick start

From the repository root:

```sh
cd server
cp .env.example .env
# Set MUSE_ACCESS_TOKEN in .env; generate a value with: openssl rand -hex 32
npm ci
npm test
npm run build
node --env-file=.env dist/server.js
```

Open `http://127.0.0.1:8787` and enter the token. `npm start` and `npm run dev` read the process environment; they do not load `.env` automatically. For development with the example file, use `node --env-file=.env --import tsx --watch src/server.ts`.

`GET /api/health` is public. All other management API paths require `Authorization: Bearer TOKEN`. The WebUI keeps the token in `sessionStorage` and exchanges a one-use launch token using POST for an account session cookie. It does not place either token in the URL. In local development without an explicit token, the CLI prints a random first-run token; production startup requires an explicit token.

## Docker Compose

From the repository root:

```sh
cp .env.example .env
# Set MUSE_ACCESS_TOKEN, MUSE_PUBLIC_HOST, and optionally MUSE_HOST_BIND in .env.
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:8787/api/health
```

Alternatively run `docker compose --env-file ../.env up -d --build` from `server/`. Choose one compose project so both entry points do not contend for the same ports or create separate data volumes.

The image runs as `node` (UID 1000). Compose drops capabilities, enables `no-new-privileges`, and stores data in the named volume mounted at `/data/muse`. The image healthcheck uses Node's HTTP fetch to query `/api/health`; it requires no curl package. For bind mounts, create the target directory with ownership writable by UID 1000 before starting the container. Stop the service before taking a raw volume snapshot.

### LAN and domain access

The host mapping defaults to `127.0.0.1`. For LAN clients, set `MUSE_HOST_BIND=0.0.0.0` and `MUSE_PUBLIC_HOST` to the server's LAN IP or hostname. `MUSE_PUBLIC_HOST` is a host only, without a protocol, path, or port. Management uses port 8787; accounts use distinct origins on ports 8788–8819. Compose publishes both ranges. The current range maps IDs 1–32 to fixed ports; deleted IDs remain consumed by the monotonic allocator. Native deployments can adjust `MUSE_ACCOUNT_PORT_START` and `MUSE_ACCOUNT_PORT_COUNT`. Adjust Compose port mappings too when changing that range.

For a domain deployment, point DNS at the host and preserve each account's distinct port/origin through the reverse proxy. Collapsing accounts onto one origin shares browser storage. Wildcard subdomain mapping and TLS origin rewriting are not configured by the supplied Compose files; terminate TLS consistently for management and account origins before using a public domain.

## Backups

Both endpoints require the management bearer token:

```sh
curl --fail -H "Authorization: Bearer $MUSE_ACCESS_TOKEN" \
  http://127.0.0.1:8787/api/backup/export > muse-backup.json
curl --fail -H "Authorization: Bearer $MUSE_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' --data-binary @muse-backup.json \
  'http://127.0.0.1:8787/api/backup/import?mode=merge'
```

The server envelope is UTF-8 JSON: `{ "app": "muse-multi-account-server", "schema": 1, "exportedAt": 0, "accounts": [], "cookies": [] }`. Every cookie entry is `{ "accountId": 1, "jar": <tough-cookie serialized jar> }`. Export preserves complete account metadata including proxy credentials and cookie scope/expiry/flags, so store exported files with the same access controls as the data volume. The default maximum import/export payload is 10 MiB.

- `merge` updates matching account IDs, appends new IDs, and keeps unrelated accounts and their Cookie Jars. Only supplied jars are restored.
- `replace` installs the incoming account set and clears existing jars before restoring those supplied. Empty replacement explicitly removes all accounts and jars.
- Schema, record types, duplicate account/jar IDs, cookie ownership, and payload size are checked before mutations. A runtime write failure triggers restoration of the previous accounts and touched jars; a rollback failure is reported explicitly. This is application-level rollback, not a crash-atomic transaction across all files.

This server JSON format is distinct from Android's backup payload and optional `MUSEBAK1:` AES-GCM passphrase envelope. The server does not encrypt backups or import Android files directly. No password-encryption compatibility is claimed.

## Cookie, proxy, and fingerprint behavior

Each account has one persistent Cookie Jar and one proxy configuration. HTTP/HTTPS/SOCKS5 proxies are parsed by the server; probe errors and ordinary API responses omit credentials. Only the configured Muse upstream is proxied. Backup files intentionally contain the full credentials needed for restoration.

Distinct account origins separate browser localStorage and IndexedDB, while server-side jars keep upstream Cookies separate. v1.6 adds a persisted per-account browser fingerprint profile; it overrides selected page APIs and HTTP/WebSocket headers without requiring a separate browser installation.

### 指纹配置（v1.6）

1. 在工作台选择账号，打开右侧「指纹配置」。
2. 选择 Windows / macOS / Android，点「重新生成」：会生成并保存新的固定种子和配套参数（Chrome 131 UA、平台、屏幕元数据、CPU/内存、WebGL 标签），同时启用覆写。选择下拉框本身仅改变 UA 预设。
3. 按需填写语言和 IANA 时区，展开高级设置启用 Canvas/Audio 噪声、WebRTC 阻断或自定义硬件字段，再点「保存指纹」。保存会提示重新打开当前账号页面，Cookie 保留。
4. 点「指纹自检」：在该账号自己的 Origin 中显示实际页面读数、配置和服务端请求头预览。它不向第三方发送检测请求，也不回显 Cookie/token。
5. 「恢复原生」关闭覆写并重置参数，保留账号身份种子和 Cookie；「重新生成」才更换种子。刷新、服务重启和备份恢复保持已保存种子。

支持：UA/平台/语言、Intl 默认语言与时区、按日期计算夏令时的 getTimezoneOffset、Date locale 格式化、screen 宽高/可用尺寸与 DPR 元数据、CPU 核心/内存字段、WebGL1/2 vendor/renderer 标签、可选 webdriver=false、稳定 Canvas/Audio 读出扰动。启用 UA 覆写会移除上游 Sec-CH-UA* 请求头并隐藏当前 document 的 navigator.userAgentData，避免混用实际 Client Hints。HTTP 与 WebSocket 使用相同配置。

Canvas 噪声作用于 sRGB/RGBA8 二维画布的不透明像素，读取及克隆 PNG 导出保持稳定，原画布不修改；P3/HDR/float16、非二维导出和 OffscreenCanvas 保持原生。Audio getChannelData 返回扰动副本而非可写原始视图，写数据要用 copyToChannel；频谱读出可加微量噪声，播放和时域数据不改。WebRTC 开关直接阻断 RTCPeerConnection，可能影响通话。

这是**脚本和请求头层的指纹配置**，不等同于独立浏览器内核：TLS/HTTP2、字体、真实 GPU 能力、WebGPU、Worker/未注入 frame、Date 本地 get/set/parse/toString、Number/Array toLocaleString 等保持原生，可被检测或绕过；screen 设置不调整窗口或响应式视口。预设固定标识 Chrome 131，不伪装成当前浏览器版本。真实账号登录后的站点策略没有端到端保证。

开启指纹时，无法转换的 HTML（不支持字符集/压缩、分段响应、超过4MiB转换限额）会返回明确的 502 中文提示，避免静默提供未注入页面。旧 v1.5 账号中无效的休眠指纹文本迁移为关闭/原生默认，新设置则严格校验并拒绝非法值。备份格式仍为 schema 1，包含全部新增指纹字段和固定种子。

## Configuration and integration contracts

See [.env.example](.env.example). The main settings are `MUSE_BIND`, `MUSE_PORT`, `MUSE_ACCESS_TOKEN`, `MUSE_PUBLIC_HOST`, `MUSE_PUBLIC_PORT` (external management port), `MUSE_UPSTREAM_ORIGIN`, and `MUSE_DATA_DIR`. Production validates a nonempty token and startup validates host/port/origin values.

`exportBackup(store, jars)` and `importBackup(buffer, store, jars, mode)` are in [src/api/backup.ts](src/api/backup.ts). `AccountStoreLike` accepts `list/create/update/remove` and preferably atomic `replaceAll(accounts)`; incoming IDs must be preserved. The fallback CRUD adapter must preserve IDs, account order, and full metadata during rollback. `AccountCookieJar` integrates through `get/restore/clear`; serialized jars can also use explicit `export` and `save` adapters. The caller serializes imports, exports, account mutations and cookie writes, and revokes active sessions after restored credentials change. The server composition owns bearer protection and HTTP body limits.

## Verification and CI

```sh
cd server
npm ci
npm test
npm run build
docker build -t muse-multi-account-server .
```

The server workflow runs Node 20, `npm ci`, Vitest with a JUnit report, TypeScript build, Docker build, and a non-root container smoke test for health, WebUI assets, and authenticated API access. Reports are uploaded even if checks fail. Test upstreams are local fixtures; CI does not require live Muse credentials.

Android remains a separate project. From the repository root its regression command is `./gradlew --no-daemon --console=plain testDebugUnitTest lintDebug assembleDebug assembleRelease`.
