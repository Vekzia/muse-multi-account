# v1.7 Transport, Worker, Fonts, WebGPU and Session Plan

User asks to finish the remaining fingerprint layers in the existing Linux WebUI and research GitHub Muse keepalive implementations; previous instruction says proceed after planning without questions.

## Evidence-first design
Research exact SHA/file links before choosing keepalive endpoints/semantics. Session validity, VM awake state and socket liveness are separate. Persist real Set-Cookie/expiry only; a successful check never fabricates another 48 hours. No real credentials or waking actual user VM during development.

## Contracts
Extend Fingerprint optional fields (all default native): `tlsProfile: 'native'|'chrome131'|'chrome142'`; `workerMode:'native'|'profile'`; `fontMode:'native'|'standard'`; `webgpuMode:'native'|'disabled'`. Account `keepAlive?:{enabled:boolean,intervalMinutes:number,wakeVm:boolean}` defaults false/360/false, interval30..1440 integer; preserved in backups/store/API. FP reset returns native, regenerate keeps selected policy flags; hardware labels/profile defaults remain explicit Chrome131 (chrome142 TLS selection must not silently imply matching131 UA; validation/derive effectiveUA coherent when browser preset active).

Task assignments disjoint: schema/profile/API/store/backup one owner; transport new module one owner; worker/font/WebGPU new script module one owner; keepalive new scheduler/probe one owner; UI files one owner; parent integrates proxy/server/gateway/diagnostics/Docker/CI/docs/E2E.

### T1 Research
Pin Muse repository sources/licenses. Record exact session GET/VMwake POST body, status JSON shapes, failures and expiration rules. Native browser TLS transport investigate wreq-js vs curl_cffi actual working stream/proxy/WS APIs, TLS local handshake fixture and nonroot Linux packages.

### T2 Browser policies
- workerMode profile wraps Dedicated Worker classic/module and SharedWorker where supported, at creation injects same fixed profile before startup; preserve relative fetch/importScripts/module imports, error handling, terminate and URLs cleanup. Avoid injecting window-only code blindly. For unsupported external/ServiceWorker clearly document native or explicitly blocked policy, no false success. Local worker runtime test returns UA/lang/timezone/cores/seed; two accounts differ; disabled native. Blob handling preserving origin restrictions; control fetching resources through same account gateway, not direct API origin. Don't bypass Worker same-origin restrictions.
- fontMode standard uses bundled OFL font asset for actual layout/canvas when possible; explicit policy for FontFaceSet/check/local access; do not pretend local OS fonts vanished. Preserve user-supplied web fonts if not overridden? clear UI contract. Local Font Access can disabled while standard CSS/canvas font family set fixed; fallback actual glyph coverage reported.
- webgpuMode disabled hides navigator.gpu / disallows adapter request consistently in page+worker; native leaves untouched. Do not forge hardware capabilities or shaders. GPU real emulation is outside JS route.

### T3 Transport
Pinned native BoringSSL client with streaming response and fixed browser TLS+HTTP2 impersonation for HTTP and WS where supported. profile selection explicit per-account, current Node path native default. Fixed origin allowlist remains, cookies use existing Jar, no native library cookie sharing, no direct fallback on failure. Capped uploads (25MiB existing), decoding header consistency, timeouts/cancel/backpressure and preserve duplicate Set-Cookie. API/UI expose actual engine and protocol differences. Verify local TLS ClientHello fingerprint differs from Node and selected template stable, HTTP2 negotiated, proxy auth routed only proxy, SOCKS tunnel actual, WS selected engine or explicit unsupported error.

### T4 Keepalive
New `SessionMaintenance` receives account read/list, cookie get/persist, transport callback, clock/timer hooks. per-account bounded mutex, one attempt per account, max2 concurrency, jitter+backoff, cancellation on disable/delete/clear/import/shutdown. Default off; no immediate uncontrolled all-account wake. Validate authenticated session body;401=>auth_expired no retry until user action,403=>blocked not auto-login,429=>retry-after capped, malformed200=>unknown. Optional wake only recognized sleeping VM and explicit flag. Persist last status/timestamps without raw tokens; actual cookie expiry only. Manual probe endpoint, read status endpoint, UI shows current validity vs last check vs next run separately. TCP WS heartbeat separate ping/pong with inactivity and cleanup.

### T5 Integration/review
Admin bearer/encoded paths unchanged, health includes transport availability no secrets. SSE coalesced statuses. Proper Node shutdown stop schedulers, worker scripts/resources not access admin token. Run baseline352+tests, full TS build, desktop/mobile worker/font/WebGPU/E2E, local TLS fixtures, live anonymous Muse read-only smoke; reviewer two scopes. Update docs sources/licenses/migration/limits, bump1.7, push fork and verify Server Docker + Android CI.
