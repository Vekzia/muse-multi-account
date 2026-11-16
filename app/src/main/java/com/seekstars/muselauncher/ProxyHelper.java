package com.seekstars.muselauncher;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.webkit.ProxyConfig;
import androidx.webkit.ProxyController;
import androidx.webkit.WebViewFeature;

import java.util.concurrent.Executor;

/** App-global proxy writes. Never start navigation until the completion reports success. */
public final class ProxyHelper {
    public interface Completion { void complete(boolean ok); }

    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final Executor EXEC = task -> MAIN.post(task);
    private static final ProxyCoordinator QUEUE = new ProxyCoordinator();
    private static ProxyController controller;

    private ProxyHelper() { }

    public static boolean supported() {
        return WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE);
    }

    /** Compatibility API: schedules a change; its return does not imply the proxy is ready. */
    public static void apply(String proxy) {
        apply(proxy, null);
    }

    /**
     * FIFO set/clear; callback runs exactly once on the main thread after the controller's
     * completion, or false on validation/feature/controller failure. No timeout advances the
     * global queue: a still-running controller write must never race a later write.
     * Invalid explicit rules leave the existing override unchanged. No direct fallback.
     */
    public static void apply(String proxy, Completion callback) {
        onMain(() -> {
            QUEUE.claim(); // Main/navigation takes ownership away from temporary probes.
            QUEUE.submit(done -> perform(proxy, done), ok -> deliver(callback, ok));
        });
    }

    /** Temporary probing owner. Create/use from the main thread. */
    static Temporary temporary() {
        if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("main thread required");
        return new Temporary(QUEUE.claim());
    }

    static final class Temporary {
        private final long owner;
        private boolean closed;

        private Temporary(long owner) { this.owner = owner; }

        void apply(String proxy, Completion callback) {
            onMain(() -> QUEUE.submit(owner, done -> {
                if (closed) done.complete(false);
                else perform(proxy, done);
            }, ok -> deliver(callback, ok && !closed)));
        }

        /** Cancel queued probes and restore only while this session still owns the override. */
        void close(String restore, Completion callback) {
            onMain(() -> {
                if (closed) return;
                closed = true;
                QUEUE.submit(owner, done -> perform(restore, done), ok -> deliver(callback, ok));
            });
        }
    }

    private static void perform(String proxy, ProxyCoordinator.Completion completion) {
        try {
            String rule = ProxyPolicy.rule(proxy);
            if (rule == null || !supported()) {
                Log.w("MuseProxy", "Proxy configuration rejected or unavailable");
                completion.complete(false);
                return;
            }
            if (controller == null) controller = ProxyController.getInstance();
            if (rule.isEmpty()) {
                controller.clearProxyOverride(EXEC, () -> completion.complete(true));
            } else {
                // Implicit localhost bypass is removed too: explicit means proxy, not direct.
                ProxyConfig config = new ProxyConfig.Builder().addProxyRule(rule)
                        .removeImplicitRules().build();
                controller.setProxyOverride(config, EXEC, () -> completion.complete(true));
            }
        } catch (RuntimeException failure) {
            // Controller exception messages may contain URL userinfo. Never log their content.
            Log.w("MuseProxy", "Proxy controller operation failed");
            completion.complete(false);
        }
    }

    private static void deliver(Completion callback, boolean ok) {
        if (callback != null) callback.complete(ok);
    }

    private static void onMain(Runnable action) {
        if (Looper.myLooper() == Looper.getMainLooper()) action.run();
        else MAIN.post(action);
    }

    public static String normalize(String proxy) { return ProxyPool.normalize(proxy); }
}
