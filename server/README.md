# Muse multi-account server v1.8

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

v1.8 增加按账号代理出口推导语言/时区，v1.7 增加独立的服务端 TLS 传输和浏览器策略，见下节。整体仍不等同独立浏览器内核：真实 GPU 计算能力、未注入 frame、ServiceWorker、Date 本地 get/set/parse/toString、Number/Array toLocaleString 等保留原生行为。screen 设置不改变窗口或响应式视口，脚本覆写可被检测或绕过。基础预设为 Chrome131；选Chrome142传输且使用预设UA时会同步到142，system/custom UA由用户自行保持一致。真实账号登录后的站点策略没有端到端保证。

### 代理出口地区与会话维护（v1.8）

语言与时区默认按**每个账号的代理出口 IP**自动识别：为语言和时区分别选择「自动 · 代理出口」后，工作台通过当前账号代理访问固定的定位接口，读取出口 IP、国家码和 IANA 时区。手动指定优先；选择「保持原生」则不覆写。旧账号已有的非空语言或时区仍按手动处理。

路径：`指纹配置 → 语言/时区来源`，以及账号右侧的「出口地区」面板。面板显示出口 IP、国家、建议语言、时区、检测时间与缓存状态；可点击「刷新地区」强制重查。识别成功后若账号页面已打开，会显示「重新打开当前页面」按钮；自动值不会写回手动字段，也不会改变指纹种子。

定位查询只走当前账号代理，不携带 Muse Cookie/管理 token、不跟随重定向、不向管理 API 暴露可配置目标 URL。失败时打开账号页面返回固定 503，工作台显示重试或手动指定提示，**不会退回服务器或访问设备所在地**。识别结果按完整代理配置（含凭据）哈希绑定到账号，代理保存、故障切换、导入或删除时失效；超时12秒，32KiB响应上限。成功缓存1小时，失败冷却60秒；运行中页面可沿用同代理的过期缓存以保持身份稳定，下次打开会刷新。

语言由国家默认映射推断，只是指纹策略，不代表账号使用者的真实语言；时区来自定位服务返回的 IANA 名称。未映射国家需要手动语言。VM 唤醒与会话维护仍按下方v1.7规则配置。

##### 完整配置与会话维护（v1.7）

在「指纹配置 → 高级设置」中选择策略，保存后重开账号页面：

- **TLS/HTTP传输**：native保持Node；chrome131/chrome142使用固定版本wreq-js/BoringSSL模板。HTTP、HTTPS和WebSocket走选中传输，支持账号代理，失败不转直连。验证证书、不自动跟随跳转，Jar仅使用项目自己的账号Cookie。传输模板作用于服务器→Muse这一段，不影响访问设备→工作台的TLS。
- **Worker同步**：同账号Dedicated/Shared Worker、classic/module与注入后创建的Blob同步UA/语言/时区/核心等；映射fetch、Request、importScripts与嵌套Worker。Worker包装URL和ServiceWorker保持行为限制，未注入frame和data:等未覆盖场景不宣称隔离。
- **标准字体**：随项目分发DejaVu Sans，实际覆盖DOM及Canvas/OffscreenCanvas字体。FontFaceSet.check保持原生，Local Font Access隐藏。CSS会覆盖作者字体；缺失的CJK/emoji字形、阴影DOM等仍可能回退到客户端字体。许可证在 `public/fonts/LICENSE`，不是仿造系统字体枚举。
- **WebGPU**：native保持原生，disabled在页面及已包装Worker隐藏接口；不虚构另一显卡的计算能力。自检展示实际暴露情况、Worker读数、加载字体和选择的传输。

浏览器传输用有界子进程隔离依赖的流取消行为；默认最多8个活跃请求/连接、32个等待项。长WebSocket占用一个名额；高并发或大量流媒体时需关注资源使用。参数经IPC传输而非命令行。HTTP上传按现有25MiB限额缓冲，响应流按需读取；停用/断开可终止子进程。依赖未暴露WebSocket101响应头，因此该路径不同步升级Set-Cookie，HTTP响应和会话维护继续处理Cookie轮换；不承诺逐个中继WS ping/pong控制帧。

账号下方「会话维护」默认关闭，默认间隔360分钟，可选30–1440分钟。保存后按间隔调度，最多2个账号同时检查，失败退避；「立即检查」手动执行但仍遵循限流冷却。**唤醒休眠VM独立默认关闭**，只有明确开启且识别到休眠状态才发送唤醒请求，并再次检查RUNNING确认。

维护只访问固定的 `/api/session`，可选 `/api/hatch/vm/wake`。401暂停自动检查直到重新登录后手动检查/保存设置；403表示受限而非退出登录；429遵循Retry-After和退避。显示最近检查、最近成功、下次安排、VM状态及Cookie已知到期时间，**不凭成功请求虚推48小时，也不承诺永久登录**。关闭/删除/清Cookie/导入或更换代理指纹会使旧检查失效，防止迟到响应写回。维护状态是运行时信息，重启后重新检查；设置和Cookie持久化。

协议依据和固定GitHub源码：[Muse会话研究](../docs/muse-session-research.md)。测试使用本地模拟账号与上游，未唤醒真实用户VM。

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

The server workflow runs Node 20, `npm ci`, Vitest with a JUnit report, TypeScript build, Chromium desktop/mobile tests, Docker build, and a non-root container smoke test for health, WebUI assets, authenticated API access, and the native browser-transport HTTP/WebSocket modules. Reports are uploaded even if checks fail. Test upstreams and proxy-exit fixtures are local; CI does not require live Muse credentials or a real proxy subscription.

Android remains a separate project. From the repository root its regression command is `./gradlew --no-daemon --console=plain testDebugUnitTest lintDebug assembleDebug assembleRelease`.
