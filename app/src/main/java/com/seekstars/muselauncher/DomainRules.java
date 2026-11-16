package com.seekstars.muselauncher;

import java.net.IDN;
import java.net.URI;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;

/** Immutable, DNS-free rules safe to read from WebView request threads. */
public final class DomainRules {
    private final boolean enabled;
    private final Set<String> blocked;
    private final Set<String> allowed;

    private DomainRules(boolean enabled, Set<String> blocked, Set<String> allowed) {
        this.enabled = enabled;
        this.blocked = Collections.unmodifiableSet(new LinkedHashSet<>(blocked));
        this.allowed = Collections.unmodifiableSet(new LinkedHashSet<>(allowed));
    }

    public static DomainRules parse(boolean enabled, String blocked, String allowed) {
        return new DomainRules(enabled, parseHosts(blocked), parseHosts(allowed));
    }

    public boolean shouldBlock(String url, boolean mainFrame) {
        if (!enabled || mainFrame || url == null) return false;
        try {
            URI uri = new URI(url);
            if (!("http".equalsIgnoreCase(uri.getScheme()) || "https".equalsIgnoreCase(uri.getScheme()))) return false;
            String host = normalizeHost(uri.getHost());
            return !matches(allowed, host) && matches(blocked, host);
        } catch (Exception ignored) {
            return false;
        }
    }

    private static boolean matches(Set<String> rules, String host) {
        if (rules.contains(host)) return true;
        for (int dot = host.indexOf('.'); dot >= 0; dot = host.indexOf('.', dot + 1)) {
            if (rules.contains(host.substring(dot + 1))) return true;
        }
        return false;
    }

    private static Set<String> parseHosts(String text) {
        Set<String> hosts = new LinkedHashSet<>();
        if (text == null || text.trim().isEmpty()) return hosts;
        if (text.length() > 100_000) throw new IllegalArgumentException("规则文本超过 100000 字符");
        String[] lines = text.split("\\R", -1);
        for (int line = 0; line < lines.length; line++) {
            String content = lines[line].split("#", 2)[0].trim();
            if (content.isEmpty()) continue;
            String[] parts = content.split("\\s+");
            int start = parts.length > 1 && isHostsAddress(parts[0]) ? 1 : 0;
            if (parts.length > 1 && start == 0) throw invalidLine(line);
            try {
                for (int i = start; i < parts.length; i++) hosts.add(normalizeHost(parts[i]));
            } catch (IllegalArgumentException e) {
                throw invalidLine(line);
            }
        }
        return hosts;
    }

    private static IllegalArgumentException invalidLine(int zeroBased) {
        return new IllegalArgumentException("第 " + (zeroBased + 1) + " 行：请输入主机名或 IP + 主机名的 hosts 行");
    }

    private static boolean isHostsAddress(String value) {
        if (value.contains(":")) {
            try { return new URI("http://[" + value + "]/").getHost() != null; }
            catch (Exception e) { return false; }
        }
        String[] octets = value.split("\\.", -1);
        if (octets.length != 4) return false;
        for (String octet : octets) {
            if (!octet.matches("[0-9]{1,3}") || Integer.parseInt(octet) > 255) return false;
        }
        return true;
    }

    static String normalizeHost(String input) {
        if (input == null || input.isEmpty()) throw new IllegalArgumentException("缺少主机名");
        String host = IDN.toASCII(input, IDN.USE_STD3_ASCII_RULES).toLowerCase(Locale.ROOT);
        if (host.endsWith(".")) host = host.substring(0, host.length() - 1);
        if (host.isEmpty() || host.length() > 253) throw new IllegalArgumentException("主机名长度错误");
        for (String label : host.split("\\.", -1)) {
            if (label.length() > 63 || !label.matches("[a-z0-9](?:[a-z0-9-]*[a-z0-9])?")) {
                throw new IllegalArgumentException("主机名格式错误");
            }
        }
        return host;
    }
}
