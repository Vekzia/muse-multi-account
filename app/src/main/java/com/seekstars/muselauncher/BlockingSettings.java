package com.seekstars.muselauncher;

import android.content.Context;
import java.util.HashMap;
import java.util.Map;

/** UI-thread edits atomically publish a fully validated immutable request snapshot. */
public final class BlockingSettings {
    public static final String SAMPLE_DOMAINS = "# 示例广告 / 统计域名，可自行编辑\n"
            + "doubleclick.net\ngoogle-analytics.com\ngooglesyndication.com";
    private final KeyValueStore store;
    private boolean enabled;
    private String blocked;
    private String allowed;
    private volatile DomainRules snapshot;

    public BlockingSettings(Context context) {
        this(new SharedPreferencesStore(context.getApplicationContext(), "page_tools_blocking"));
    }

    public BlockingSettings(KeyValueStore store) {
        this.store = store;
        enabled = store.getBoolean("enabled", false);
        blocked = store.getString("blocked", SAMPLE_DOMAINS);
        allowed = store.getString("allowed", "");
        try { snapshot = DomainRules.parse(enabled, blocked, allowed); }
        catch (IllegalArgumentException e) {
            // Preserve editable corrupt text, but never enable a partially parsed rule set.
            enabled = false;
            snapshot = DomainRules.parse(false, "", "");
        }
    }

    public boolean isEnabled() { return enabled; }
    public String blockedText() { return blocked; }
    public String allowedText() { return allowed; }
    public DomainRules snapshot() { return snapshot; }

    public void save(boolean enabled, String blocked, String allowed) {
        String denied = blocked == null ? "" : blocked;
        String permitted = allowed == null ? "" : allowed;
        DomainRules next = DomainRules.parse(enabled, denied, permitted);
        Map<String, Object> values = new HashMap<>();
        values.put("enabled", enabled);
        values.put("blocked", denied);
        values.put("allowed", permitted);
        store.putAll(values);
        this.enabled = enabled;
        this.blocked = denied;
        this.allowed = permitted;
        snapshot = next;
    }
}
