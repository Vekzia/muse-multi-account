# Linux Server WebUI v1.5 设计

## 目标
在当前 `muse-multi-account` 仓库增加 `server/`，让 Linux 服务器运行 Muse WebUI。手机和电脑浏览器访问服务器地址后，可以像使用软件一样查看 Muse 页面、切换账号、为账号配置独立代理，并保存独立登录会话。现有 Android `app/` 保持可构建、可安装和数据模型兼容。

## 访问模型
服务端提供一个管理面板和账号路由：

- 管理面板：`/`，token 认证后展示账号、分组、代理、登录状态和操作按钮；
- 路径模式：`/muse/:accountId/*`，开发和纯 IP 部署可用；
- Origin 模式：反向代理支持 `a<id>.<base-host>`，生产环境可用 wildcard DNS/反向代理映射账号 Origin，浏览器由不同 Origin 原生隔离 localStorage、IndexedDB 和 Cache Storage；
- 默认监听 `127.0.0.1:8787`，Docker/环境变量可改为 `0.0.0.0`；管理面板和反代都要求 bearer token，token 不写入日志。

第一版不声称实现浏览器级 Canvas/WebGL/GPU 指纹隔离。服务端注入账号 UA/语言和可选的 document-start 脚本；真实 GPU、字体、屏幕等仍来自访问者浏览器。

## 组件

```text
server/src/
  config.ts              环境变量解析和校验
  types.ts               账号、代理、事件、备份类型
  storage/json-store.ts  无原生编译依赖的原子 JSON 持久化
  storage/account-store.ts 账号 CRUD、排序、分组、置顶、最近使用
  proxy/proxy-url.ts     代理地址校验和脱敏
  proxy/cookie-jar.ts    每账号 tough-cookie Jar 持久化
  proxy/upstream.ts      HTTP(S) 请求、响应头、压缩与 Set-Cookie 处理
  proxy/reverse-proxy.ts Muse 路由、HTML/JS URL 重写、跳转重写
  proxy/ws-proxy.ts      WebSocket 升级和上游连接
  api/routes.ts          管理 API、备份、测活
  webui/assets.ts        内置管理面板资源
  server.ts              Fastify 启动入口
```

为保证 Linux Docker 中的可移植性，v1.5 默认使用原子替换的 JSON 存储；`Store` 接口隔离持久层，后续可以无损换 SQLite。数据目录由 `MUSE_DATA_DIR` 指定，默认 `./server-data`。

## 账号和会话
账号元数据：`id/name/avatar/proxy/proxyPool/tags/group/pinned/lastUsedAt/logged`。每个账号一份 `cookies/<id>.json`，每次请求加载对应 Jar；切换账号只改变管理会话选择，不把 Cookie 或代理写入另一个账号。原始 Cookie 不写日志，备份下载提供 JSON 和密码加密两种形式。

管理 API：

```text
GET    /api/health
GET    /api/accounts
POST   /api/accounts
PATCH  /api/accounts/:id
DELETE /api/accounts/:id
POST   /api/accounts/:id/select
POST   /api/accounts/:id/proxy/test
POST   /api/accounts/:id/proxy/failover
POST   /api/accounts/:id/cookies/clear
GET    /api/backup/export
POST   /api/backup/import
GET    /api/events                         # SSE 状态流
```

所有 API 除 `/api/health` 使用 bearer token。管理面板保存 token 于 sessionStorage，不放 URL query。账号写操作带 `If-Match` 可选版本号，冲突返回 409；第一版 UI 使用读取后更新策略。

## 反向代理
请求 `GET /muse/:id/*` 时：

1. 校验账号存在和 bearer token；
2. 读取账号代理地址，校验 scheme/host/port，代理失败直接返回可读错误；
3. 从账号 Jar 生成目标 Origin 的 Cookie header；
4. 通过 `undici.ProxyAgent`（支持 HTTP/HTTPS 代理；SOCKS 走 `socks-proxy-agent` 的 Node stream 路径）请求上游；
5. 删除 hop-by-hop 头和上游 CSP/X-Frame-Options，重写 `Location` 回本地 Muse 路由；
6. 逐条把 `Set-Cookie` 写入该账号 Jar，不把它直接暴露给管理 Origin；
7. HTML/JS/CSS 文本响应重写绝对 `https://muse.ai`、`https://www.muse.ai` URL 为当前账号的本地路径；非文本响应流式转发；
8. 上游响应压缩在需要重写时解压，转发时使用 `Content-Encoding`/`Content-Length` 一致的结果；不支持的内容只转发原 bytes；
9. 页面注入账号 UA/locale 配置和 WebUI bridge，避免覆盖 `muse.ai` 的脚本字符串；注入失败保持原页面可用。

`WebSocket /muse/:id/...` 验证同一 token 和账号后连接上游，转发 text/binary/ping/close；上游关闭时清理连接。第一版不对任意跨域地址开放代理，只允许 Muse 上游 origin 和配置的 Muse 静态资源域名。

## 代理测活
测活对指定代理请求 `https://www.gstatic.com/generate_204`，超时 10 秒，不把结果写入 Cookie Jar。结果包括 `ok/status/latencyMs/error`，日志只写账号 id 和脱敏代理。

## WebUI
原生 HTML/CSS/JS，暗色三栏响应式布局：移动端把账号抽屉折叠成顶部按钮。页面状态包含加载、空账号、代理失败、上游失败、Cookie 清除成功/失败、冲突重试。所有操作按钮最小 44px，账号、代理和 token 输入支持键盘焦点；token 输入 `type=password`。SSE 推送账号切换/代理/登录状态，连接断开显示离线状态并自动重连。

## 部署

```yaml
services:
  muse-server:
    build: ./server
    ports:
      - "8787:8787"
    environment:
      MUSE_BIND: 0.0.0.0
      MUSE_PORT: 8787
      MUSE_ACCESS_TOKEN: change-this-token
      MUSE_UPSTREAM_ORIGIN: https://muse.ai
      MUSE_DATA_DIR: /data/muse
    volumes:
      - muse-data:/data/muse
```

提供 `server/Dockerfile`、`server/docker-compose.yml`（根目录 compose 也提供快捷入口）、`.env.example`、`server/README.md`。不把默认 token、Cookie、代理密码、备份或 data 目录提交到 Git。

## 验证

- `npm test`：代理 URL、Cookie Jar、账号排序/分组、Cookie Set-Cookie 解析、备份 roundtrip、URL rewrite；
- `npm run build`：TypeScript 无错误；
- `npm run test:integration`：Fastify inject 检查 token、账号 API、健康检查、路径模式；
- `docker build`：server 镜像构建；
- HTTP smoke：启动服务、创建账号、设置代理、请求健康检查、导出/导入；真实 Muse 网络依赖配置代理，CI 使用本地 upstream fixture，不访问外部站点。
