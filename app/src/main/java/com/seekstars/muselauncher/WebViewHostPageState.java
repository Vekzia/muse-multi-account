package com.seekstars.muselauncher;

/** Page completion is distinct from a successful load; error pages also finish. */
final class WebViewHostPageState {
    private boolean loaded;
    private boolean loading;
    private boolean failed;
    private boolean interrupted;

    void begin() { failed = false; loading = true; interrupted = false; }
    void started() { loading = true; }
    void failed() { failed = true; loading = false; }
    void finished() { loaded = true; loading = false; }
    void suspend() { interrupted |= loading; loading = false; }
    void invalidate() { interrupted = true; }
    boolean isFailed() { return failed; }
    boolean isLoading() { return loading; }
    boolean isLoaded() { return loaded; }
    boolean needsLoad() { return !loaded || failed || interrupted; }
}
