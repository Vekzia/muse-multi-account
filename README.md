# Muse Launcher · Muse 多账号启动器

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
| 🌐 每账号独立代理 | 支持 `http` / `https` / `socks5`，支持**带账密**的代理，切换账号即时生效 |
| 📡 代理测活 | 一键测试代理连通性（10 秒超时，显示耗时），**测活通过才允许保存** |
| 🔌 Clash 端口探测 | 自动探测本机 Clash 默认端口（7890 / 7891 / 7892），一键填入 |
| 🟢 登录状态识别 | 基于 muse.ai 登录会话 cookie 判断，匿名访问不会误判为已登录 |
| 🔍 搜索过滤 | 抽屉顶部搜索框，按**名称 + 标签**实时过滤列表和侧栏头像 |
| ⛶ 全屏沉浸 | 隐藏侧栏全屏浏览，左缘右滑或返回键唤回 |
| ⬇️ 系统级下载 / 文件选择 | 网页下载走系统下载管理器，文件上传接系统选择器 |
| 🕵️ UA 伪装 | 去除 WebView 标识，避免 muse.ai 误判为移动端而跳转应用商店 |
| 🧰 adb 自动化接口 | 提供一组 am start 参数，方便脚本批量管理账号 / 配置代理 |
| 💾 账号备份 / 迁移 | 一键导出 JSON（可密码加密），支持合并或覆盖导入，可连同 Cookie 一起搬到新机 |
| 🎭 指纹隔离 | 每账号独立 UA（Win/mac/Android/自定义）、时区、语言，可屏蔽 `navigator.webdriver`、Canvas/WebGL 加噪、挡 WebRTC 内网 IP |
| 🎯 代理池 | 一个账号可存多条代理，按顺序优先，当前代理不通时自动换下一条；支持单条 / 池内 / 全账号批量测活 |

## 🖼️ 界面预览

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
3. **配置账号**：抽屉里点某账号的 ⚙️ 进入配置页，可设置头像、名称、代理、标签；
4. **切换账号**：点侧栏头像或抽屉行即切，切换时会先应用该账号的代理；
5. **删除账号**：抽屉里点 🗑️ 二次确认后删除，会同时清掉该账号的全部隔离数据。

### 配置代理

在配置页的「代理」卡片中填入代理地址，支持以下格式：

```
127.0.0.1:7890
http://127.0.0.1:7890
http://用户名:密码@1.2.3.4:3129
socks5://127.0.0.1:1080
```

- 点 **探测**：自动探测本机 Clash 默认端口（7890 混合 / 7891 HTTP / 7892 SOCKS）并填入；
- 点 **测活**：临时应用该代理访问探针地址，返回「连接成功（耗时）/ 失败原因 / 超时」三种结果；
- **留空**表示跟随系统网络（系统开了 VPN/TUN 时即走 TUN）；
- 保存前会自动测活，**测活不通过的代理不会被保存**。

> 💡 提示：如果你手机上的 Clash 开着 VPN/TUN 模式，所有流量本来就会经过 Clash，各账号留空即可；独立代理适合「Clash 关闭/仅代理模式」或想让不同账号走不同出口 IP 的场景。

### 备份与迁移（v1.3）

抽屉底部工具条 → **导出备份**，三档可选：

| 档位 | 内容 | 适用 |
|---|---|---|
| 仅账号配置 | 名称 / 头像 / 标签 / 代理池 / 指纹 | 换机重建账号，不搬登录态 |
| 账号 + Cookie（明文） | 上面全部 + 各账号 muse.ai Cookie | 同机重装、快速复制到另一台设备 |
| 账号 + Cookie（密码加密） | 同上，PBKDF2-SHA256(12 万次) + AES-256-GCM | 备份文件要经过网盘 / 聊天工具时 |

导入时选 **合并**（同名账号跳过，不动本机已有登录态）或 **覆盖**（先清空本机账号与隔离环境）。
合并是默认安全路径：备份里的 id 一律重新分配，不会撞上本机已有的 `acct_<id>` 隔离环境。

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

配置页的 **代理池** 每行一条，越靠前越优先（`http` / `https` / `socks4` / `socks5`，支持 `user:pass@`）：

- 保存时自动把当前生效的那条提到池首；
- 切换账号加载失败且判定为**网络/代理类错误**时，自动换池内下一条并重试一次（每轮只换一次，防止死循环）；
- 轮换结果立即落盘：下次冷启动不会又先撞一遍已失效的节点；
- **全测**：串行测完本账号池内每条，逐条显示 ✓ 耗时 / ✗ 原因；
- 抽屉底部 **批量测活**：把所有账号的所有代理摊平成一个队列跑一遍，支持「清理失效项」——从各账号池里移除失败节点，并保留至少一条。

> 为什么串行：`ProxyController` 是 WebView 的**应用级**全局开关，同一时刻只有一条代理生效，并发测活的结果必然是错的。

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
| `--ez dump_auth true` | bool | 诊断：logcat 输出各账号 cookie 名与 localStorage 键 |

示例：给账号 3 配置代理，测活通过才保存：

```bash
adb shell am start -n com.seekstars.muselauncher/.MainActivity \
  --el open_config 3 \
  --es proxy_preset 'http://user:pass@1.2.3.4:3129' \
  --ez proxy_save true
```

> ⚠️ 这组接口仅在 **debug 构建**中生效（release 构建出于安全考虑不响应任何 intent 参数），面向**个人设备自动化**设计，未做调用方校验。请勿在不可信的环境中使用。需要自动化能力时请自行用 `./gradlew assembleDebug` 构建安装。

## 🧩 实现原理

- **账号隔离**：AndroidX WebView `ProfileStore`，每个账号一个 `Profile`（`acct_<id>`），绑定到各自的常驻 WebView 实例；删除账号时清空并删除对应 Profile；
- **页面按 LRU 驻留**：最多同时保留 4 个账号的页面会话，超出时最久未用的页面被回收（Profile 数据保留，登录态不丢，切回时重新加载页面）；单个页面渲染进程崩溃时自动重建，不影响其他账号；
- **独立代理**：`WebViewCompat` 的 `ProxyController` 是应用级开关，本应用同一时刻只有一个账号在前台，切换账号时应用该账号的代理（支持代理 URL 内嵌账密，另有 407 挑战应答兜底）；
- **UA 伪装**：移除 UA 中的 `; wv` 与 `Version/x.x` 标识，避免被 muse.ai 判定为 WebView 而重定向商店；账号配了 UA 预设时再覆盖成对应平台 UA；
- **指纹注入**：`FingerprintScript` 生成一段 IIFE，经 `WebViewCompat.addDocumentStartJavaScript` 在 document-start 注入，覆写时区/语言/webdriver/Canvas/WebGL/WebRTC；
- **代理池**：`ProxyPool` 负责归一化、去重、优先级与环形轮换；`ProxyHelper` 把结果交给 `ProxyController`，非法规则显式回落系统网络而不是静默丢弃；
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

## 🔒 隐私

- 应用**不包含任何统计、上报或第三方 SDK**（仅 androidx.webkit / appcompat）；
- 网络请求只发生在 muse.ai 本身与你自行配置的代理之间；
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

