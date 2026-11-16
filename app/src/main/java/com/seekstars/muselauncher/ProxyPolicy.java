package com.seekstars.muselauncher;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** Proxy runtime/save/cleanup policies, independent of Android. */
final class ProxyPolicy {
    private ProxyPolicy() { }

    /** Empty means system network; null means reject without changing the current override. */
    static String rule(String raw) {
        String value = ProxyPool.normalize(raw);
        if (value.isEmpty()) return "";
        if (!ProxyPool.isValid(value) || value.indexOf('@') >= 0) return null;
        int split = value.indexOf("://");
        String scheme = value.substring(0, split).toLowerCase(Locale.ROOT);
        // AndroidX ProxyConfig supports HTTP, HTTPS and SOCKS5, not SOCKS4/userinfo.
        if (!scheme.equals("http") && !scheme.equals("https") && !scheme.equals("socks5")) return null;
        return scheme + value.substring(split);
    }

    static String display(String raw) {
        String value = ProxyPool.normalize(raw);
        if (value.isEmpty()) return "[system network]";
        if (!ProxyPool.isValid(value)) return "[invalid proxy]";
        int at = value.lastIndexOf('@');
        return at < 0 ? value : value.substring(0, value.indexOf("://") + 3) + "***@" + value.substring(at + 1);
    }

    /** Keep a newly edited current proxy; removing an unchanged current entry from the pool selects its first item. */
    static String savedActive(String edited, String original, List<String> pool) {
        String active = ProxyPool.normalize(edited);
        if (!active.isEmpty() && rule(active) == null) return null;
        boolean editedActive = !active.equals(ProxyPool.normalize(original));
        if (!pool.isEmpty() && (active.isEmpty()
                || (!editedActive && ProxyPool.indexOf(pool, active) < 0))) active = pool.get(0);
        return rule(active) == null ? null : active;
    }

    static final class Cleanup {
        final List<String> kept;
        final String active;
        final int removed;
        Cleanup(List<String> kept, String active, int removed) {
            this.kept = kept;
            this.active = active;
            this.removed = removed;
        }
    }

    static Cleanup cleanup(List<String> pool, String active, Set<String> failed) {
        List<String> before = pool == null ? new ArrayList<>() : new ArrayList<>(pool);
        List<String> kept = new ArrayList<>();
        for (String proxy : before) {
            if (failed == null || !failed.contains(ProxyPool.normalize(proxy))) kept.add(proxy);
        }
        if (kept.isEmpty() || kept.size() == before.size()) return new Cleanup(before, active, 0);
        String selected = ProxyPool.indexOf(kept, active) >= 0 ? active : kept.get(0);
        return new Cleanup(kept, selected, before.size() - kept.size());
    }
}
