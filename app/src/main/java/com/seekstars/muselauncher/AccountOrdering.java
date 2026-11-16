package com.seekstars.muselauncher;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** Pure display ordering; never mutates the persisted manual order. */
public final class AccountOrdering {
    public static final String MANUAL = "manual", NAME = "name", RECENT = "recent";

    private AccountOrdering() { }

    public static String normalizeSort(String sort) {
        return NAME.equals(sort) || RECENT.equals(sort) ? sort : MANUAL;
    }

    /** null group = all; empty group = ungrouped. Stable ties retain manual order. */
    public static List<Account> select(List<Account> accounts, String query, String group, String sort) {
        String key = text(query).trim().toLowerCase(Locale.ROOT);
        List<Account> selected = new ArrayList<>();
        for (Account a : accounts) {
            if (group != null && !group.equals(text(a.group))) continue;
            boolean matches = contains(a.name, key) || contains(a.group, key);
            if (!matches && a.tags != null) {
                for (String tag : a.tags) if (contains(tag, key)) { matches = true; break; }
            }
            if (matches) selected.add(a);
        }
        Comparator<Account> comparator = Comparator.comparing(a -> !a.pinned);
        if (NAME.equals(sort)) comparator = comparator.thenComparing(a -> text(a.name), String.CASE_INSENSITIVE_ORDER);
        if (RECENT.equals(sort)) comparator = comparator.thenComparing(Comparator.comparingLong((Account a) -> a.lastUsedAt).reversed());
        selected.sort(comparator);
        return selected;
    }

    /**
     * Reorder only visible slots in the source pin partition. Hidden accounts keep their
     * exact array indices. Stale/duplicate visible IDs are harmless; -1 means partition end.
     */
    public static List<Account> moveBefore(List<Account> accounts, long id, long beforeId, List<Long> visibleIds) {
        List<Account> result = new ArrayList<>(accounts);
        if (id == beforeId) return result;
        Account source = null;
        for (Account a : accounts) if (a.id == id) source = a;
        if (source == null) return result;
        Set<Long> visible = visibleIds == null ? new HashSet<>() : new HashSet<>(visibleIds);
        List<Integer> slots = new ArrayList<>();
        List<Account> partition = new ArrayList<>();
        for (int i = 0; i < accounts.size(); i++) {
            Account a = accounts.get(i);
            if (a.pinned == source.pinned && (visibleIds == null || visible.contains(a.id))) {
                slots.add(i);
                partition.add(a);
            }
        }
        if (!partition.contains(source)) return result;
        Account target = null;
        for (Account a : partition) if (a.id == beforeId) target = a;
        if (beforeId != -1 && target == null) return result;
        partition.remove(source);
        partition.add(target == null ? partition.size() : partition.indexOf(target), source);
        for (int i = 0; i < slots.size(); i++) result.set(slots.get(i), partition.get(i));
        return result;
    }

    private static boolean contains(String value, String query) {
        return text(value).toLowerCase(Locale.ROOT).contains(query);
    }

    private static String text(String value) { return value == null ? "" : value; }
}
