package com.seekstars.muselauncher;

import org.junit.Test;
import java.util.Arrays;
import java.util.List;
import java.util.stream.Collectors;
import static org.junit.Assert.*;

public class AccountOrderingTest {
    private Account account(long id, String name, String group, boolean pinned, long used) {
        Account a = new Account(id, name);
        a.group = group;
        a.pinned = pinned;
        a.lastUsedAt = used;
        return a;
    }

    @Test public void pinsLeadAllSortModesAndTiesKeepManualOrder() {
        List<Account> all = Arrays.asList(account(1, "Zulu", "", false, 50),
                account(2, "beta", "", true, 5), account(3, "Alpha", "", false, 100),
                account(4, "ALPHA", "", false, 100), account(5, "Able", "", true, 10));
        assertEquals(Arrays.asList(2L, 5L, 1L, 3L, 4L), ids(AccountOrdering.select(all, "", null, "manual")));
        assertEquals(Arrays.asList(5L, 2L, 3L, 4L, 1L), ids(AccountOrdering.select(all, "", null, "name")));
        assertEquals(Arrays.asList(5L, 2L, 3L, 4L, 1L), ids(AccountOrdering.select(all, "", null, "recent")));
        assertEquals(Arrays.asList(1L, 2L, 3L, 4L, 5L), ids(all));
        assertNotSame(all, AccountOrdering.select(all, null, null, null));
    }

    @Test public void searchMatchesNameTagOrGroupWithExactGroupFilter() {
        Account first = account(1, "Personal", "Team", false, 0);
        first.tags.add("URGENT");
        Account second = account(2, "Team account", "", true, 0);
        Account third = account(3, "Other", "Team Two", false, 0);
        List<Account> all = Arrays.asList(first, second, third);
        assertEquals(Arrays.asList(2L, 1L, 3L), ids(AccountOrdering.select(all, " team ", null, "manual")));
        assertEquals(Arrays.asList(1L), ids(AccountOrdering.select(all, "urgent", "Team", "manual")));
        assertEquals(Arrays.asList(2L), ids(AccountOrdering.select(all, "", "", "manual")));
        assertTrue(AccountOrdering.select(all, "missing", null, "manual").isEmpty());
        assertEquals(Arrays.asList(1L), ids(AccountOrdering.select(all, "", "Team", "manual")));
    }

    @Test public void movesDoNotMutateInputsOrLoseIdsWithStaleVisibleLists() {
        List<Account> all = Arrays.asList(account(1, "a", "", false, 0),
                account(2, "hidden", "", false, 0), account(3, "b", "", false, 0),
                account(4, "pin", "", true, 0), account(5, "c", "", false, 0));
        List<Account> moved = AccountOrdering.moveBefore(all, 5, 1, Arrays.asList(5L, 1L, 1L, 999L, 4L, 3L));
        assertEquals(Arrays.asList(5L, 2L, 1L, 4L, 3L), ids(moved));
        assertEquals(Arrays.asList(1L, 2L, 3L, 4L, 5L), ids(all));
        assertEquals(ids(all), ids(AccountOrdering.moveBefore(all, 5, 4, Arrays.asList(1L, 4L, 5L))));
        assertEquals(ids(all), ids(AccountOrdering.moveBefore(all, 999, 1, Arrays.asList(1L, 999L))));
    }

    private static List<Long> ids(List<Account> accounts) {
        return accounts.stream().map(a -> a.id).collect(Collectors.toList());
    }
}
