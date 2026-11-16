# Server Fingerprint v1.6 Implementation Plan

> **For agentic workers:** Follow task-scoped development and review. User already instructed no more planning questions; choose reasonable defaults and execute.

**Goal:** 为同仓库 Linux WebUI 加每账号固定指纹，保留反代架构。
**Architecture:** fingerprint/profile.ts 归一化与生成稳定配置；fingerprint/script.ts 生成最早页面脚本；HTTP/WS 请求头使用相同profile；WebUI配置、保存、重新生成及账号Origin自检页。
**Tech Stack:** 现有 Fastify5/TS/Vitest4/Playwright，Node20+，不增浏览器运行时服务。
**Spec:** 以下契约为本轮定稿，保留v1.5账号和备份兼容。

## Global Constraints
- 不再请求用户设计确认，用户已明确自行决策后执行。保持当前仓库，不改 Android。
- 新账号默认兼容模式 enabled=false；开启预设才覆写。旧 fp 字段迁移保持可读，非法更新返回400而非静默丢弃。
- seed是账号生命周期稳定32位正整数，生成一次保存；备份恢复保留；重新生成显式调用API，If-Match并发检查。
- 所有代码路径共享归一化；内容脚本序列化转义 < / U+2028/U+2029；不执行用户脚本。
- 功能是页面脚本+服务端请求头覆写，不修改客户端TLS、真实字体、浏览器内核、WebGPU或Worker。清楚显示限制。

## Profile contract
Extend server/src/types.ts Fingerprint existing fields (uaMode,uaCustom,timezone,locale,webdriver,noise,webrtc) with optional enabled:boolean, seed:number, platform:string, screenWidth:number, screenHeight:number, pixelRatio:number, hardwareConcurrency:number, deviceMemory:number, webglVendor:string, webglRenderer:string, audioNoise:boolean. normalize output includes defaults (0 or empty means native for numerical/text options). Legacy fp no enabled means false; legacy seed absent stable deterministic fallback based on accountId (never changes on read), newly created account seed randomBytes.

profile.ts exports normalizeFingerprint(input:unknown, accountId:number): Fingerprint; generateFingerprint(mode:'windows'|'macos'|'android', previous?:Partial<Fingerprint>): Fingerprint; fingerprintHeaders(headers:IncomingHttpHeaders, fp?:Fingerprint):IncomingHttpHeaders; fingerprintUserAgent(fp):string|undefined. Modes system/windows/macos/android/custom (predefined Chrome131 strings match existing Android presets; label explicit version). Preset chooses consistent platform, viewport metadata and GPU pair; invalid tz via Intl, locale via Intl.getCanonicalLocales, header controls and bounds reject statusCode400. Off headers unchanged; on overrides configured UA/Accept-Language, removes mismatching Sec-CH-UA* (do not forge platform hint alongside wrong actual GPU); page navigator.userAgentData masked when custom UA so note unsupported native high entropy.

## Tasks
### 1 Profile/store/API/backup
Owned types.ts, storage/account-store.ts, api/routes.ts, api/backup.ts, new fingerprint/profile.ts and focused tests.
- [ ] RED roundtrip fp.enabled/seed, partial PATCH preserves seed and other fp fields, save/import/restart stable, invalid tz/locale/numerics/UA injection rejects no mutation.
- [ ] profile generate/normalize/header sync; store create defaults generated seed only at creation; update deep-merge fp; backup validators via normalized fingerprint.
- [ ] authenticated POST /api/accounts/:id/fingerprint/generate {mode} preserving cookies/account and If-Match; PATCH uses fp schema. Return {account}, SSE account event.
- [ ] expose strict JSON Schema for fp optional fields, no extra raw JS allowed. Run focused Vitest and tsc.

### 2 Browser runtime
Owned new fingerprint/script.ts + tests. `fingerprintScript(fp:Fingerprint):string|null`, `injectFingerprint(html,fp):string`.
- [ ] Test in Playwright actual API behavior, generated script before page code, enabled=false null, idempotent installation.
- [ ] Navigator UA/platform/languages/hardware/dmem; screen metadata dims+DPR (not viewport resize); webdriver optional; Intl default locale/timezone wrappers preserve explicit arguments/prototype/static and correct DST per-Date getTimezoneOffset; display other Date local methods native if not implemented, clearly disclose.
- [ ] Canvas getImageData + toDataURL/toBlob clone output with stable seed coordinate delta, do not mutate visible source; repeated reads stable, origin-taint errors preserved; WebGL1/2 unmasked vendor/renderer if configured. Audio noise deterministic non-cumulative with copy semantics where viable; WebRTC true means block constructors (explicit behavior, may disable calls).
- [ ] Mask navigator.userAgentData only with custom UA (worker unsupported), typed arrays bounds/zero-size guards; per-feature try catch not whole script failure. Use graceful optional API handling.

### 3 WebUI
Owned public/index.html/app.js/styles.css + webui/app.test.ts tests; add panel fields with ids fp-enabled/fp-mode/fp-custom/fp-timezone/fp-locale/fp-width/fp-height/fp-ratio/fp-cores/fp-memory/fp-vendor/fp-renderer/fp-noise/fp-audio/fp-webrtc/fp-webdriver; seed readonly. Save/regen/reset native/check buttons, independent dirty draft+If-Match. Use PATCH {fp}, POST generate, launch selfcheck same isolated Origin via normal POST /api/session{accountId,target:'fingerprint'} token handshake redirects only reserved check page. Do not let check iframe become external site.
- [ ] Field validation UI mirrors backend, save reload active account for new document script (confirmation clear); generation preserves cookies, no unnecessary token revocation. Selfcheck diagnostic result includes headers and page runtime.

### 4 Parent integration/verification
Owned proxy/reverse-proxy.ts/ws-proxy.ts, gateway/account-gateway.ts, server.ts, e2e, docs, versions/CI.
- [ ] request fingerprint headers passed before upstreamHeaders strips/origin mapping; config loaded live per request including API alias and WS.
- [ ] inject fingerprint BEFORE existing browser bridge BEFORE upstream scripts only HTML; no-store/no validators for transformed HTML to ensure seed not stale. Existing page HTML too large/nonutf charset handled visibly with unsupported notice.
- [ ] Selfcheck /__muse/fingerprint HTML served at authenticated gateway; no tokens/cookies in output, no external resources; script exact same as production, show live API & server headers, channel to panel if needed validate origin/source.
- [ ] Run baseline220+ tests, new unit/API tests, Playwright2 profiles across two accounts/reload/restart/backup; real Date DST and canvas exports; inspect desktop/mobile screenshots, live Muse page smoke no actual login.
- [ ] Independent review and scoped fixes, bump server1.6 only, docs real limitations, commit/push same fork new feature branch, Server Docker+Android CI green.
