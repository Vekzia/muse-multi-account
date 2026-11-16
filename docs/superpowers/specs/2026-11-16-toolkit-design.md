# Muse Launcher v1.4 完整工具设计

## 目标与授权
用户要求完成之前列出的其余功能，继续同一 fork 的二开与发布流程。交付账号整理、快捷入口、页面工具、结构拆分和 CI，保留 v1.3 的数据与功能。平台 Android 10+，Java 17，compile/target SDK 34。

## 方案
保留现有 Java + AppCompat + WebView 技术栈，以职责明确的控制器接入 MainActivity。相比重写 Compose，这样保持 Profile 与旧存储兼容；相比继续堆入 Activity，独立模块可单测和单独审查。既有授权覆盖这些模块的实现，常规交互决策采用本设计默认值。

## 账号整理
Account 新增 group（默认空）、pinned（false）、lastUsedAt（0），手动顺序即持久化数组顺序。显示先置顶再按手动/名称/最近使用排序，搜索匹配名称、标签、分组；分组筛选为全部、未分组及已存在分组。长按账号菜单包含置顶、分组、手动上移/下移、桌面快捷方式；另提供可访问菜单入口。分组支持新建、重命名、删除（移回未分组），组名最长 24 字。手动排序支持拖动，筛选状态下只改变可见账号的相对位置；置顶分区保持固定。新字段随配置备份往返，旧版本缺字段默认兼容。

## 快捷入口
每账号可请求固定桌面快捷方式（由系统启动器确认），release 也支持独立的只读切换 intent，不放开 debug 管理参数。删除的账号快捷入口提示并停留当前账号。通知快切与悬浮球默认关闭，显式开启时才请求系统权限。悬浮球是可拖动的系统 overlay，点击打开账号选择器，前台通知可停止；被拒绝权限、重启、清空账号时不崩溃。Android 13 通知权限及 Android 14 specialUse 前台服务声明完整。无需开机自启。通知和快捷方式内容不含代理、Cookie。

## 页面工具
工具菜单提供刷新、页内查找、下载管理、域名拦截设置、快切开关。查找支持实时计数、前后匹配、关闭时 clearMatches。长按 HTTP(S) 图片可保存或复制链接。下载只转发发起页面 UA，不转发登录 Cookie 或授权头，记录下载 id，展示进度/成功/失败，支持打开、取消及移除记录。系统 DownloadManager 不跟随 WebView 代理，配置代理时明确显示系统网络下载确认。blob/data 不冒充成功。

拦截默认关闭，用户可启用示例广告统计域名并编辑阻止/允许名单；纯主机名或 hosts 文本，按域名边界匹配含子域，允许规则优先，主框架不拦。WebView 的请求回调不宣称覆盖 ServiceWorker 和全部流量。

## 架构
AccountRenderer 拥有账号列表/分组/排序交互，AccountOrdering 纯函数，AccountsStore 管理持久化。QuickAccessController/AccountShortcuts/FloatingSwitchService/AccountPickerActivity 管理入口。PageToolsController/DownloadRepository/DownloadsActivity/DomainRules 管理网页增强。MainActivity 保留导航协调；备份交互抽到 BackupController，WebView 创建和销毁抽到 WebViewHost，代理操作集中到 ProxyCoordinator，生命周期和回调避免旧实例覆盖当前状态。

## UI
沿用现有深色底、蓝色强调、原生字体。新增点击区域至少 48dp，正文 14sp、辅助文字 12sp，间距 4/8/12/16/24dp，图标均有 contentDescription。列表有空态、过滤空态；下载有加载/失败/完成状态。长按功能同时由菜单按钮提供，支持键盘/无障碍焦点。工具菜单减少抽屉底部拥挤。

## 验证与发布
纯 JVM 覆盖排序/过滤/迁移/导入、域名边界、URL 与文件名、快捷 intent 解析。构建 debug/release，运行 lint 与单测；尽量启动软件渲染模拟器进行界面 smoke 和截图，能力缺口如实记录。独立审查回调幂等性、Profile 隔离、代理应用时序、下载上下文。GitHub Actions 在 push/PR/workflow_dispatch 运行测试/lint/构建并上传 APK 和报告；只上传工件，不自动发布 Release、不提交签名密钥。更新版本 1.4 / versionCode 5，提交推送独立功能分支，核验远端 CI。
