package com.seekstars.muselauncher;

import java.net.URI;
import java.util.Locale;

/** Pure validation shared by downloads, image links, history and tests. */
public final class DownloadPolicy {
    private DownloadPolicy() {}

    public static String normalizeUrl(String value) {
        if (value == null || value.length() > 16384 || value.matches("(?s).*[\\p{Cntrl}\\\\].*")
                || value.toLowerCase(Locale.ROOT).matches("(?s).*%(?:0[0-9a-f]|1[0-9a-f]|7f).*")) {
            throw new IllegalArgumentException("无效的下载地址");
        }
        try {
            URI uri = new URI(value);
            String scheme = uri.getScheme();
            if (!("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))
                    || uri.getRawUserInfo() != null || uri.getHost() == null || uri.getPort() > 65535
                    || uri.getPort() == 0) throw new IllegalArgumentException("仅支持 HTTP(S) 下载地址");
            String host = uri.getHost().toLowerCase(Locale.ROOT);
            if (!host.startsWith("[")) host = DomainRules.normalizeHost(host);
            String authority = host + (uri.getPort() < 0 ? "" : ":" + uri.getPort());
            String path = uri.getRawPath();
            return scheme.toLowerCase(Locale.ROOT) + "://" + authority
                    + (path == null || path.isEmpty() ? "/" : path)
                    + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery());
        } catch (Exception e) {
            throw new IllegalArgumentException("仅支持有效的 HTTP(S) 下载地址", e);
        }
    }

    /** CookieManager must be queried with the target URL, never the top-level page URL. */
    public static String cookieUrl(String value) { return normalizeUrl(value); }

    /** Do not persist signed query parameters or fragments in app history. */
    public static String historyUrl(String value) {
        String normalized = normalizeUrl(value);
        int query = normalized.indexOf('?');
        return query < 0 ? normalized : normalized.substring(0, query);
    }

    public static String sanitizeFilename(String value) {
        if (value == null || value.trim().isEmpty()) return "download";
        String result = value.replace('\\', '/');
        result = result.substring(result.lastIndexOf('/') + 1)
                .replaceAll("[\\p{Cntrl}\\p{Cf}<>:\"/\\\\|?*]", "_").trim();
        result = result.replaceAll("^[. ]+|[. ]+$", "");
        if (result.isEmpty()) return "download";
        if (result.length() > 120 || result.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 240) {
            int dot = result.lastIndexOf('.');
            String extension = dot > 0 && result.length() - dot <= 12 ? result.substring(dot) : "";
            String stem = extension.isEmpty() ? result : result.substring(0, dot);
            int end = Math.min(stem.length(), 120 - extension.length());
            if (end > 0 && Character.isHighSurrogate(stem.charAt(end - 1))) end--;
            while (end > 0 && (stem.substring(0, end) + extension)
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 240) {
                end = stem.offsetByCodePoints(end, -1);
            }
            result = stem.substring(0, end) + extension;
        }
        return result;
    }

    /**
     * DownloadManager follows redirects, so forward only a non-sensitive UA header.
     * In particular, never forward Cookie, Authorization, Referer, or proxy credentials.
     */
    public static java.util.Map<String, String> forwardedHeaders(java.util.Map<String, String> candidates) {
        java.util.LinkedHashMap<String, String> result = new java.util.LinkedHashMap<>();
        if (candidates != null) {
            for (java.util.Map.Entry<String, String> entry : candidates.entrySet()) {
                if (entry.getKey() != null && "user-agent".equalsIgnoreCase(entry.getKey())) {
                    String value = headerValue(entry.getValue());
                    if (value != null) result.put("User-Agent", value);
                    break;
                }
            }
        }
        return java.util.Collections.unmodifiableMap(result);
    }

    public static String headerValue(String value) {
        if (value == null || value.trim().isEmpty() || value.length() > 16384) return null;
        for (int i = 0; i < value.length(); i++) {
            if (Character.isISOControl(value.charAt(i))) return null;
        }
        return value;
    }
}
