package com.seekstars.muselauncher;

/**
 * 每账号浏览器指纹隔离的执行层：UA 解析 + document-start 注入脚本生成（纯 Java，可单元测试）。
 *
 * 为什么必须在 document-start 注入：fingerprintjs / creepjs 这类脚本在页面一加载就先读一遍
 * navigator / Intl / canvas 并留档，等 onPageFinished 再改已经晚了，读到的是原生值。
 *
 * 为什么所有字符串都要过 jsString()：uaCustom 是自由文本，直接把 {@code </script>} 拼进脚本
 * 会提前闭合内联 script 块，等于把注入点送给页面；时区/语言虽然已被 Fingerprint.sanitize()
 * 限成字母数字，但两者共用一套转义，少写一条分支就少一个坑。
 *
 * 为什么同输入必须逐字节确定：加噪的语义是"同一账号稳定、不同账号不同"。一旦混进
 * Math.random() 或时间戳，同一账号每次加载的指纹都不一样，比不加噪更可疑。
 *
 * 为什么无覆写时返回 null：调用方据此整段跳过 evaluateJavascript，风控为零时零开销。
 */
final class FingerprintScript {

    private FingerprintScript() {
    }

    /** Chrome 131 桌面 Windows：安卓 WebView 原生 UA 带 Android/Mobile，改成桌面是最常见的一步 */
    static final String UA_PRESET_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

    /** Chrome 131 桌面 macOS：Intel 机型固定报 10_15_7，这是 Chrome 在 mac 上的真实写法 */
    static final String UA_PRESET_MACOS = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

