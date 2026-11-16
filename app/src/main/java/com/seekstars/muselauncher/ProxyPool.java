package com.seekstars.muselauncher;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;

/**
 * 每账号代理池：地址归一化、合法性校验、多行文本解析、失败轮换、优先级合并。
 *
 * <p>为什么单独抽一个不依赖 android.* 的纯 Java 类：
 * <ol>
 *   <li>同一套规则原先分散在 {@code ProxyHelper.normalize} 与配置页的文本处理里，
 *       规则漂移会直接造成"测活用的是 A、实际生效的是 B"这种很难复现的问题；</li>
 *   <li>WebView 的 {@code ProxyController} 在 JVM 上不可用，把规则放在这里才能在单元测试里
 *       把端口范围、IPv6、全角分隔符这些边界逐个钉死，而不是靠真机点一遍；</li>
 *   <li>池的轮换必须可预测——去重保序 + 失败后从下一条环形推进，
 *       账号切换时才不会出现"永远卡在同一条坏代理"的死循环。</li>
 * </ol>
 *
 * <p>线程模型：全部是无状态静态方法，入参一律不持有引用（返回新 {@link ArrayList}），
 * 因此可以在任意线程调用，也不需要加锁。
 */
final class ProxyPool {

    /** 合法 scheme，带 {@code ://}，全部小写；比较时对输入做小写化，输出保留调用方原始大小写 */
    private static final String[] SCHEMES = {"http://", "https://", "socks4://", "socks5://"};

    /**
     * 池文本的拆分符：换行、回车、半角/全角逗号、半角/全角分号、制表符、连续空格（含全角空格）。
     * 用户在配置页粘贴的来源五花八门，与其要求"一行一条"不如尽量宽容。
     */
    private static final String SEPARATORS = "[\\s,，;；\\u3000]+";

    private ProxyPool() {
    }

    /**
     * 补 scheme（默认 http）、trim、去掉内部空白；空输入返回 ""。
     *
     * <p>与 {@code ProxyHelper.normalize} 的旧行为对齐：已带 scheme 的输入原样返回（不强制小写，
     * 因为日志和配置回显里保留用户写法更好核对）。额外修正两点旧实现会出问题的地方：
     * null 不再 NPE；{@code "127.0.0.1 : 7890"} 这类手敲空格会被清掉，
     * 否则 {@code ProxyConfig.Builder.addProxyRule} 会静默丢弃整条规则。
     */
    static String normalize(String p) {
        String s = stripSpace(p);
        if (s.isEmpty()) return "";
        String lower = s.toLowerCase(Locale.ROOT);
        for (String scheme : SCHEMES) {
            if (lower.startsWith(scheme)) return s;
        }
        return "http://" + s;
    }

    /**
     * 是否是一条可交给 {@code ProxyConfig} 的代理规则：先 normalize 再判断。
     *
     * <p>拒绝带路径/查询串的写法（{@code http://1.2.3.4:80/path}）：ProxyConfig 只认 host:port，
     * 带路径的规则会被忽略，后果是"看着配了代理其实没走"，所以宁可在这里直接判非法让界面报错。
     */
    static boolean isValid(String p) {
        String n = normalize(p);
        if (n.isEmpty()) return false;
        int si = n.indexOf("://");
        if (si <= 0) return false;
        String scheme = n.substring(0, si).toLowerCase(Locale.ROOT);
        if (!"http".equals(scheme) && !"https".equals(scheme)
                && !"socks4".equals(scheme) && !"socks5".equals(scheme)) {
            return false;
        }
        String authority = n.substring(si + 3);
        if (authority.isEmpty()) return false;
        if (authority.indexOf('/') >= 0 || authority.indexOf('?') >= 0
                || authority.indexOf('#') >= 0) {
            return false;
        }

        // 凭证在最后一个 '@' 之前：密码里允许出现 {@code @} 的写法在 URL 里本来就要转义，
        // 这里按"凭证段内不得再有 @"处理，避免 u@x@host 这种半截地址被当成合法。
        String hostPort = authority;
        int at = authority.lastIndexOf('@');
        if (at >= 0) {
            String creds = authority.substring(0, at);
            if (creds.indexOf('@') >= 0) return false;
            hostPort = authority.substring(at + 1);
        }
        if (hostPort.isEmpty()) return false;

        String host;
        String port;
        if (hostPort.charAt(0) == '[') {
            // IPv6 必须用方括号，否则末端冒号无法与端口区分
            int end = hostPort.indexOf(']');
            if (end < 0) return false;
            host = hostPort.substring(1, end);
            String rest = hostPort.substring(end + 1);
            if (!rest.startsWith(":")) return false;
            port = rest.substring(1);
            if (!isIpv6Body(host)) return false;
        } else {
            int colon = hostPort.lastIndexOf(':');
            if (colon < 0) return false;
            host = hostPort.substring(0, colon);
            port = hostPort.substring(colon + 1);
            // 没加方括号的 IPv6（如 ::1:1080）在这里会残留冒号，按非法处理
            if (host.indexOf(':') >= 0 || host.isEmpty()) return false;
            if (!isHostBody(host)) return false;
        }
        return isPort(port, host.isEmpty());
    }

