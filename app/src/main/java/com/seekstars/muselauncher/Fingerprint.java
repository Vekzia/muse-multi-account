package com.seekstars.muselauncher;

/**
 * 每个账号的浏览器指纹配置。空字符串 / UA_SYSTEM 表示跟随系统，不覆写。
 *
 * 设计约束：本类只放数据与常量，不做任何 Android 调用，
 * 便于 AccountJsonCodec 序列化和单元测试；真正的 JS 覆写逻辑在 FingerprintScript。
 */
public class Fingerprint {

    /** UA 预设：跟随系统 WebView / 桌面 Windows Chrome / 桌面 macOS Chrome / 安卓 Chrome / 自定义 */
    public static final String UA_SYSTEM = "system";
    public static final String UA_WINDOWS = "windows";
    public static final String UA_MACOS = "macos";
    public static final String UA_ANDROID = "android";
    public static final String UA_CUSTOM = "custom";

    /** UA 预设，见 UA_* 常量 */
    public String uaMode = UA_SYSTEM;

    /** uaMode == custom 时使用；为空则回退系统 UA */
    public String uaCustom = "";

    /** IANA 时区名（如 Asia/Shanghai），空 = 跟随系统 */
    public String timezone = "";

    /** BCP-47 语言标签（如 en-US），空 = 跟随系统 */
    public String locale = "";

    /** 屏蔽 navigator.webdriver 等自动化标记 */
    public boolean webdriver;

    /** Canvas / WebGL / Audio 指纹加噪（同一账号稳定、不同账号不同） */
    public boolean noise;

    /** 阻止 WebRTC 暴露内网 IP（改写 RTCPeerConnection 的候选地址） */
    public boolean webrtc;

    public Fingerprint() {
    }

    /** 是否配了任何一项覆写；false 时完全走系统默认（零性能开销） */
    public boolean anyOverride() {
        return webdriver || noise || webrtc
                || (timezone != null && !timezone.isEmpty())
                || (locale != null && !locale.isEmpty())
                || !UA_SYSTEM.equals(uaMode);
    }

    /** 深拷贝，导入备份时避免共享同一实例 */
    public Fingerprint copy() {
        Fingerprint f = new Fingerprint();
        f.uaMode = uaMode;
        f.uaCustom = uaCustom;
        f.timezone = timezone;
        f.locale = locale;
        f.webdriver = webdriver;
        f.noise = noise;
        f.webrtc = webrtc;
        return f;
    }

    /** 校验并回落非法值：未知 UA 预设回 system，时区/语言做基本字符校验 */
    public void sanitize() {
        if (uaMode == null) uaMode = UA_SYSTEM;
        switch (uaMode) {
            case UA_SYSTEM:
            case UA_WINDOWS:
            case UA_MACOS:
            case UA_ANDROID:
            case UA_CUSTOM:
                break;
            default:
                uaMode = UA_SYSTEM;
        }
        if (uaCustom == null) uaCustom = "";
        if (uaCustom.length() > 512) uaCustom = uaCustom.substring(0, 512);
        timezone = sanitizeToken(timezone, 64);
        locale = sanitizeToken(locale, 35);
    }

    /** 仅允许字母数字与 / _ - . + ，防止把注入内容塞进 JS 字符串字面量 */
    private static String sanitizeToken(String v, int maxLen) {
        if (v == null) return "";
        StringBuilder sb = new StringBuilder(v.length());
        for (int i = 0; i < v.length() && sb.length() < maxLen; i++) {
            char c = v.charAt(i);
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                    || c == '/' || c == '_' || c == '-' || c == '.' || c == '+') {
                sb.append(c);
            }
        }
        return sb.toString();
    }
}
