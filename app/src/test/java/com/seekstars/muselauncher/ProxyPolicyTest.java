package com.seekstars.muselauncher;

import org.junit.Test;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import static org.junit.Assert.*;

public class ProxyPolicyTest {
    @Test public void explicitInvalidOrAuthenticatedProxyIsNeverDirect() {
        assertEquals("", ProxyPolicy.rule(" "));
        assertEquals("http://127.0.0.1:7890", ProxyPolicy.rule("127.0.0.1:7890"));
        assertNull(ProxyPolicy.rule("not-valid"));
        assertNull(ProxyPolicy.rule("http://user:secret@127.0.0.1:7890"));
        assertNull(ProxyPolicy.rule("socks5://user:secret@127.0.0.1:1080"));
        assertNull(ProxyPolicy.rule("socks4://127.0.0.1:1080"));
    }

    @Test public void diagnosticsNeverExposeUserInfoOrMalformedInput() {
        assertEquals("http://***@proxy.test:8080", ProxyPolicy.display("http://user:secret@proxy.test:8080"));
        assertEquals("[invalid proxy]", ProxyPolicy.display("private-secret broken"));
    }

    @Test public void newlyEditedActiveWinsOverPreviouslySavedPool() {
        assertEquals("http://new.test:8080", ProxyPolicy.savedActive("new.test:8080", "old.test:8080",
                Arrays.asList("http://old.test:8080")));
        assertEquals("http://other.test:8080", ProxyPolicy.savedActive("old.test:8080", "old.test:8080",
                Arrays.asList("http://other.test:8080")));
        assertEquals("http://other.test:8080", ProxyPolicy.savedActive("", "old.test:8080",
                Arrays.asList("http://other.test:8080")));
        assertNull(ProxyPolicy.savedActive("invalid", "old.test:8080", Collections.emptyList()));
    }

    @Test public void unsupportedPoolSelectionDoesNotBecomeActiveSilently() {
        assertNull(ProxyPolicy.savedActive("", "", Arrays.asList("http://user:secret@proxy.test:8080")));
    }

    @Test public void cleanupSnapshotsCountBeforeStoreReplacesPoolAndSelectsSurvivor() {
        ArrayList<String> pool = new ArrayList<>(Arrays.asList("http://bad.test:8080", "http://good.test:8080"));
        ProxyPolicy.Cleanup plan = ProxyPolicy.cleanup(pool, "bad.test:8080",
                Collections.singleton("http://bad.test:8080"));
        pool.clear();
        pool.addAll(plan.kept);
        assertEquals(1, plan.removed);
        assertEquals("http://good.test:8080", plan.active);
        assertEquals(Collections.singletonList("http://good.test:8080"), plan.kept);
    }

    @Test public void cleanupPreservesAllDeadPoolAndIgnoresUntestedItems() {
        assertEquals(0, ProxyPolicy.cleanup(Arrays.asList("bad.test:8080"), "bad.test:8080",
                Collections.singleton("http://bad.test:8080")).removed);
        assertEquals(0, ProxyPolicy.cleanup(Arrays.asList("good.test:8080"), "good.test:8080",
                Collections.singleton("http://other.test:8080")).removed);
    }
}
