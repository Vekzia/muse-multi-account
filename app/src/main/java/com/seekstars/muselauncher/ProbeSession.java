package com.seekstars.muselauncher;

/** Per-attempt gate shared by single/pool probes. Confined to the main thread. */
final class ProbeSession {
    private long sequence;
    private long active;
    private boolean loaded;

    long begin() {
        if (active != 0) return 0;
        loaded = false;
        active = ++sequence;
        return active;
    }

    boolean proxyApplied(long token, boolean ok) {
        if (!ok || token == 0 || token != active || loaded) return false;
        loaded = true;
        return true;
    }

    boolean pageFinished(long token, boolean expectedEndpoint) {
        return loaded && expectedEndpoint && finish(token);
    }

    boolean finish(long token) {
        if (token == 0 || token != active) return false;
        active = 0;
        loaded = false;
        return true;
    }

    void cancel() {
        active = 0;
        loaded = false;
    }
}
