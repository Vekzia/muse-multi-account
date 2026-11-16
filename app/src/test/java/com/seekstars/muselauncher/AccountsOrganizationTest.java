package com.seekstars.muselauncher;

import org.json.JSONObject;
import org.junit.Test;
import java.util.List;
import java.util.Arrays;
import java.util.stream.Collectors;
import static org.junit.Assert.*;

/** Organization metadata must survive both local storage and portable backups. */
public class AccountsOrganizationTest {
    @Test public void oldJsonDefaultsAndSortPreferenceAreCompatible() {
        AccountsStoreTest.FakeKv kv = new AccountsStoreTest.FakeKv();
        kv.putString("list", "[{\"id\":7,\"name\":\"Old\"}]");
        AccountsStore store = new AccountsStore(kv);
        Account old = store.findById(7);
        assertEquals("", old.group);
        assertFalse(old.pinned);
        assertEquals(0, old.lastUsedAt);
        assertEquals("manual", store.getSortMode());
        store.setSortMode("recent");
        assertEquals("recent", new AccountsStore(kv).getSortMode());
        store.setSortMode("bad");
        assertEquals("manual", store.getSortMode());
        assertTrue(store.addDefault().id > 7);
    }

    @Test public void backupCopyImportPreservesMetadataAndNeverReusesLocalIds() {
        AccountsStoreTest.FakeKv kv = new AccountsStoreTest.FakeKv();
        kv.putString("list", "[{\"id\":40,\"name\":\"Old\"}]");
        kv.putLong("nextId", 1L); // stale metadata must not collide with existing profiles
        AccountsStore store = new AccountsStore(kv);
        Account source = new Account(40, "Imported");
        source.group = "Team";
        source.pinned = true;
        source.lastUsedAt = 333L;
        source.tags.add("tag");
        BackupCodec.Snapshot backup = BackupCodec.parse(BackupCodec.toJson(Arrays.asList(source), null, 20L));
        AccountsStore.ImportOutcome out = store.importAccounts(backup.accounts, true);
        long id = out.idMap.get(40L);
        assertTrue(id > 40);
        assertEquals(Arrays.asList(40L), out.removedIds);
        Account restored = new AccountsStore(kv).findById(id);
        assertEquals("Team", restored.group);
        assertTrue(restored.pinned);
        assertEquals(333L, restored.lastUsedAt);
        Account snapshot = store.snapshot().get(0);
        assertEquals("Team", snapshot.group);
        assertTrue(snapshot.pinned);
        assertEquals(333L, snapshot.lastUsedAt);
        snapshot.tags.clear();
        snapshot.group = "Other";
        assertEquals("Team", store.findById(id).group);
        assertEquals(Arrays.asList("tag"), store.findById(id).tags);
        assertTrue(store.addDefault().id > id);
    }

    @Test public void importNormalizesMissingGroupAndPreservesEveryValidAccount() {
        AccountsStoreTest.FakeKv kv = new AccountsStoreTest.FakeKv();
        AccountsStore store = new AccountsStore(kv);
        Account first = new Account(8, "First");
        first.group = null;
        Account second = new Account(9, "Second");
        second.group = " Team ";
        second.lastUsedAt = -1;
        AccountsStore.ImportOutcome out = store.importAccounts(Arrays.asList(first, second), false);
        assertEquals(2, out.added);
        assertNotEquals(out.idMap.get(8L), out.idMap.get(9L));
        assertEquals("", store.findById(out.idMap.get(8L)).group);
        assertEquals("Team", store.findById(out.idMap.get(9L)).group);
        assertEquals(0, store.findById(out.idMap.get(9L)).lastUsedAt);
        assertEquals(2, new AccountsStore(kv).all().size());
    }

    @Test public void replacingWithEmptyBackupClearsAccountsAndGroupsButNullIsNoOp() {
        AccountsStoreTest.FakeKv kv = new AccountsStoreTest.FakeKv();
        AccountsStore store = new AccountsStore(kv);
        long id = store.addDefault().id;
        store.createGroup("Old");
        store.assignGroup(id, "Old");
        assertTrue(store.importAccounts(null, true).removedIds.isEmpty());
        assertEquals(1, store.all().size());
        assertEquals(Arrays.asList(id), store.importAccounts(java.util.Collections.emptyList(), true).removedIds);
        AccountsStore reopened = new AccountsStore(kv);
        assertTrue(reopened.all().isEmpty());
        assertTrue(reopened.getGroups().isEmpty());
        assertEquals(-1, reopened.getCurrentId());
        assertTrue(reopened.addDefault().id > id);
    }

