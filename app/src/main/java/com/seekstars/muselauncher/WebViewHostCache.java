package com.seekstars.muselauncher;

import java.util.LinkedHashMap;
import java.util.Map;

/** Transfers evicted resources to their owner, retaining values before registry removal. */
final class WebViewHostCache<T> {
    private final LruAccountRegistry<T> registry;

    WebViewHostCache(int capacity) { registry = new LruAccountRegistry<>(capacity); }

    // Callback/config inspection must not change the user's activation-based LRU ordering.
    T peek(long id) { return registry.snapshot().get(id); }

    Map<Long, T> touch(long id, T value) {
        Map<Long, T> before = registry.snapshot();
        Map<Long, T> removed = new LinkedHashMap<>();
        for (Long evicted : registry.touchAndEvict(id, value)) {
            T resource = before.get(evicted);
            if (resource != null) removed.put(evicted, resource);
        }
        return removed;
    }

    T remove(long id) { return registry.remove(id); }
    Map<Long, T> snapshot() { return registry.snapshot(); }

    Map<Long, T> drain() {
        Map<Long, T> owned = registry.snapshot();
        for (Long id : owned.keySet()) registry.remove(id);
        return owned;
    }
}
