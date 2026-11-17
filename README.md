# Muse Launcher · Muse 多账号启动器

## Linux WebUI（v1.7，同一仓库）

Linux 服务器新增 WebUI：手机/电脑浏览器直接打开工作台，切换 Muse 账号、配置每账号代理，登录 Cookie 保存在服务器。无需在电脑安装指纹浏览器；现有 Android 版本继续保留。

```bash
git clone --branch feat/v1.7-browser-session https://github.com/Vekzia/muse-multi-account.git
cd muse-multi-account
cp .env.example .env
# 填写 .env：MUSE_ACCESS_TOKEN 用 openssl rand -hex 32 生成
# 本机使用 MUSE_PUBLIC_HOST=127.0.0.1；手机访问填服务器局域网IP
# 手机访问另设置 MUSE_HOST_BIND=0.0.0.0
docker compose up -d --build
```

打开 `http://服务器IP:8787`，输入访问令牌。工作台内创建账号、填写代理，点「打开 Muse」使用内嵌网页。管理端口默认 8787，账号页面使用独立端口 8788–8819，确保手机/电脑能访问这组端口。

- HTTP/HTTPS/SOCKS5 代理支持用户名密码；普通 API 响应只显示脱敏地址。
- 按账号隔离服务器 Cookie Jar，以及浏览器 localStorage / IndexedDB；账号 launch 凭据用一次性 POST 交换，不进入 URL。
- 账号搜索、分组、置顶、名称/最近使用排序、代理测活和切换备用代理、JSON 备份导入导出。
- 默认仅本机监听。此版以局域网/本机部署为入口，公网部署需给管理和账号 Origin 一并配置 HTTPS。
- **v1.6 每账号指纹**：Windows/macOS/Android 预设、自定义 UA、语言/时区、屏幕和硬件元数据、WebGL 标签、固定 Canvas/Audio 噪声、WebRTC 阻断；种子随重启和备份恢复保持一致，支持自检、重新生成、恢复原生。
- 使用方法：选择账号 → 右侧「指纹配置」→ 选择预设 →「重新生成」→ 按需调整 →「指纹自检」。Cookie 保留，启用后 HTTP/WS 请求头与页面 UA/语言同步。
- **v1.7 增强**：可选 Chrome131/142 TLS/HTTP2 上游传输、Worker 参数同步、标准字体和 WebGPU 暴露控制，页面自检可直接查看实际读数。
- **会话维护**：默认关闭、默认6小时一次，支持手动检查、失败退避、登录失效暂停和独立VM唤醒开关；只保存真实Cookie轮换，不凭检查成功虚推48小时。[GitHub协议研究](docs/muse-session-research.md)
- 保留原生模式；ServiceWorker、未注入frame、真实GPU计算等仍有限制，不等同完整指纹浏览器内核。服务端 JSON 备份与 Android 加密备份格式分别管理。

完整说明：[server/README.md](server/README.md)。下文是 Android 版本说明。

---

<p align="center">
  <img src="docs/screenshots/main.png" width="270" alt="Muse Launcher 主界面">
</p>

**把 muse.ai 网页版变成一个真正的 Android 应用**：每个账号一个完全隔离的运行环境、每个账号可配独立代理、支持全屏沉浸浏览。原生壳 + WebView，轻量无广告、无任何数据上报。

