package com.seekstars.muselauncher;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** 指纹脚本：UA 解析 + document-start 注入脚本的结构、确定性、注入安全 */
public class FingerprintScriptTest {

    /** Java 源码里的反斜杠-u 是编译期转义，这里用拼接绕开，保证拿到的是字面量 "\\u003c" 这六个字符 */
    private static final String ESC_LT = "\\" + "u003c";
    private static final String ESC_GT = "\\" + "u003e";

    private static final String WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    private static final String MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    private static final String DROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) "
            + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

    // ------------------------------------------------------------------ UA

    @Test
    public void windowsPresetIsFullChromeUa() {
        Fingerprint f = new Fingerprint();
        f.uaMode = Fingerprint.UA_WINDOWS;
        String ua = FingerprintScript.userAgent(f, "Native/Android");
        assertEquals(WIN_UA, ua);
        assertTrue(ua.contains("Windows NT 10.0"));
    }

    @Test
    public void macosPresetIsFullChromeUa() {
        Fingerprint f = new Fingerprint();
        f.uaMode = Fingerprint.UA_MACOS;
        String ua = FingerprintScript.userAgent(f, "Native/Android");
        assertEquals(MAC_UA, ua);
        assertTrue(ua.contains("Macintosh"));
    }

    @Test
    public void androidPresetIsFullChromeUa() {
        Fingerprint f = new Fingerprint();
        f.uaMode = Fingerprint.UA_ANDROID;
        String ua = FingerprintScript.userAgent(f, "Native/Android");
        assertEquals(DROID_UA, ua);
        assertTrue(ua.contains("Android 14"));
        assertTrue(ua.contains("Mobile Safari"));
    }

    @Test
    public void systemModePassesSystemUaThrough() {
        Fingerprint f = new Fingerprint();
        assertEquals("WebView/9.9", FingerprintScript.userAgent(f, "WebView/9.9"));
        // null systemUa：调用方据此跳过 setUserAgentString，不能返回 "null"
        assertEquals("", FingerprintScript.userAgent(f, null));
        // 预设优先于 systemUa，即使 systemUa 为 null 也照给预设
        f.uaMode = Fingerprint.UA_ANDROID;
        assertEquals(DROID_UA, FingerprintScript.userAgent(f, null));
        // fp 为 null 时退化成"跟随系统"
        assertEquals("X/1.0", FingerprintScript.userAgent(null, "X/1.0"));
    }

    @Test
    public void customUaWinsOverSystem() {
        Fingerprint f = new Fingerprint();
        f.uaMode = Fingerprint.UA_CUSTOM;
        f.uaCustom = "Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0.0.0 Safari/537.36";
        assertEquals("Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0.0.0 Safari/537.36",
                FingerprintScript.userAgent(f, "Native/Android"));
        // 前后空白要 trim，否则会带着空格进请求头
        f.uaCustom = "  Custom UA  ";
        assertEquals("Custom UA", FingerprintScript.userAgent(f, "Native/Android"));
    }

    @Test
    public void customEmptyFallsBackToSystem() {
        Fingerprint f = new Fingerprint();
        f.uaMode = Fingerprint.UA_CUSTOM;
        f.uaCustom = "";
        assertEquals("Native/Android", FingerprintScript.userAgent(f, "Native/Android"));
        f.uaCustom = "   ";
        assertEquals("Native/Android", FingerprintScript.userAgent(f, "Native/Android"));
        assertEquals("", FingerprintScript.userAgent(f, null));
        // custom 但空 = 完全没覆写，不该注入
        assertFalse(FingerprintScript.hasOverrides(f));
        assertNull(FingerprintScript.documentStartScript(f, 1L));
    }

    // ----------------------------------------------------------- 脚本总闸

    @Test
    public void noOverridesReturnsNullScript() {
        Fingerprint f = new Fingerprint();
        assertFalse(FingerprintScript.hasOverrides(f));
        assertNull(FingerprintScript.documentStartScript(f, 1L));
        assertNull(FingerprintScript.documentStartScript(null, 1L));
        assertFalse(FingerprintScript.hasOverrides(null));
    }

    @Test
    public void hasOverridesCoversEverySwitch() {
        Fingerprint f = new Fingerprint();
        assertFalse(FingerprintScript.hasOverrides(f));

        f.webdriver = true;
        assertTrue(FingerprintScript.hasOverrides(f));
        f.webdriver = false;
        assertFalse(FingerprintScript.hasOverrides(f));

        f.noise = true;
        assertTrue(FingerprintScript.hasOverrides(f));
        f.noise = false;

        f.webrtc = true;
        assertTrue(FingerprintScript.hasOverrides(f));
        f.webrtc = false;

        f.timezone = "Asia/Shanghai";
        assertTrue(FingerprintScript.hasOverrides(f));
        f.timezone = "  ";
        assertFalse(FingerprintScript.hasOverrides(f));

        f.locale = "ja-JP";
        assertTrue(FingerprintScript.hasOverrides(f));
        f.locale = "";
        assertFalse(FingerprintScript.hasOverrides(f));

        f.uaMode = Fingerprint.UA_MACOS;
        assertTrue(FingerprintScript.hasOverrides(f));
        f.uaMode = Fingerprint.UA_CUSTOM;
        assertFalse(FingerprintScript.hasOverrides(f));
        f.uaCustom = "x";
        assertTrue(FingerprintScript.hasOverrides(f));
        f.uaCustom = "";
        f.uaMode = Fingerprint.UA_SYSTEM;
        assertFalse(FingerprintScript.hasOverrides(f));
    }

    // ------------------------------------------------------------ 各注入点

    @Test
    public void timezoneOnlyInjectsIntlAndDateButNothingElse() {
        Fingerprint f = new Fingerprint();
        f.timezone = "America/Argentina/Buenos_Aires";
        String js = FingerprintScript.documentStartScript(f, 1L);
        assertNotNull(js);
        // 时区名必须原样出现（含 / 与 _），且经过字面量包裹
        assertTrue(js.contains("\"America/Argentina/Buenos_Aires\""));
        assertTrue(js.contains("longOffset"));
        assertTrue(js.contains("getTimezoneOffset"));
        assertTrue(js.contains("resolvedOptions"));
        assertTrue(js.contains("toLocaleDateString"));
        assertTrue(js.contains("toLocaleTimeString"));
        assertTrue(js.contains("supportedLocalesOf"));
        // 其它注入点不该被顺带打开
        assertFalse(js.contains("RTCPeerConnection"));
        assertFalse(js.contains("getImageData"));
        assertFalse(js.contains("webdriver"));
        assertWellFormedScript(js);
    }

    @Test
    public void localeOnlyInjectsNavigatorAndIntlLocale() {
        Fingerprint f = new Fingerprint();
        f.locale = "en-GB";
        String js = FingerprintScript.documentStartScript(f, 1L);
        assertNotNull(js);
        assertTrue(js.contains("\"en-GB\""));
        assertTrue(js.contains("Navigator.prototype"));
        assertTrue(js.contains("languages"));
        assertTrue(js.contains("resolvedOptions"));
        // 没开时区就不该出现时区解析那套
        assertFalse(js.contains("longOffset"));
        assertFalse(js.contains("getTimezoneOffset"));
        assertFalse(js.contains("RTCPeerConnection"));
        assertFalse(js.contains("getImageData"));
        assertWellFormedScript(js);
    }

    @Test
    public void webdriverOnlyHidesFlagAndClearsMarks() {
        Fingerprint f = new Fingerprint();
        f.webdriver = true;
        String js = FingerprintScript.documentStartScript(f, 1L);
        assertNotNull(js);
        assertTrue(js.contains("\"webdriver\""));
        assertTrue(js.contains("__webdriver_evaluate"));
        assertTrue(js.contains("__selenium_evaluate"));
        assertTrue(js.contains("domAutomationController"));
        assertTrue(js.contains("delete window["));
        assertFalse(js.contains("RTCPeerConnection"));
        assertFalse(js.contains("longOffset"));
        assertWellFormedScript(js);
    }

    @Test
    public void noiseOnlyWrapsCanvasWebglAndHardware() {
        Fingerprint f = new Fingerprint();
        f.noise = true;
        String js = FingerprintScript.documentStartScript(f, 1L);
        assertNotNull(js);
        assertTrue(js.contains("getImageData"));
        assertTrue(js.contains("37445"));
        assertTrue(js.contains("37446"));
        assertTrue(js.contains("hardwareConcurrency"));
        assertTrue(js.contains("deviceMemory"));
        // 必须是自实现的 mulberry32，不能借 Math.random 当种子
        assertTrue(js.contains("Math.imul"));
        assertFalse(js.contains("Math.random"));
        assertFalse(js.contains("RTCPeerConnection"));
        assertFalse(js.contains("getTimezoneOffset"));
        assertWellFormedScript(js);
    }

    @Test
    public void webrtcOnlyWrapsPeerConnection() {
        Fingerprint f = new Fingerprint();
        f.webrtc = true;
        String js = FingerprintScript.documentStartScript(f, 1L);
        assertNotNull(js);
        assertTrue(js.contains("RTCPeerConnection"));
        assertTrue(js.contains("webkitRTCPeerConnection"));
        assertTrue(js.contains("stopImmediatePropagation"));
        assertTrue(js.contains("typ host"));
        assertTrue(js.contains("icecandidate"));
        // 只挡候选事件，不做时区/语言那一套
        assertFalse(js.contains("longOffset"));
        assertFalse(js.contains("getTimezoneOffset"));
        assertFalse(js.contains("getImageData"));
        assertWellFormedScript(js);
    }

    @Test
    public void allOnScriptContainsEverySection() {
        String js = FingerprintScript.documentStartScript(allOn(), 7L);
        assertNotNull(js);
        assertTrue(js.contains("var _ua = "));
        assertTrue(js.contains("Asia/Shanghai"));
        assertTrue(js.contains("zh-CN"));
        assertTrue(js.contains("\"webdriver\""));
        assertTrue(js.contains("getImageData"));
        assertTrue(js.contains("RTCPeerConnection"));
        assertWellFormedScript(js);
    }

    // ------------------------------------------------------------- 确定性

    @Test
    public void sameInputProducesByteIdenticalScript() {
        Fingerprint f = allOn();
        String a = FingerprintScript.documentStartScript(f, 42L);
        String b = FingerprintScript.documentStartScript(f, 42L);
        assertEquals(a, b);
        // copy() 出来的等价实例也必须一致，否则导入备份后指纹会漂
        assertEquals(a, FingerprintScript.documentStartScript(f.copy(), 42L));
    }

    @Test
    public void accountIdChangesNoise() {
        Fingerprint f = new Fingerprint();
        f.noise = true;
        String a = FingerprintScript.documentStartScript(f, 1L);
        String b = FingerprintScript.documentStartScript(f, 2L);
        assertNotEquals(a, b);
        // 种子落在脚本里，重新加载同账号还是一样
        assertTrue(a.contains("_seed = "));
        assertEquals(a, FingerprintScript.documentStartScript(f, 1L));
        // 只换 accountId、不开 noise：脚本必须完全相同，说明别的段没有偷用种子
        Fingerprint tzOnly = new Fingerprint();
        tzOnly.timezone = "Asia/Shanghai";
        assertEquals(FingerprintScript.documentStartScript(tzOnly, 1L),
                FingerprintScript.documentStartScript(tzOnly, 999L));
    }

    // --------------------------------------------------------- 注入安全

    @Test
    public void uaCustomCannotBreakOutOfScriptLiteral() {
        Fingerprint f = new Fingerprint();
        f.uaMode = Fingerprint.UA_CUSTOM;
        f.uaCustom = "a\"b</script><script>alert(1)</script>";
        f.timezone = "Asia/Shanghai";
        String js = FingerprintScript.documentStartScript(f, 11L);
        assertNotNull(js);

        // 1) 任何位置都不能出现裸闭合标签
        assertFalse(js.contains("</script"));
        assertFalse(js.toLowerCase().contains("</script"));
        assertFalse(js.contains("<script>"));
        // 2) 尖括号与引号都被转义成可解析的字面量内容
        String escaped = "a\\\"b" + ESC_LT + "/script" + ESC_GT + ESC_LT + "script" + ESC_GT
                + "alert(1)" + ESC_LT + "/script" + ESC_GT;
        assertTrue("UA 应被完整转义后嵌入：" + escaped, js.contains(escaped));
        // 3) 把转义标记抹掉后仍不能出现裸闭合标签
        assertFalse(js.replace(ESC_LT, "").contains("</script"));
        // 4) 引号成对，没有半截字面量把后面的代码吞成字符串
        assertEquals(0, countUnescapedQuotes(js) % 2);
        assertWellFormedScript(js);
    }

    @Test
    public void controlCharsAndLineSeparatorsAreEscaped() {
        Fingerprint f = new Fingerprint();
        f.uaMode = Fingerprint.UA_CUSTOM;
        f.uaCustom = "line1\nline2\r\u2028\u2029\ttail\\end";
        String js = FingerprintScript.documentStartScript(f, 1L);
        assertNotNull(js);
        assertTrue(js.contains("line1\\nline2\\r"));
        assertFalse("没有尖括号就不该出现 \\u003c 转义", js.contains(ESC_LT));
        // U+2028/2029 必须转义，ES2019 之前的引擎会把裸字符当行终止符，字面量直接断裂
        assertFalse(js.indexOf('\u2028') >= 0);
        assertFalse(js.indexOf('\u2029') >= 0);
        assertTrue(js.contains("\\u2028"));
        assertTrue(js.contains("\\u2029"));
        assertTrue(js.contains("tail\\\\end"));
        assertWellFormedScript(js);
    }

    // --------------------------------------------------------------- 工具

    private static Fingerprint allOn() {
        Fingerprint f = new Fingerprint();
        f.uaMode = Fingerprint.UA_WINDOWS;
        f.timezone = "Asia/Shanghai";
        f.locale = "zh-CN";
        f.webdriver = true;
        f.noise = true;
        f.webrtc = true;
        return f;
    }

    /** 语法完整体检：外层包装、去字面量后的括号配平、引号成对 */
    private static void assertWellFormedScript(String js) {
        assertTrue("脚本必须以 IIFE 开头", js.startsWith("(function(){"));
        assertTrue("脚本必须以 IIFE 调用结尾", js.trim().endsWith("})();"));

        String bare = stripStringLiterals(js);
        assertEquals("花括号不配平", count(bare, '{'), count(bare, '}'));
        assertEquals("圆括号不配平", count(bare, '('), count(bare, ')'));
        assertEquals("方括号不配平", count(bare, '['), count(bare, ']'));
        assertDepthNeverNegative(bare, '{', '}');
        assertDepthNeverNegative(bare, '(', ')');
        assertDepthNeverNegative(bare, '[', ']');
        assertEquals("引号必须成对", 0, countUnescapedQuotes(js) % 2);
        // 生成的脚本里不该出现裸的行终止符以外的意外：至少不能有 </script
        assertFalse(js.contains("</script"));
    }

    /** 去掉 "..."、'...'、`...` 里的一切（含转义对），剩下的才是结构性字符 */
    private static String stripStringLiterals(String js) {
        StringBuilder out = new StringBuilder(js.length());
        char quote = 0;
        for (int i = 0; i < js.length(); i++) {
            char c = js.charAt(i);
            if (quote != 0) {
                if (c == '\\') {
                    i++; // 跳过被转义的字符，避免把 \" 当成闭合
                    continue;
                }
                if (c == quote) quote = 0;
                continue;
            }
            if (c == '"' || c == '\'' || c == '`') {
                quote = c;
                out.append(' ');
                continue;
            }
            out.append(c);
        }
        return out.toString();
    }

    private static int count(String s, char c) {
        int n = 0;
        for (int i = 0; i < s.length(); i++) {
            if (s.charAt(i) == c) n++;
        }
        return n;
    }

    private static int countUnescapedQuotes(String s) {
        int n = 0;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '\\') {
                i++;
                continue;
            }
            if (c == '"') n++;
        }
        return n;
    }

    private static void assertDepthNeverNegative(String s, char open, char close) {
        int depth = 0;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == open) depth++;
            if (c == close) depth--;
            assertTrue("出现提前闭合：" + close + " @ " + i, depth >= 0);
        }
        assertEquals("深度未归零：" + open, 0, depth);
    }
}
