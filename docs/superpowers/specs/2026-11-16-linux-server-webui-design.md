# Linux Server WebUI v1.5 设计（实现定稿）

## 目标
在当前 muse-multi-account 仓库增加 server/ Linux 服务。普通手机和电脑浏览器打开管理面板，创建/切换 Muse 账号、配置独立代理，使用真实网页反向代理而非远程桌面。Android app/ 保持原样。

## 架构决定
- Node.js 20.19+、TypeScript、Fastify 5；原生 HTML/CSS/JS 工作台。
- 元数据采用单进程原子 JSON 文件替换，Cookie 使用 tough-cookie 完整 Jar。无额外数据库安装。SQLite 后续可通过存储接口替换，本次不包含 SQLite。
- 管理面板默认 127.0.0.1:8787。每账号独立浏览器 Origin 使用端口 `MUSE_ACCOUNT_PORT_START + id - 1`（默认 8788–8819），支持纯 IP/局域网，无需 wildcard DNS。
- 管理服务不挂载上游页面；独立账号端口提供根路径，兼容 Muse Next.js 根资源路径和浏览器 localStorage/IndexedDB 隔离。底层代理保留路径模式单元测试，但生产入口只使用独立账号端口。子域名路由未包含。
- ID 单调分配，端口 Origin 不复用给另一账号。默认范围覆盖 ID 1–32，可配置 portCount 1–1024并同步防火墙/端口映射；删除的 ID 不回收。

## 认证与访问
管理 API 除 /api/health 使用 Bearer token，WebUI token 仅保存在 sessionStorage。`POST /api/session` 签发绑定账号、60秒过期、单次消费的 launch token。前端以隐藏 POST 表单发送到账号端口 `/__muse/launch`，凭据不进入 URL/query，兑换 root-path 的 `muse_session_<id>` HttpOnly/SameSite=Lax cookie，随后跳转到 `/`。账号会话有效8小时。

账号端口校验会话和 Origin，WebSocket 还校验 Host；Cookie 不按端口隔离，因此不同 cookie名和请求 Origin 检查必须一起使用。管理 API 不接受账号 cookie。默认 HTTP 仅适用于本机/信任网络，公网要对管理和账号 Origin 同时配置 HTTPS；当前 Compose不自动签发证书或配置域名。

## 请求与代理
代理支持 HTTP、HTTPS、SOCKS5及用户名密码，格式校验、错误和普通API输出脱敏。请求使用账号代理和账号Jar，删除浏览器管理Authorization/Cookie与hop头；上游响应逐条Set-Cookie写入对应Jar。仅允许配置的上游Origin，不接受任意URL代理。

已实现响应URL/Location重写、gzip/deflate/br已知字符集文本重写（4MiB上限）、二进制/Range/SSE流式传输、WebSocket text/binary/ping/pong/subprotocol/close桥接。上传流最大25MiB，launch body最大8KiB。HTTP CONNECT/握手有超时。运行中迟到响应不得在清Cookie或恢复备份后重新写回旧Jar。

不提供完整指纹隔离：客户端浏览器GPU、Canvas、WebGL、字体、屏幕与JS环境保持原生。Account fp字段仅为Android元数据兼容，不声称server注入UA/时区伪装。

## API与UI
- health、account list/create/get/update/delete/select/status。
- 分组字段、置顶、名称/最近使用/创建顺序排序、名称/标签/分组搜索。
- 代理编辑、测活、备用节点轮换；If-Match乐观并发。
- 单账号Cookie清理与SSE变更事件。
- JSON备份导出/合并/替换：10MiB限制，先完整校验，操作失败恢复旧账号与Jar；不保证跨文件断电事务。格式与Android MUSEBAK1不同，本次服务端未实现密码加密备份。

中文暗色响应式UI，桌面侧栏+账号iframe+设置面板，移动抽屉。每个按钮≥44px，键盘可达，loading/empty/error/offline状态。SSE不覆盖未提交草稿；异步切号和launch有generation检查；备份替换要求确认。

## 部署与验证
提供server/Dockerfile（Node22 Debian slim、UID1000、healthcheck）、根目录与server目录Compose入口、env.example。Compose显式token/publicHost，默认本机绑定，持久数据named volume。

本地单元/HTTP fixture/真实WebSocket代理测试、TypeScript build、Playwright桌面与移动端两账号Cookie+localStorage切换。真实Muse匿名登录页进行独立加载检查，不替代真实账号登录后任务流程验证。CI Node20执行测试/build/Playwright、Docker build+nonroot健康检查；Android原有工作流保持。
