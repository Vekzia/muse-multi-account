package com.seekstars.muselauncher;

/** Main-thread policy for the host's single global-proxy activation stream. */
final class WebViewHostSession {
    static final class Request {
        final long generation;
        final long id;
        final boolean animate;
        final boolean reload;

        Request(long generation, long id, boolean animate, boolean reload) {
            this.generation = generation;
            this.id = id;
            this.animate = animate;
            this.reload = reload;
        }
    }

    private boolean foreground;
    private boolean destroyed;
    private long generation;
    private long desiredId = -1;
    private boolean desiredAnimate;
    private boolean desiredReload;
    private Request pending;
    private Request inFlight;
    private boolean alternativeUsed;

    void request(long id, boolean animate, boolean reload, boolean explicit) {
        if (destroyed || id < 0) return;
        desiredId = id;
        desiredAnimate = animate;
        desiredReload = reload;
        if (explicit) alternativeUsed = false;
        // A request supersedes an older queued request. An active apply is allowed to finish,
        // but its completion is stale when the generation changes.
        generation++;
        pending = new Request(generation, id, animate, reload);
    }

    void resume() {
        if (destroyed || foreground) return;
        foreground = true;
        generation++;
        pending = desiredId >= 0
                ? new Request(generation, desiredId, desiredAnimate, desiredReload)
                : null;
    }

    void pause() {
        if (destroyed) return;
        foreground = false;
        generation++;
        pending = null;
    }

    void destroy() {
        destroyed = true;
        foreground = false;
        generation++;
        pending = null;
        inFlight = null;
        desiredId = -1;
    }

    void forget(long id) {
        if (desiredId == id) {
            desiredId = -1;
            desiredAnimate = false;
            desiredReload = false;
            alternativeUsed = false;
            generation++;
        }
        if (pending != null && pending.id == id) pending = null;
    }

    long desiredId() { return desiredId; }
    boolean isForeground() { return foreground && !destroyed; }
    boolean isSettled(long id) {
        return desiredId == id && pending == null && inFlight == null;
    }

    /** Begins the one proxy apply that can be in flight at a time. */
    Request take() {
        if (!isForeground() || inFlight != null || pending == null) return null;
        inFlight = pending;
        pending = null;
        return inFlight;
    }

    /** Returns true only for the current, non-stale completion. */
    boolean complete(Request request) {
        if (request == null || request != inFlight) return false;
        inFlight = null;
        boolean accepted = accepts(request);
        if (accepted) {
            desiredAnimate = false;
            desiredReload = false;
        }
        return accepted;
    }

    boolean accepts(Request request) {
        return request != null && request.generation == generation
                && request.id == desiredId && isForeground();
    }

    /** Keeps one alternative proxy per explicit activation/retry, not per page finish. */
    boolean tryAlternative(long id) {
        if (!isForeground() || !isSettled(id) || alternativeUsed) return false;
        alternativeUsed = true;
        return true;
    }
}