[![Release](https://img.shields.io/badge/下载-Releases-blue)](../../releases)
![Platform](https://img.shields.io/badge/Android-10%2B-green)
![WebView](https://img.shields.io/badge/System%20WebView-115%2B-orange)

---

## ✨ 为什么需要它

在桌面放一个 muse.ai 的「网页快捷方式」，点开是浏览器标签页：单账号、无隔离、切换登录要反复登出登入。

Muse Launcher 用 AndroidX WebView 的 **Multi-Profile** 能力，给每个账号一套**完全独立**的 Cookie / localStorage / 存储空间：

- 账号之间互不串数据，像一台手机开了 N 个互不相通的分身；
- 登录状态持久保留，切回来还是登录态；
- 每个账号可以走**不同的代理出口**，适配多账号运营场景。

## 📱 功能一览

| 功能 | 说明 |
|---|---|
| 🔐 多账号完全隔离 | 每账号独立 WebView Profile，Cookie / 存储 / 登录态互不相通 |
| 🌐 每账号独立代理 | 支持无认证 `http` / `https` / `socks5`，等待代理应用完成后再加载页面；显式代理失败不回落直连 |
| 📡 代理测活 | 单条 / 池内 / 全账号串行测活，10 秒超时，显示耗时；保存校验格式，调试自动保存要求测活通过 |
| 🔌 Clash 端口探测 | 自动探测本机 Clash 默认端口（7890 / 7891 / 7892），一键填入 |
| 🟢 登录状态识别 | 基于 muse.ai 登录会话 cookie 判断，匿名访问不会误判为已登录 |
| 🔍 搜索过滤 | 抽屉顶部搜索框，按**名称 + 标签 + 分组**实时过滤列表和侧栏头像 |
| ⛶ 全屏沉浸 | 隐藏侧栏全屏浏览，左缘右滑或返回键唤回 |
| ⬇️ 系统级下载 / 文件选择 | 网页下载走系统下载管理器，文件上传接系统选择器 |
| 🕵️ UA 伪装 | 去除 WebView 标识，避免 muse.ai 误判为移动端而跳转应用商店 |
| 🧰 adb 自动化接口 | 提供一组 am start 参数，方便脚本批量管理账号 / 配置代理 |
| 💾 账号备份 / 迁移 | 一键导出 JSON（可密码加密），支持合并或覆盖导入，可连同 Cookie 一起搬到新机 |
| 🎭 指纹隔离 | 每账号独立 UA（Win/mac/Android/自定义）、时区、语言，可屏蔽 `navigator.webdriver`、Canvas/WebGL 加噪、挡 WebRTC 内网 IP |
| 🎯 代理池 | 一个账号可存多条代理，当前节点加载失败自动尝试下一条；串行测活和清理失效项 |
| 🗂️ 账号整理 | 分组管理、置顶、手动拖动 / 名称 / 最近使用排序、搜索与分组组合筛选 |
| ⚡ 快捷入口 | 每账号桌面快捷方式、可拖动系统悬浮球、通知切换入口（默认关闭） |
| 🧰 页面工具 | 页内查找、长按保存图片 / 复制链接、域名允许 / 阻止名单、下载进度与历史 |
| 🏗️ 自动构建 | GitHub Actions 构建 Debug / Release APK、单元测试、lint 和 Android 设备烟雾测试 |

## 🖼️ 界面预览

以下为上游旧版截图；v1.4 新增入口见下方说明，CI 设备报告包含当前界面截图。

| 多账号抽屉（搜索过滤中） | 账号配置（头像 / 名称 / 代理 / 标签） | 全屏模式 |
|:---:|:---:|:---:|
| <img src="docs/screenshots/drawer.png" width="240"> | <img src="docs/screenshots/config.png" width="240"> | <img src="docs/screenshots/fullscreen.png" width="240"> |

- **左侧窄条**：账号头像一列，绿点表示该账号已登录，点击即切；
- **抽屉**：展开的账号列表，支持重命名、删除、进入配置；
- **配置页**：头像（1–2 字符或 Emoji，实时预览）、名称、代理、标签。

## 📦 安装

1. 前往 [**Releases**](../../releases) 页面下载最新 `MuseLauncher-vx.x.apk`；
2. 直接安装（需允许「安装未知来源应用」）；
3. 系统要求：
   - Android 10（API 29）及以上；
   - 系统 WebView ≥ 115（多账号隔离依赖；版本过旧时启动会提示先更新 WebView）。

## 🚀 快速上手

1. **添加账号**：点侧栏底部或抽屉里的 ➕，会新建一个独立无痕环境并自动打开 muse.ai；
2. **登录**：在页面里正常登录即可，登录态会持久保留在该账号的隔离环境中；
3. **配置账号**：抽屉里点某账号的 ⋮，选择账号配置，可设置头像、名称、代理、标签；
4. **切换账号**：点侧栏头像或抽屉行即切，切换时会先应用该账号的代理；
5. **删除账号**：抽屉里点账号 ⋮ → 删除，二次确认后删除，会同时清掉该账号的全部隔离数据。

### 配置代理

在配置页的「代理」卡片中填入代理地址，支持以下格式：

```
127.0.0.1:7890
http://127.0.0.1:7890
https://proxy.example.com:8443
socks5://127.0.0.1:1080
```

- 点 **探测**：自动探测本机 Clash 默认端口（7890 混合 / 7891 HTTP / 7892 SOCKS）并填入；
- 点 **测活**：临时应用该代理访问探针地址，返回「连接成功（耗时）/ 失败原因 / 超时」三种结果；
- **留空**表示跟随系统网络（系统开了 VPN/TUN 时即走 TUN）；
- 保存时校验当前代理格式；「测活」单独执行，调试 `proxy_save` 才会在测活通过后自动保存。
- WebView ProxyConfig 不支持 URL 内嵌账号密码，`user:pass@` 和 SOCKS4 会明确报错。需要认证的上游可先接入本机代理客户端，再填写其无认证本地端口。旧备份中的地址保留，但支持的地址修正前不加载页面。

> 💡 提示：如果你手机上的 Clash 开着 VPN/TUN 模式，所有流量本来就会经过 Clash，各账号留空即可；独立代理适合「Clash 关闭/仅代理模式」或想让不同账号走不同出口 IP 的场景。

### 备份与迁移（v1.3）

抽屉或侧栏 → **工具与设置** → **导出备份**，三档可选：

| 档位 | 内容 | 适用 |
|---|---|---|
| 仅账号配置 | 名称 / 头像 / 标签 / 代理池 / 指纹 | 换机重建账号，不搬登录态 |
| 账号 + Cookie（明文） | 上面全部 + 各账号 muse.ai Cookie | 同机重装、快速复制到另一台设备 |
| 账号 + Cookie（密码加密） | 同上，PBKDF2-SHA256(12 万次) + AES-256-GCM | 备份文件要经过网盘 / 聊天工具时 |

导入时选 **合并**（同名账号跳过，不动本机已有登录态）或 **覆盖**（先清空本机账号与隔离环境）。
合并时备份里的 id 一律重新分配，不会撞上本机已有的 `acct_<id>` 隔离环境。分组、置顶和最近使用时间随账号备份。覆盖导入须再次确认；合法空备份会清空账号与分组，损坏条目和重复源 ID 在修改本机数据前报错。

Cookie 导出是 muse.ai 根路径 Cookie 头，不包含完整属性、localStorage 或 IndexedDB。回填保留 `hatch_sess` 的 HttpOnly、Secure 属性，等待全部写入结果后显示完成；站点会话过期或设备绑定时仍可能需要重新登录。密码、文件读写和加解密在后台执行。

> ⚠️ 含 Cookie 的备份文件等同于**账号凭据**（`hatch_sess` 就是登录会话）。要外传务必用加密档，密码别和文件放在一起。

### 指纹隔离（v1.3）

配置页 → **指纹隔离**，每个账号可单独设置：

- **User-Agent**：跟随系统 / Windows Chrome / macOS Chrome / Android Chrome / 自定义；
- **时区**：如 `America/Los_Angeles`，覆写 `Intl.DateTimeFormat().resolvedOptions().timeZone` 与 `Date.prototype.getTimezoneOffset`；
- **语言**：如 `en-US`，覆写 `navigator.language(s)` 与 `Intl` 的默认 locale；
- **屏蔽自动化标记**：`navigator.webdriver=false`，并清掉 `__webdriver_*` / `_selenium` / `domAutomation*` 残留；
- **Canvas / WebGL / 硬件参数加噪**：以账号 id 为种子的确定性扰动（同一账号跨加载稳定，不同账号不同），覆盖 `getImageData` 末像素、`UNMASKED_VENDOR/RENDERER`、`hardwareConcurrency`、`deviceMemory`；
- **阻止 WebRTC 泄露内网 IP**：丢弃 `typ host` 候选，只放行 srflx/relay。

实现上走 `WebViewCompat.addDocumentStartJavaScript`（WebView ≥ 105），脚本在页面首个脚本之前执行——用 `onPageStarted` + `evaluateJavascript` 会有竞态，页面早读 `navigator.webdriver` 会拿到原值。改动指纹后该账号页面会自动重建（Profile 与登录态保留）。

已知局限：`Date.prototype.getHours()` 这类本地时间 getter 仍按系统时区返回，WebRTC 只过滤候选事件、不重写 SDP 里已生成的 host 行。

### 代理池与批量测活（v1.3）

配置页的 **代理池** 每行一条，越靠前越优先（无认证 `http` / `https` / `socks5`）：

- 保存时自动把当前生效的那条提到池首；
- 当前前台账号加载失败且判定为**网络/代理类错误**时，自动换池内下一条并重试一次；手动重试/重新选择账号开启新一轮，错误页回调不重置预算；
- 轮换结果立即落盘：下次冷启动不会又先撞一遍已失效的节点；
- **全测**：串行测完本账号池内每条，逐条显示 ✓ 耗时 / ✗ 原因；
- **工具与设置 → 代理批量测活**：把所有账号的所有代理摊平成一个队列跑一遍，支持「清理失效项」——从各账号池里移除失败节点，并保留至少一条。

> 为什么串行：`ProxyController` 是 WebView 的**应用级**全局开关，同一时刻只有一条代理生效，并发测活的结果必然是错的。

### 账号整理（v1.4）

抽屉顶部可选分组和排序。分组支持新建、重命名、删除；删除分组只把账号移至未分组。搜索同时匹配名称、标签和分组名。

- 长按账号或点 ⋮：置顶、移动到分组、重命名、配置、删除、添加桌面快捷方式。
- 手动排序：长按 ≡ 手柄拖动，或菜单上移 / 下移；只在同一置顶分区中排序。筛选时只改变可见账号的相对顺序。
- 名称与最近使用排序：先显示置顶账号；最近使用只记录用户主动选择的账号，被动恢复页面不刷时间。

### 桌面、悬浮球与通知（v1.4）

账号菜单 → **添加桌面快捷方式**，系统启动器会要求确认。图标直达该账号，Release 同样支持；只开放切换动作，调试增删/代理参数仍关闭。改名更新快捷方式，删除后入口失效并提示。

**工具与设置 → 悬浮球与通知快切** 可分别开启通知和系统悬浮球。默认关闭，开启时再申请通知 / 悬浮窗权限。悬浮球可拖动，点击打开账号选择器，长按或通知停止按钮关闭。通知权限、应用通知总开关、对应频道关闭时会给出设置入口。没有开机自启；Android 14 使用 `specialUse` 前台服务声明。

### 页面工具与下载（v1.4）

- **页内查找**：显示匹配数量、上一个 / 下一个；切换或重载页面时清除查找。
- **图片**：长按图片保存 / 复制链接；工具菜单也提供输入图片 URL 的入口。只支持 HTTP(S)，`blob:` / `data:` 不显示虚假下载成功。
- **域名拦截**：默认关闭，可填主机名或 hosts 行。匹配域名与子域，允许名单优先，主页面始终放行。只覆盖 WebView 请求回调，不代表全部流量或 Service Worker 拦截。
- **下载管理**：显示本应用创建的系统下载、进度和失败原因；完成后打开文件。取消会删除系统任务和文件，移除记录仅隐藏历史，两者都有明确说明。

系统 DownloadManager 使用设备网络，不跟随 WebView 代理；代理账号会显示确认。下载只带 UA，**不传 Cookie / Authorization / Referer**，避免系统重定向把登录凭据转给其他地址。页面有登录 Cookie 时会提示下载不携带登录态；需要登录才能访问的链接可能失败。HTTP 资源允许明文传输，应用登录首页仍固定 HTTPS。

### 登录状态是怎么判断的？

绿点只认 muse.ai 的登录会话 cookie（`hatch_sess`）。匿名访问 muse.ai 也会落下一堆埋点与风控 cookie，但不会出现这个会话 cookie——所以新建的、只打开过页面的账号会正确显示「未登录」。判断在每次页面加载完成 / 回到前台时刷新。

## 🤖 adb 自动化接口

所有能力都可通过 `am start` 参数驱动，方便配合脚本做批量运营（例如批量配置代理、批量建号删号）：

| 参数 | 类型 | 作用 |
|---|---|---|
| `--ez show_drawer true` | bool | 启动后展开账号抽屉 |
| `--el start_account <id>` | long | 启动后切换到指定账号 |
| `--ez fullscreen true/false` | bool | 进入 / 退出全屏模式 |
| `--el open_config <id>` | long | 打开指定账号的配置页 |
| `--es proxy_preset '<url>'` | string | 配置页预填代理地址 |
| `--ez proxy_autotest true` | bool | 预填后自动测活（结果只显示不保存） |
| `--ez proxy_save true` | bool | 测活通过后自动保存入库（失败不保存） |
| `--es search_query '<关键词>'` | string | 预填搜索过滤关键词 |
| `--ez add_account true` | bool | 新建一个账号 |
| `--el del_account <id>` | long | 删除指定账号（含隔离数据） |
| `--ez dump_auth true` | bool | 诊断：logcat 仅输出账号 ID 和登录状态 |

示例：给账号 3 配置代理，测活通过才保存：

```bash
adb shell am start -n com.seekstars.muselauncher/.MainActivity \
  --el open_config 3 \
  --es proxy_preset 'http://127.0.0.1:7890' \
  --ez proxy_save true
```

> ⚠️ 这组接口仅在 **debug 构建**中生效（release 构建出于安全考虑不响应任何 intent 参数），面向**个人设备自动化**设计，未做调用方校验。请勿在不可信的环境中使用。需要自动化能力时请自行用 `./gradlew assembleDebug` 构建安装。

## 🧩 实现原理

- **账号隔离**：AndroidX WebView `ProfileStore`，每个账号一个 `Profile`（`acct_<id>`），绑定到各自的常驻 WebView 实例；删除账号时清空并删除对应 Profile；
- **页面按 LRU 驻留**：最多同时保留 4 个账号的页面会话，超出时最久未用的页面被回收（Profile 数据保留，登录态不丢，切回时重新加载页面）；单个页面渲染进程崩溃时自动重建，不影响其他账号；
- **独立代理**：`WebViewCompat` 的 `ProxyController` 是应用级开关，本应用同一时刻只有一个账号在前台，切换账号时通过 FIFO 应用代理，完成回调后再加载；后台页面暂停并阻止新的网络加载，测活临时会话按所有权恢复。WebView 代理不提供用户密码认证；
- **UA 伪装**：移除 UA 中的 `; wv` 与 `Version/x.x` 标识，避免被 muse.ai 判定为 WebView 而重定向商店；账号配了 UA 预设时再覆盖成对应平台 UA；
- **指纹注入**：`FingerprintScript` 生成一段 IIFE，经 `WebViewCompat.addDocumentStartJavaScript` 在 document-start 注入，覆写时区/语言/webdriver/Canvas/WebGL/WebRTC；
- **代理池**：`ProxyPool` 负责归一化、去重、优先级与环形轮换；`ProxyHelper` / `ProxyCoordinator` 串行交给 `ProxyController`，非法规则报错并保留现有配置；显式代理不添加直连后备；
- **备份**：`BackupCodec` 只做信封编解码（账号体复用 `AccountJsonCodec`，两处 schema 不会漂移），`BackupCrypto` 负责 PBKDF2 + AES-GCM；导入时账号 id 一律重新分配，保证 `acct_<id>` 不撞车。

## ❓ 常见问题

**新建环境加载很慢或卡住？**
muse.ai 是 Meta 服务，国内网络直连不通。新建环境会**自动继承当前账号的代理**；如果继承不到（当前账号也没配代理），请先给某个账号配好可用代理再新建，或打开 Clash TUN 模式让全局流量可用。

**页面显示"加载失败"？**
说明该账号的网络路径当前不可用（断网 / 代理失效）。点 **重试** 重新加载；修复网络或代理后再点重试即可，无需删除重建。切换账号时，处于错误状态的页面也会自动重新加载。

**加载速度取决于什么？**
 muse.ai 是重前端单页应用，完整加载需要下载数 MB 资源。速度主要取决于网络路径：经代理（尤其海外代理）会比直连慢，属正常现象；应用侧已按 LRU 保留最近 4 个账号的页面会话，切换回已加载账号是秒开的。

## 🛠️ 本地构建

```bash
# 要求：JDK 17，Android SDK（compileSdk 34）
./gradlew assembleRelease   # 输出 app/build/outputs/apk/release/
./gradlew assembleDebug
```

### 自动构建与测试

`.github/workflows/android.yml` 在 main / feat 分支推送、PR 或手动触发时运行。构建任务使用 JDK 17 + SDK 34，产出 Debug / Release APK、JUnit 和 lint 报告；设备任务在 API 35 加速模拟器执行 `ToolkitSmokeTest` 并上传截图。

```bash
./gradlew testDebugUnitTest lintDebug assembleDebug assembleRelease assembleDebugAndroidTest
# 有支持 MULTI_PROFILE 的设备时
./gradlew connectedDebugAndroidTest
```

Actions 工件保存 14 天，不自动创建 Release。当前继承上游的 debug 签名配置，CI 临时签名不保证跨构建覆盖安装；正式发布应单独配置持久签名，仓库不包含密钥。

## 🔒 隐私

- 应用**不包含任何统计、上报或第三方 SDK**（仅 androidx.webkit / appcompat）；
- 网页请求由当前账号 WebView 发起；测活访问 gstatic HTTPS 探针；主动下载交给系统下载器访问所选资源地址；
- 账号元数据（名称/头像/标签/代理）存于本机 SharedPreferences；登录数据存于各账号的本机 WebView Profile；
- **系统备份已禁用**（`allowBackup=false`）：登录态等敏感数据不会进入云备份或设备迁移，卸载应用即全部清除；
- 账号数据损坏时自动从滚动备份自愈，无法恢复时原始内容会留底在应用私有目录，不会静默丢失；
- 备份文件只写到你用系统文件选择器指定的位置（应用不保存任何路径）；选「明文 + Cookie」等于把登录凭据写到该文件里，请自行保管或改用加密档。

## ⚠️ 免责声明

本项目是面向 muse.ai 网页版的个人效率工具，与 Meta / muse.ai 官方无关。使用时请遵守目标站点的服务条款与当地法律法规。

## 📄 License

[MIT](LICENSE)

---

## 🔗 友情链接

- [LINUX DO](https://linux.do/) —— 真诚分享、友好讨论的技术社区，本项目的交流与反馈也发布于此

---

## 🔗 相关链接

- [Muse Launcher Windows 版](https://github.com/seekstars306/muse-launcher-windows) —— 对应的 Windows WPF + WebView2 多账号启动器

