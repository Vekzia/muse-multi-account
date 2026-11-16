package com.seekstars.muselauncher;

import org.junit.Test;
import java.util.Map;
import static org.junit.Assert.*;

public class WebViewHostCacheTest {
    @Test public void evictionReturnsActualValueAfterRegistryHasRemovedItsId() {
        WebViewHostCache<Object> cache = new WebViewHostCache<>(4);
        Object oldest = new Object();
        cache.touch(1, oldest);
        cache.touch(2, new Object());
        cache.touch(3, new Object());
        cache.touch(4, new Object());
        Map<Long, Object> evicted = cache.touch(5, new Object());
        assertEquals(1, evicted.size());
        assertSame(oldest, evicted.get(1L));
        assertNull(cache.remove(1));
        assertEquals(4, cache.snapshot().size());
    }

    @Test public void backgroundInspectionDoesNotPromoteAnAccount() {
        WebViewHostCache<String> cache = new WebViewHostCache<>(2);
        cache.touch(10, "old");
        cache.touch(20, "current");
        assertEquals("old", cache.peek(10));
        assertEquals("old", cache.touch(30, "new").get(10L));
    }

    @Test public void activationPromotesAndDrainTransfersOwnershipExactlyOnce() {
        WebViewHostCache<String> cache = new WebViewHostCache<>(2);
        cache.touch(10, "first");
        cache.touch(20, "second");
        cache.touch(10, "first");
        assertEquals("second", cache.touch(30, "third").get(20L));
        assertEquals(2, cache.drain().size());
        assertTrue(cache.drain().isEmpty());
        assertNull(cache.remove(10));
    }
}
