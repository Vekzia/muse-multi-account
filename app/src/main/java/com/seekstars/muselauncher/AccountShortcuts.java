package com.seekstars.muselauncher;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Bundle;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Launcher shortcuts contain only an account ID and public display name. */
public final class AccountShortcuts {
    private static final String PREFIX = "muse_account_";

    private AccountShortcuts() { }

    public static Intent switchIntent(Context context, long accountId) {
        return new Intent(context, MainActivity.class)
                .setAction(ShortcutRoute.ACTION_SWITCH_ACCOUNT)
                .setData(Uri.parse(ShortcutRoute.dataUri(accountId)))
                .putExtra(ShortcutRoute.EXTRA_ACCOUNT_ID, accountId)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    }

    /** Android boundary adapter; malformed parcelled extras are invalid, never debug commands. */
    @SuppressWarnings("deprecation")
    public static long accountId(Intent intent) {
        if (intent == null || !ShortcutRoute.ACTION_SWITCH_ACCOUNT.equals(intent.getAction())) {
            return ShortcutRoute.INVALID_ID;
        }
        try {
            Bundle extras = intent.getExtras();
            return ShortcutRoute.parse(intent.getAction(),
                    extras == null ? null : extras.get(ShortcutRoute.EXTRA_ACCOUNT_ID));
        } catch (RuntimeException ignored) {
            return ShortcutRoute.INVALID_ID;
        }
    }

    public static void requestPin(Activity activity, Account account) {
        if (account == null || account.id <= 0 || new AccountsStore(activity).findById(account.id) == null) {
            toast(activity, R.string.qa_account_missing);
            return;
        }
        ShortcutManager manager = activity.getSystemService(ShortcutManager.class);
        try {
            if (manager == null || !manager.isRequestPinShortcutSupported()) {
                toast(activity, R.string.qa_pin_unsupported);
                return;
            }
            // This only asks the launcher: pinning still requires its native confirmation UI.
            boolean requested = manager.requestPinShortcut(build(activity, account), null);
            toast(activity, requested ? R.string.qa_pin_requested : R.string.qa_pin_failed);
        } catch (RuntimeException ignored) {
            toast(activity, R.string.qa_pin_failed);
        }
    }

    public static void disable(Context context, long id) {
        ShortcutManager manager = context.getSystemService(ShortcutManager.class);
        if (manager == null || id <= 0) return;
        try {
            manager.disableShortcuts(Collections.singletonList(PREFIX + id),
                    context.getString(R.string.qa_account_missing));
        } catch (RuntimeException ignored) {
            // The route itself still validates existence when launched.
        }
    }

    /** Call after rename/delete/import, and from the host's onResume. */
    public static void refresh(Context context) {
        ShortcutManager manager = context.getSystemService(ShortcutManager.class);
        if (manager == null) return;
        Map<Long, Account> accounts = new HashMap<>();
        for (Account account : new AccountsStore(context).all()) accounts.put(account.id, account);
        try {
            List<ShortcutInfo> updates = new ArrayList<>();
            List<String> enabled = new ArrayList<>();
            List<String> deleted = new ArrayList<>();
            for (ShortcutInfo pinned : manager.getPinnedShortcuts()) {
                String shortcutId = pinned.getId();
                if (!shortcutId.startsWith(PREFIX)) continue;
                long id = ShortcutRoute.parse(ShortcutRoute.ACTION_SWITCH_ACCOUNT,
                        shortcutId.substring(PREFIX.length()));
                Account account = accounts.get(id);
                if (account == null) deleted.add(shortcutId);
                else {
                    if (!pinned.isEnabled()) enabled.add(shortcutId);
                    // Avoid spending shortcut update quota on unchanged resume events.
                    if (!displayName(context, account).contentEquals(pinned.getShortLabel())
                            || !pinned.isEnabled()) updates.add(build(context, account));
                }
            }
            if (!deleted.isEmpty()) manager.disableShortcuts(deleted, context.getString(R.string.qa_account_missing));
            if (!enabled.isEmpty()) manager.enableShortcuts(enabled);
            if (!updates.isEmpty()) manager.updateShortcuts(updates);
        } catch (RuntimeException ignored) {
            // Launcher restrictions/rate limits must never interfere with in-app switching.
        }
    }

    static String displayName(Context context, Account account) {
        String name = account.name == null ? "" : account.name.trim();
        if (name.isEmpty()) return context.getString(R.string.qa_account_fallback, account.id);
        int count = name.codePointCount(0, name.length());
        return count > 40 ? name.substring(0, name.offsetByCodePoints(0, 40)) : name;
    }

    private static ShortcutInfo build(Context context, Account account) {
        String name = displayName(context, account);
        return new ShortcutInfo.Builder(context, PREFIX + account.id)
                .setShortLabel(name)
                .setLongLabel(context.getString(R.string.qa_switch_account, name))
                .setIcon(Icon.createWithResource(context, R.drawable.qa_ic_switch))
                .setIntent(switchIntent(context, account.id))
                .build();
    }

    private static void toast(Context context, int message) {
        Toast.makeText(context, message, Toast.LENGTH_LONG).show();
    }
}
