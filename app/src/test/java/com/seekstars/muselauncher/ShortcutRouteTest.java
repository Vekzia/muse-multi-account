package com.seekstars.muselauncher;

import org.junit.Test;

import java.util.HashMap;
import java.util.Map;

import static org.junit.Assert.*;

public class ShortcutRouteTest {
    // A relaxed action check would turn arbitrary/debug commands into release routes.
    @Test public void acceptsOnlyDedicatedSwitchAction() {
        assertEquals(42L, ShortcutRoute.parse(ShortcutRoute.ACTION_SWITCH_ACCOUNT, 42L));
        assertEquals(-1L, ShortcutRoute.parse(null, 42L));
        assertEquals(-1L, ShortcutRoute.parse("android.intent.action.MAIN", 42L));
        assertEquals(-1L, ShortcutRoute.parse("delete_account", 42L));
        assertEquals(-1L, ShortcutRoute.parse("reset_all", 42L));
        assertEquals(-1L, ShortcutRoute.parse(ShortcutRoute.ACTION_SWITCH_ACCOUNT + " ", 42L));
    }

    // Missing positive/range/type validation could switch the wrong account or throw.
    @Test public void rejectsMalformedAndNonPositiveIds() {
        Object[] invalid = {null, 0L, -1L, Long.MIN_VALUE, "", "0", "-1", "+1",
                " 1", "1 ", "01", "1.0", "1e3", "9223372036854775808", "１",
                "1;delete_account", 1.5d, true, new Object()};
        for (Object value : invalid) {
            assertEquals("Malformed id: " + value, -1L,
                    ShortcutRoute.parse(ShortcutRoute.ACTION_SWITCH_ACCOUNT, value));
        }
    }

    @Test public void preservesWholePositiveLongRange() {
        assertEquals(1L, ShortcutRoute.parse(ShortcutRoute.ACTION_SWITCH_ACCOUNT, 1));
        assertEquals(9876543210L, ShortcutRoute.parse(ShortcutRoute.ACTION_SWITCH_ACCOUNT, "9876543210"));
        assertEquals(Long.MAX_VALUE,
                ShortcutRoute.parse(ShortcutRoute.ACTION_SWITCH_ACCOUNT, "9223372036854775807"));
    }

    // Reading a legacy key would expose debug management through a release entry point.
    @Test public void ignoresAllDebugAndDestructiveExtras() {
        Map<String, Object> extras = new HashMap<>();
        extras.put("start_account", 9L);
        extras.put("delete_account", 2L);
        extras.put("clear_accounts", true);
        extras.put("dump_auth", true);
        extras.put("show_drawer", true);
        assertEquals(-1L, ShortcutRoute.parseExtras(ShortcutRoute.ACTION_SWITCH_ACCOUNT, extras));
        extras.put(ShortcutRoute.EXTRA_ACCOUNT_ID, 3L);
        assertEquals(3L, ShortcutRoute.parseExtras(ShortcutRoute.ACTION_SWITCH_ACCOUNT, extras));
        assertEquals(-1L, ShortcutRoute.parseExtras("delete_account", extras));
        assertEquals(-1L, ShortcutRoute.parseExtras(ShortcutRoute.ACTION_SWITCH_ACCOUNT, null));
    }

    // Equality of data across accounts lets PendingIntent/launcher identity collide.
    @Test public void buildsUniqueCanonicalDataForEachAccount() {
        assertEquals("muse-account://switch/1", ShortcutRoute.dataUri(1L));
        assertEquals("muse-account://switch/9223372036854775807", ShortcutRoute.dataUri(Long.MAX_VALUE));
        assertNotEquals(ShortcutRoute.dataUri(1L), ShortcutRoute.dataUri(2L));
    }

    @Test(expected = IllegalArgumentException.class)
    public void neverBuildsRouteForInvalidAccount() {
        ShortcutRoute.dataUri(0L);
    }
}