    @Test public void replacementDoesNotRetainOldEmptyGroups() {
        AccountsStore store = new AccountsStore(new AccountsStoreTest.FakeKv());
        store.createGroup("Old");
        Account imported = new Account(7, "Imported");
        imported.group = "New";
        store.importAccounts(Arrays.asList(imported), true);
        assertEquals(Arrays.asList("New"), store.getGroups());
    }

    @Test public void groupsPersistWhenEmptyAndRenameDeletePreserveAccounts() {
        AccountsStoreTest.FakeKv kv = new AccountsStoreTest.FakeKv();
        AccountsStore store = new AccountsStore(kv);
        long a = store.addDefault().id;
        long b = store.addDefault().id;
        assertTrue(store.createGroup(" Work "));
        assertFalse(store.createGroup("Work"));
        assertFalse(store.createGroup(" "));
        assertFalse(store.createGroup("1234567890123456789012345"));
        assertEquals(Arrays.asList("Work"), new AccountsStore(kv).getGroups());
        store.assignGroup(a, "Work");
        store.assignGroup(b, "Work");
        assertTrue(store.renameGroup("Work", "Team"));
        assertEquals("Team", new AccountsStore(kv).findById(a).group);
        store.createGroup("Other");
        assertFalse(store.renameGroup("Team", "Other"));
        store.deleteGroup("Team");
        AccountsStore reopened = new AccountsStore(kv);
        assertEquals(Arrays.asList(a, b), ids(reopened.all()));
        assertEquals("", reopened.findById(a).group);
        assertEquals("", reopened.findById(b).group);
        assertEquals(Arrays.asList("Other"), reopened.getGroups());
    }

    @Test public void pinAndUsagePersistWithoutChangingSetCurrentSemantics() {
        AccountsStoreTest.FakeKv kv = new AccountsStoreTest.FakeKv();
        AccountsStore store = new AccountsStore(kv);
        long a = store.addDefault().id;
        store.addDefault();
        String before = kv.getString("list", null);
        store.setCurrent(a);
        assertEquals(before, kv.getString("list", null));
        assertEquals(0L, store.findById(a).lastUsedAt);
        store.markUsed(a, 100L);
        store.setPinned(a, true);
        AccountsStore reopened = new AccountsStore(kv);
        assertEquals(100L, reopened.findById(a).lastUsedAt);
        assertTrue(reopened.findById(a).pinned);
        assertEquals(a, reopened.getCurrentId());
    }

    @Test public void filteredMovePreservesHiddenSlotsAndPinnedPartitionAfterReload() {
        AccountsStoreTest.FakeKv kv = new AccountsStoreTest.FakeKv();
        AccountsStore store = new AccountsStore(kv);
        for (int i = 0; i < 5; i++) store.addDefault();
        store.setPinned(4L, true);
        assertTrue(store.moveBefore(5L, 1L, Arrays.asList(1L, 3L, 4L, 5L)));
        assertEquals(Arrays.asList(5L, 2L, 1L, 4L, 3L), ids(new AccountsStore(kv).all()));
        assertFalse(store.moveBefore(5L, 4L, Arrays.asList(5L, 4L)));
        assertFalse(store.moveBefore(5L, 2L, Arrays.asList(5L, 3L)));
        assertTrue(store.moveBefore(5L, -1L, Arrays.asList(5L, 1L, 3L)));
        assertEquals(Arrays.asList(1L, 2L, 3L, 4L, 5L), ids(store.all()));
        store.setSortMode("name");
        assertFalse(store.moveBefore(5L, 1L));
    }

    private static List<Long> ids(List<Account> accounts) {
        return accounts.stream().map(a -> a.id).collect(Collectors.toList());
    }

    @Test public void organizationFieldsSurviveLocalAndBackupRoundTrips() throws Exception {
        String raw = "[{\"id\":7,\"name\":\"Work\",\"group\":\"Team\",\"pinned\":true,\"lastUsedAt\":12345}]";
        List<Account> accounts = AccountJsonCodec.fromJsonOrNull(raw);
        JSONObject local = new org.json.JSONArray(AccountJsonCodec.toJson(accounts)).getJSONObject(0);
        assertEquals("Team", local.optString("group"));
        assertTrue(local.optBoolean("pinned"));
        assertEquals(12345L, local.optLong("lastUsedAt"));
        BackupCodec.Snapshot backup = BackupCodec.parse(BackupCodec.toJson(accounts, null, 20L));
        JSONObject portable = new org.json.JSONArray(AccountJsonCodec.toJson(backup.accounts)).getJSONObject(0);
        assertEquals("Team", portable.optString("group"));
        assertTrue(portable.optBoolean("pinned"));
        assertEquals(12345L, portable.optLong("lastUsedAt"));
    }
}
