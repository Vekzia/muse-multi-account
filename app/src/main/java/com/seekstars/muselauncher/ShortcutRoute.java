package com.seekstars.muselauncher;

import java.util.Map;

/** Pure release-only account selection route. Never interprets management/debug extras. */
public final class ShortcutRoute {
    public static final String ACTION_SWITCH_ACCOUNT =
            "com.seekstars.muselauncher.action.SWITCH_ACCOUNT";
    public static final String EXTRA_ACCOUNT_ID =
            "com.seekstars.muselauncher.extra.ACCOUNT_ID";
    public static final long INVALID_ID = -1L;

    private ShortcutRoute() { }

    public static long parse(String action, Object rawId) {
        if (!ACTION_SWITCH_ACCOUNT.equals(action)) return INVALID_ID;
        if (rawId instanceof Long || rawId instanceof Integer) {
            long id = ((Number) rawId).longValue();
            return id > 0 ? id : INVALID_ID;
        }
        if (!(rawId instanceof String)) return INVALID_ID;
        String text = (String) rawId;
        if (text.isEmpty() || text.length() > 19 || text.charAt(0) < '1' || text.charAt(0) > '9') {
            return INVALID_ID;
        }
        for (int i = 1; i < text.length(); i++) {
            if (text.charAt(i) < '0' || text.charAt(i) > '9') return INVALID_ID;
        }
        try {
            return Long.parseLong(text);
        } catch (NumberFormatException ignored) {
            return INVALID_ID;
        }
    }

    public static long parseExtras(String action, Map<String, ?> extras) {
        return parse(action, extras == null ? null : extras.get(EXTRA_ACCOUNT_ID));
    }

    /** Stable data separates launcher/PendingIntent identities even when extras differ. */
    public static String dataUri(long id) {
        if (id <= 0) throw new IllegalArgumentException("Account ID must be positive");
        return "muse-account://switch/" + id;
    }
}