    /**
     * 拆分 → normalize → 过滤非法 → 去重保序。
     *
     * <p>去重必须保序：池的顺序就是优先级，用户把"最稳的那条"写在第一行是这个功能的隐含契约。
     */
    static List<String> parse(String raw) {
        if (raw == null) return new ArrayList<>();
        return clean(new ArrayList<>(Arrays.asList(raw.split(SEPARATORS))));
    }

    /**
     * 池内环形取下一条，跳过 {@code failed} 自己。
     *
     * @return 池空 / 只有 failed 自己时返回 null；{@code failed} 为空或不在池中时返回第一条
     */
    static String next(List<String> pool, String failed) {
        if (pool == null || pool.isEmpty()) return null;
        String f = normalize(failed);
        if (f.isEmpty()) return first(pool);
        int idx = indexOf(pool, f);
        if (idx < 0) return first(pool);
        int size = pool.size();
        for (int step = 1; step <= size; step++) {
            String candidate = pool.get((idx + step) % size);
            if (candidate == null) continue;
            if (!normalize(candidate).equals(f)) return candidate;
        }
        return null;
    }

    /**
     * 精确定位，但两边都先 normalize。
     *
     * <p>不归一化就会把 {@code 127.0.0.1:7890} 与 {@code http://127.0.0.1:7890} 当成两条，
     * 表现为"从池里点了下一条，结果还是同一条"。
     *
     * @return 下标，找不到（含 pool 为 null）返回 -1
     */
    static int indexOf(List<String> pool, String proxy) {
        if (pool == null || pool.isEmpty()) return -1;
        String target = normalize(proxy);
        if (target.isEmpty()) return -1;
        for (int i = 0; i < pool.size(); i++) {
            if (target.equals(normalize(pool.get(i)))) return i;
        }
        return -1;
    }

    /** 池首条，空池返回 null */
    static String first(List<String> pool) {
        if (pool == null || pool.isEmpty()) return null;
        return pool.get(0);
    }

    /** 用换行拼接，供配置页多行编辑框回填；空项跳过，避免回填出一堆空行 */
    static String join(List<String> pool) {
        if (pool == null || pool.isEmpty()) return "";
        StringBuilder sb = new StringBuilder();
        for (String p : pool) {
            if (p == null) continue;
            String t = p.trim();
            if (t.isEmpty()) continue;
            if (sb.length() > 0) sb.append('\n');
            sb.append(t);
        }
        return sb.toString();
    }

    /**
     * 保证 {@code activeProxy} 在首位，其余按原顺序去重。
     *
     * <p>配置页从池里选中某一条后要立刻生效，所以不能只靠"池顺序"——用户可能编辑了池但没重排，
     * 这里把当前生效项提到最前面，界面回填与运行时的第一优先级才对得上。
     *
     * @return active 为空或非法时返回 {@code parse(join(pool))} 的等价结果（仅清洗，不重排）
     */
    static List<String> merge(List<String> pool, String activeProxy) {
        List<String> rest = clean(pool);
        String active = normalize(activeProxy);
        // 非法 active 不能占首位：否则池首会是一条永远连不上的地址，轮换第一步就卡住
        if (!isValid(active)) return rest;
        List<String> out = new ArrayList<>(rest.size() + 1);
        out.add(active);
        for (String p : rest) {
            if (!p.equals(active)) out.add(p);
        }
        return out;
    }

    // ---------- 内部工具 ----------

    /** 去掉首尾与内部所有空白；null 视为空串 */
    private static String stripSpace(String p) {
        if (p == null) return "";
        String t = p.trim();
        if (t.isEmpty()) return "";
        StringBuilder sb = new StringBuilder(t.length());
        for (int i = 0; i < t.length(); i++) {
            char c = t.charAt(i);
            if (!Character.isWhitespace(c)) sb.append(c);
        }
        return sb.toString();
    }

    /** normalize + isValid + 去重保序，返回可修改的 ArrayList */
    private static List<String> clean(List<String> pool) {
        List<String> out = new ArrayList<>();
        if (pool == null || pool.isEmpty()) return out;
        LinkedHashSet<String> seen = new LinkedHashSet<>();
        for (String p : pool) {
            String n = normalize(p);
            if (!isValid(n)) continue;
            if (seen.add(n)) out.add(n);
        }
        return out;
    }

    private static boolean isHostBody(String host) {
        if (host.isEmpty()) return false;
        for (int i = 0; i < host.length(); i++) {
            char c = host.charAt(i);
            if (Character.isLetterOrDigit(c)) continue; // 允许中文等 IDN 域名
            if (c == '-' || c == '.' || c == '_') continue;
            return false;
        }
        return true;
    }

    private static boolean isIpv6Body(String host) {
        if (host.isEmpty() || host.indexOf(':') < 0) return false;
        for (int i = 0; i < host.length(); i++) {
            char c = host.charAt(i);
            boolean hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
            // 允许 ::ffff:1.2.3.4 这种内嵌 IPv4 的写法
            if (hex || c == ':' || c == '.') continue;
            return false;
        }
        return true;
    }

    /** 纯数字且在 1..65535；长度先卡 5 位，避免 parseInt 溢出 */
    private static boolean isPort(String port, boolean hostEmpty) {
        if (hostEmpty || port == null || port.isEmpty() || port.length() > 5) return false;
        for (int i = 0; i < port.length(); i++) {
            char c = port.charAt(i);
            if (c < '0' || c > '9') return false;
        }
        int v = Integer.parseInt(port);
        return v >= 1 && v <= 65535;
    }
}