    /** Chrome 131 安卓：保留 Mobile 段，Pixel 8 报 Android 14 与真实机型一致 */
    static final String UA_PRESET_ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) "
            + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

    /**
     * WebGL UNMASKED_VENDOR/RENDERER 的真实组合：同一台机器 vendor 与 renderer 必须成套，
     * 只改其中一个会出现"Google Inc. (Intel) + NVIDIA 显卡"这种一眼假的搭配。
     */
    private static final String[][] GPU_COMBOS = {
            {"Google Inc. (Intel)",
                    "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)"},
            {"Google Inc. (NVIDIA)",
                    "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)"},
            {"Google Inc. (AMD)",
                    "ANGLE (AMD, AMD Radeon RX 580 2048SP Direct3D11 vs_5_0 ps_5_0, D3D11)"},
            {"Google Inc. (Apple)", "ANGLE (Apple, Apple M1, OpenGL 4.1)"},
    };

    /** webdriver 时代留下的常见全局残留，存在就删，避免"看着不像自动化但还留着钩子" */
    private static final String[] AUTOMATION_MARKS = {
            "__webdriver_evaluate", "__selenium_evaluate", "__webdriver_script_function",
            "__webdriver_script_func", "__webdriver_script_fn", "__webdriver_unwrapped",
            "__driver_evaluate", "__driver_unwrapped", "__fxdriver_evaluate",
            "__selenium_unwrapped", "__fxdriver_unwrapped", "_Selenium_IDE_Recorder",
            "_selenium", "calledSelenium", "domAutomation", "domAutomationController",
    };

    /**
     * 返回最终 UA。
     * <p>
     * system 或 custom 为空时原样返回 systemUa；systemUa 为 null 说明取不到 WebView 的默认 UA，
     * 这时返回 "" 而不是 null —— 调用方据此跳过 setUserAgentString，避免把 "null" 写进请求头。
     */
    static String userAgent(Fingerprint fp, String systemUa) {
        String ua = userAgentForInject(fp);
        if (!ua.isEmpty()) return ua;
        return systemUa == null ? "" : systemUa;
    }

    /**
     * 是否需要注入。判定口径与 documentStartScript 完全一致：true 当且仅当脚本里确实有内容，
     * 所以调用方用本方法判断"要不要 evaluateJavascript"和"脚本是不是 null"不会打架。
     */
    static boolean hasOverrides(Fingerprint fp) {
        if (fp == null) return false;
        return fp.webdriver || fp.noise || fp.webrtc
                || !clean(fp.timezone).isEmpty()
                || !clean(fp.locale).isEmpty()
                || !userAgentForInject(fp).isEmpty();
    }

    /**
     * 构造 document-start 注入脚本，以 {@code (function(){}();} 包成单条表达式（Chrome 105+ 可解析）。
     *
     * @param accountId 加噪种子：同一账号每次进入都拿到同一套 canvas/WebGL/CPU 参数
     * @return 无任何覆写时返回 null，调用方直接跳过注入
     */
    static String documentStartScript(Fingerprint fp, long accountId) {
        if (!hasOverrides(fp)) return null;

        StringBuilder sb = new StringBuilder(6144);
        sb.append("(function(){\n");

        boolean needDp = !clean(fp.locale).isEmpty() || fp.webdriver || fp.noise;
        if (!userAgentForInject(fp).isEmpty()) appendUserAgent(sb, fp);
        if (needDp) appendDefineHelper(sb);
        if (!clean(fp.timezone).isEmpty()) appendTimezone(sb, clean(fp.timezone));
        if (!clean(fp.locale).isEmpty()) appendLocale(sb, clean(fp.locale));
        if (fp.webdriver) appendWebdriver(sb);
        if (fp.noise) appendNoise(sb, accountId);
        if (fp.webrtc) appendWebrtc(sb);

        sb.append("})();\n");
        return sb.toString();
    }

    // ------------------------------------------------------------------ UA

    /**
     * 只写 navigator.userAgent：请求头的 UA 由 WebView 的 setUserAgentString 负责，
     * 两边取值必须同源，否则站点把 navigator.userAgent 与 User-Agent 请求头一比就露。
     */
    private static void appendUserAgent(StringBuilder sb, Fingerprint fp) {
        sb.append("// userAgent\n");
        sb.append("var _ua = ").append(jsString(userAgentForInject(fp))).append(";\n");
        sb.append("try { Object.defineProperty(Navigator.prototype, \"userAgent\", { get: function(){ return _ua; }, ")
                .append("configurable: true, enumerable: true }); } catch (e) {}\n");
        // 原型上改不到时（个别引擎把 userAgent 定义在实例上）才补一次实例属性，
        // 否则不去制造 own property —— 检测脚本会拿 getOwnPropertyDescriptor 找这种痕迹。
        sb.append("try { if (navigator.userAgent !== _ua) { Object.defineProperty(navigator, \"userAgent\", ")
                .append("{ get: function(){ return _ua; }, configurable: true }); } } catch (e) {}\n");
    }

    // -------------------------------------------------------------- 公共件

    /** locale / webdriver / hardwareConcurrency 共用：defineProperty 上 getter，失败就静默放弃 */
    private static void appendDefineHelper(StringBuilder sb) {
        sb.append("// shared define helper\n");
        sb.append("var _dp = function(target, name, value){\n");
        sb.append("  try { Object.defineProperty(target, name, { get: function(){ return value; }, ")
                .append("configurable: true, enumerable: true }); } catch (e) {}\n");
        sb.append("};\n");
    }

    // ------------------------------------------------------------- 1. 时区

    /**
     * 时区覆写：Intl 与 Date 两套 API 必须同时改。只改 Intl 时 getTimezoneOffset() 仍报系统值，
     * 只改 Date 时 resolvedOptions().timeZone 仍报系统值，两者交叉比对立刻暴露。
     */
    private static void appendTimezone(StringBuilder sb, String tz) {
        sb.append("// timezone\n");
        sb.append("var _tz = ").append(jsString(tz)).append(";\n");
        sb.append("var _ntdf = (typeof Intl !== \"undefined\" && Intl.DateTimeFormat) ? Intl.DateTimeFormat : null;\n");
        // 非法 IANA 名（旧 WebView 的 tzdata 缺条目）会让每个 Intl 调用都抛 RangeError，
        // 把整页脚本带崩；所以先试建一个实例，不行就整段放弃，回落到系统时区。
        sb.append("var _tzOk = false;\n");
        sb.append("if (_ntdf) { try { new _ntdf(\"en-US\", { timeZone: _tz }); _tzOk = true; } catch (e) { _tzOk = false; } }\n");
        sb.append("if (_tzOk) {\n");

        // 偏移只算一次并缓存：getTimezoneOffset 会在渲染循环里被反复调用，每次都建 formatter 太贵。
        sb.append("  var _off = new Date().getTimezoneOffset();\n");
        sb.append("  try {\n");
        sb.append("    var _fmt = new _ntdf(\"en-US\", { timeZone: _tz, timeZoneName: \"longOffset\" });\n");
        sb.append("    var _raw = \"\";\n");
        sb.append("    if (_fmt.formatToParts) {\n");
        sb.append("      var _parts = _fmt.formatToParts(new Date(0));\n");
        sb.append("      for (var _i = 0; _i < _parts.length; _i++) {\n");
        sb.append("        if (_parts[_i].type === \"timeZoneName\") { _raw = _parts[_i].value; }\n");
        sb.append("      }\n");
        sb.append("    } else {\n");
        sb.append("      _raw = _fmt.format(new Date(0));\n");
        sb.append("    }\n");
        // longOffset 的形态是 GMT+08:00 / GMT-05:00（也有极少数环境给 GMT+8），手工解析，
        // 不用正则字面量 —— 正则里的括号和量词会干扰静态括号配平自检。
        sb.append("    var _g = _raw.indexOf(\"GMT\");\n");
        sb.append("    if (_g >= 0) {\n");
        sb.append("      var _body = _raw.substring(_g + 3);\n");
        sb.append("      var _neg = _body.charAt(0) === \"-\";\n");
        sb.append("      if (_neg || _body.charAt(0) === \"+\") { _body = _body.substring(1); }\n");
        sb.append("      var _c = _body.indexOf(\":\");\n");
        sb.append("      var _h = 0;\n");
        sb.append("      var _m = 0;\n");
        sb.append("      if (_c > 0) {\n");
        sb.append("        _h = parseInt(_body.substring(0, _c), 10);\n");
        sb.append("        _m = parseInt(_body.substring(_c + 1, _c + 3), 10);\n");
        sb.append("      } else if (_body.length > 0) {\n");
        sb.append("        _h = parseInt(_body, 10);\n");
        sb.append("      }\n");
        // JS 语义：getTimezoneOffset() 返回 UTC - 本地，所以东八区是 -480，方向取反。
        sb.append("      if (!isNaN(_h) && !isNaN(_m)) { _off = (_neg ? 1 : -1) * (_h * 60 + _m); }\n");
        sb.append("    }\n");
        sb.append("  } catch (e) {}\n");
        sb.append("  if (!_off) { _off = 0; }\n");
        sb.append("  Date.prototype.getTimezoneOffset = function(){ return _off; };\n");

        // 只覆盖"没显式指定时区"的实例：页面写 new Intl.DateTimeFormat('en-US',{timeZone:'UTC'})
        // 却读到 Asia/Shanghai，比不覆写还容易被判成伪造。判据是它报的时区等于注入时的系统时区。
        sb.append("  var _sysTz = \"\";\n");
        sb.append("  try { _sysTz = new _ntdf().resolvedOptions().timeZone; } catch (e) {}\n");
        sb.append("  var _rd = _ntdf.prototype.resolvedOptions;\n");
        sb.append("  _ntdf.prototype.resolvedOptions = function(){\n");
        sb.append("    var r = _rd.call(this);\n");
        sb.append("    try { if (r && r.timeZone === _sysTz && r.timeZone !== _tz) { r.timeZone = _tz; } } catch (e) {}\n");
        sb.append("    return r;\n");
        sb.append("  };\n");

        // 默认时区选项：toLocale* 与构造器共用，避免两处各复制一份 options 而漂移。
        sb.append("  var _opts = function(options){\n");
        sb.append("    var o = {};\n");
        sb.append("    if (options) {\n");
        sb.append("      for (var k in options) {\n");
        sb.append("        if (Object.prototype.hasOwnProperty.call(options, k)) { o[k] = options[k]; }\n");
        sb.append("      }\n");
        sb.append("    }\n");
        sb.append("    if (typeof o.timeZone === \"undefined\") { o.timeZone = _tz; }\n");
        sb.append("    return o;\n");
        sb.append("  };\n");

        // 构造器包装成普通函数：new 与不带 new 的调用都落到原生实现，实例是真正的
        // Intl.DateTimeFormat，instanceof 与 formatToParts 都不受影响。
        sb.append("  var _dtf = function(locales, options){ return new _ntdf(locales, _opts(options)); };\n");
        sb.append("  _dtf.prototype = _ntdf.prototype;\n");
        sb.append("  _dtf.supportedLocalesOf = _ntdf.supportedLocalesOf;\n");
        sb.append("  try {\n");
        sb.append("    Object.defineProperty(Intl, \"DateTimeFormat\", { value: _dtf, writable: true, configurable: true });\n");
        sb.append("  } catch (e) { try { Intl.DateTimeFormat = _dtf; } catch (e2) {} }\n");

        sb.append("  var _tls = Date.prototype.toLocaleString;\n");
        sb.append("  Date.prototype.toLocaleString = function(locales, options){ return _tls.call(this, locales, _opts(options)); };\n");
        sb.append("  var _tld = Date.prototype.toLocaleDateString;\n");
        sb.append("  Date.prototype.toLocaleDateString = function(locales, options){ return _tld.call(this, locales, _opts(options)); };\n");
        sb.append("  var _tlt = Date.prototype.toLocaleTimeString;\n");
        sb.append("  Date.prototype.toLocaleTimeString = function(locales, options){ return _tlt.call(this, locales, _opts(options)); };\n");
        sb.append("}\n");
    }

    // ------------------------------------------------------------- 2. 语言

    /**
     * 语言覆写：写到 Navigator.prototype 而不是实例上，因为检测脚本常直接读
     * {@code Navigator.prototype.language}（或用 iframe 内的 navigator 反向验证原型是否被动过）。
     */
    private static void appendLocale(StringBuilder sb, String locale) {
        sb.append("// locale\n");
        sb.append("var _lang = ").append(jsString(locale)).append(";\n");
        // languages 固定返回同一个数组实例：原生实现也返回稳定对象，
        // 每次给新数组的话，navigator.languages === navigator.languages 会变成 false。
        sb.append("var _langs = [_lang];\n");
        sb.append("_dp(Navigator.prototype, \"language\", _lang);\n");
        sb.append("_dp(Navigator.prototype, \"languages\", _langs);\n");
        sb.append("try { if (navigator.language !== _lang) { Object.defineProperty(navigator, \"language\", ")
                .append("{ get: function(){ return _lang; }, configurable: true }); } } catch (e) {}\n");
        // 语言与时区在 Intl 里是同一个对象，且时区段可能已经包过 resolvedOptions；
        // 这里再包一层，两段互相独立，谁没开都能单独工作。
        sb.append("if (typeof Intl !== \"undefined\" && Intl.DateTimeFormat) {\n");
        // 同 resolvedOptions 的时区处理：只改"默认构造"出来的实例。
        // 显式 new Intl.DateTimeFormat('ja-JP') 却报 zh-CN，本身就是一处可被检测的矛盾。
        sb.append("  var _sysLang = \"\";\n");
        sb.append("  try { _sysLang = new Intl.DateTimeFormat().resolvedOptions().locale; } catch (e) {}\n");
        sb.append("  var _rdl = Intl.DateTimeFormat.prototype.resolvedOptions;\n");
        sb.append("  Intl.DateTimeFormat.prototype.resolvedOptions = function(){\n");
        sb.append("    var r = _rdl.call(this);\n");
        sb.append("    try { if (r && r.locale === _sysLang && r.locale !== _lang) { r.locale = _lang; } } catch (e) {}\n");
        sb.append("    return r;\n");
        sb.append("  };\n");
        sb.append("}\n");
    }

    // ------------------------------------------------------- 3. 自动化标记

    /**
     * 自动化标记：webdriver 先改原型再兜底实例，随后清掉 window 上的常见残留。
     * 只删自己存在的键，且每个 key 单独 try —— 有些页面把 window 属性设成只读，删不掉也不能让整段崩。
     */
    private static void appendWebdriver(StringBuilder sb) {
        sb.append("// webdriver\n");
        sb.append("_dp(Navigator.prototype, \"webdriver\", false);\n");
        sb.append("try { if (navigator.webdriver !== false) { Object.defineProperty(navigator, \"webdriver\", ")
                .append("{ get: function(){ return false; }, configurable: true }); } } catch (e) {}\n");
        sb.append("var _mk = [");
        for (int i = 0; i < AUTOMATION_MARKS.length; i++) {
            if (i > 0) sb.append(", ");
            sb.append(jsString(AUTOMATION_MARKS[i]));
        }
        sb.append("];\n");
        sb.append("for (var _x = 0; _x < _mk.length; _x++) {\n");
        sb.append("  try { if (_mk[_x] in window) { delete window[_mk[_x]]; } } catch (e) {}\n");
        sb.append("}\n");
    }

    // ------------------------------------------------------------- 4. 加噪

    /**
     * 加噪：seed 固定 → 同一账号每次得到同一组显卡/CPU 参数，换账号才变。
     * 噪声量控制在"改一个像素通道 ±1"这种级别：够让 hash 变化，又不影响页面自己读像素。
     */
    private static void appendNoise(StringBuilder sb, long accountId) {
        // mulberry32 的状态是 32 位整数；accountId 是 long，先把高低 32 位折在一起，
        // 否则超过 2^31 的 id 在 JS 里会走浮点，右移结果不可预期。
        int seed = (int) (accountId ^ (accountId >>> 32));
        sb.append("// noise\n");
        sb.append("var _seed = ").append(seed & 0xFFFFFFFFL).append(";\n");
        sb.append("var _rnd = function(){\n");
        sb.append("  _seed = _seed + 0x6D2B79F5 | 0;\n");
        sb.append("  var t = Math.imul(_seed ^ _seed >>> 15, 1 | _seed);\n");
        sb.append("  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;\n");
        sb.append("  return ((t ^ t >>> 14) >>> 0) / 4294967296;\n");
        sb.append("};\n");

        // 只包 getImageData：toDataURL / toBlob 是浏览器从同一块 canvas 像素导出的，
        // 像素被改过它们自己就变了，再包一层纯属多此一举还容易和页面抢原型。
        sb.append("if (window.CanvasRenderingContext2D) {\n");
        sb.append("  var _gid = CanvasRenderingContext2D.prototype.getImageData;\n");
        sb.append("  CanvasRenderingContext2D.prototype.getImageData = function(){\n");
        sb.append("    var d = _gid.apply(this, arguments);\n");
        sb.append("    try {\n");
        sb.append("      if (d && d.data && d.data.length >= 4) {\n");
        // 最后一个像素的 R 通道 ±1：取值只取决于当前像素值，所以同一画面反复读结果一致；
        // 255 时回退 1 而不是溢出成 0，避免出现纯黑/纯白的绝对边界。
        sb.append("        var i = d.data.length - 4;\n");
        sb.append("        d.data[i] = d.data[i] === 255 ? 254 : d.data[i] + 1;\n");
        sb.append("      }\n");
        sb.append("    } catch (e) {}\n");
        sb.append("    return d;\n");
        sb.append("  };\n");
        sb.append("}\n");

        sb.append("var _gpus = [");
        for (int i = 0; i < GPU_COMBOS.length; i++) {
            if (i > 0) sb.append(", ");
            sb.append("[").append(jsString(GPU_COMBOS[i][0])).append(", ")
                    .append(jsString(GPU_COMBOS[i][1])).append("]");
        }
        sb.append("];\n");
        sb.append("var _gpu = _gpus[Math.floor(_rnd() * _gpus.length)];\n");
        // 37445/37446 之外一律交给原生，避免 getParameter 的行为出现别的偏差。
        sb.append("var _gp = function(native){\n");
        sb.append("  return function(param){\n");
        sb.append("    if (param === 37445) { return _gpu[0]; }\n");
        sb.append("    if (param === 37446) { return _gpu[1]; }\n");
        sb.append("    return native.apply(this, arguments);\n");
        sb.append("  };\n");
        sb.append("};\n");
        // WebGL2 继承自 WebGL 的取值语义，两者都要包，只包一个会让 WebGL2 页面读到系统值。
        sb.append("if (window.WebGLRenderingContext) {\n");
        sb.append("  WebGLRenderingContext.prototype.getParameter = _gp(WebGLRenderingContext.prototype.getParameter);\n");
        sb.append("}\n");
        sb.append("if (window.WebGL2RenderingContext) {\n");
        sb.append("  WebGL2RenderingContext.prototype.getParameter = _gp(WebGL2RenderingContext.prototype.getParameter);\n");
        sb.append("}\n");

        sb.append("var _hc = [4, 8, 12, 16][Math.floor(_rnd() * 4)];\n");
        sb.append("var _dm = [4, 8][Math.floor(_rnd() * 2)];\n");
        sb.append("_dp(Navigator.prototype, \"hardwareConcurrency\", _hc);\n");
        sb.append("_dp(Navigator.prototype, \"deviceMemory\", _dm);\n");
    }

    // ------------------------------------------------------------ 5. WebRTC

    /**
     * WebRTC 内网 IP 防护：以 capture 阶段监听 icecandidate，遇到 typ host 就 stopImmediatePropagation，
     * 页面注册的 listener 永远收不到这条候选，拿不到 192.168.x.x / 10.x 这类内网地址。
     * <p>
     * 局限（有意保留，别指望它挡全部）：createOffer 生成的 SDP 里可能已经写了 host 候选行，
     * 本脚本不重写 SDP，所以只挡"候选事件"这一路。要挡 SDP 得改 createOffer/createAnswer 的
     * 返回值，成本高且容易和真实实现产生差异。
     */
    private static void appendWebrtc(StringBuilder sb) {
        sb.append("// webrtc\n");
        sb.append("var _PC = window.RTCPeerConnection || window.webkitRTCPeerConnection;\n");
        sb.append("if (_PC) {\n");
        sb.append("  var _wrapped = function(config, constraints){\n");
        sb.append("    var pc = new _PC(config, constraints);\n");
        sb.append("    try {\n");
        sb.append("      pc.addEventListener(\"icecandidate\", function(ev){\n");
        sb.append("        var c = ev && ev.candidate && ev.candidate.candidate;\n");
        // 只丢 host 候选：srflx/relay 是走 STUN/TURN 得到的公网映射，丢掉反而会让连通性异常。
        sb.append("        if (typeof c === \"string\" && c.indexOf(\"typ host\") >= 0) { ev.stopImmediatePropagation(); }\n");
        sb.append("      }, true);\n");
        sb.append("    } catch (e) {}\n");
        sb.append("    return pc;\n");
        sb.append("  };\n");
        // 原型指向原生，instanceof 与原生方法都还在；name/length 尽量对齐，减少 toString 层面的差异。
        sb.append("  _wrapped.prototype = _PC.prototype;\n");
        sb.append("  try { Object.defineProperty(_wrapped, \"name\", { value: \"RTCPeerConnection\", configurable: true }); } catch (e) {}\n");
        sb.append("  try { Object.defineProperty(_wrapped, \"length\", { value: _PC.length, configurable: true }); } catch (e) {}\n");
        sb.append("  window.RTCPeerConnection = _wrapped;\n");
        sb.append("  if (window.webkitRTCPeerConnection) { window.webkitRTCPeerConnection = _wrapped; }\n");
        sb.append("}\n");
    }

    // ------------------------------------------------------------- 工具

    /**
     * 解析"要直写进脚本"的 UA：system、或 custom 但为空，都返回 "" 表示交给 WebView 设置。
     * 单独抽出来是为了让 userAgent() 与 hasOverrides() 用同一份判定，不会两边不一致。
     */
    private static String userAgentForInject(Fingerprint fp) {
        if (fp == null) return "";
        String mode = fp.uaMode == null ? Fingerprint.UA_SYSTEM : fp.uaMode;
        switch (mode) {
            case Fingerprint.UA_WINDOWS:
                return UA_PRESET_WINDOWS;
            case Fingerprint.UA_MACOS:
                return UA_PRESET_MACOS;
            case Fingerprint.UA_ANDROID:
                return UA_PRESET_ANDROID;
            case Fingerprint.UA_CUSTOM:
                return clean(fp.uaCustom);
            default:
                return "";
        }
    }

    /** null 与纯空白都当空值：空白时区会让 Intl 直接抛 RangeError，整段注入都白做 */
    private static String clean(String v) {
        return v == null ? "" : v.trim();
    }

    /**
     * 转成双引号 JS 字符串字面量（含引号）。
     * <p>
     * 除了常规的 \ " ' 与换行，还转义 U+2028/U+2029（它们在 ES2019 之前不能出现在字面量里）
     * 和尖括号：{@code <} 一律写成 U+003C 转义，保证任何位置都不会出现裸 {@code </script}。
     */
    private static String jsString(String s) {
        if (s == null) s = "";
        StringBuilder out = new StringBuilder(s.length() + 16);
        out.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '\\':
                    out.append("\\\\");
                    break;
                case '"':
                    out.append("\\\"");
                    break;
                case '\'':
                    out.append("\\'");
                    break;
                case '\n':
                    out.append("\\n");
                    break;
                case '\r':
                    out.append("\\r");
                    break;
                case '\t':
                    out.append("\\t");
                    break;
                case '\u2028':
                    out.append("\\u2028");
                    break;
                case '\u2029':
                    out.append("\\u2029");
                    break;
                case '<':
                    out.append("\\u003c");
                    break;
                case '>':
                    out.append("\\u003e");
                    break;
                default:
                    if (c < 0x20 || c == 0x7f) {
                        // 其余控制字符统一走 U+00XX 转义，避免拼出无法解析的字面量
                        String hex = Integer.toHexString(c);
                        out.append("\\u");
                        for (int k = hex.length(); k < 4; k++) out.append('0');
                        out.append(hex);
                    } else {
                        out.append(c);
                    }
            }
        }
        out.append('"');
        return out.toString();
    }
}
