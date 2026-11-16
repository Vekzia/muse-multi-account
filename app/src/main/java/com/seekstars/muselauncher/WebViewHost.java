package com.seekstars.muselauncher;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.HttpAuthHandler;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.webkit.Profile;
import androidx.webkit.ProfileStore;
import androidx.webkit.ScriptHandler;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * Owns account WebViews, profiles and the foreground proxy/load boundary.
 * All public methods are main-thread only; intercept runs on WebView's request thread.
 * Constructed paused: activate may be queued before the first resume.
 */
public final class WebViewHost {
    public interface Callbacks {
        void attach(WebView view, long id);
        WebResourceResponse intercept(WebResourceRequest request);
        boolean chooseFile(ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params);
        void activated(Account account, boolean animate);
        void loading(long id);
        void finished(long id, boolean failed);
        void error(long id, String message);
        void notifyUser(String message);
    }

    private static final String TAG = "MuseWebview";
    private static final String START_URL = "https://muse.ai/";
    private final Activity activity;
    private final AccountsStore store;
    private final ProfileStore profiles;
    private final FrameLayout container;
    private final Callbacks callbacks;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final WebViewHostSession session = new WebViewHostSession();
    private final WebViewHostCache<Entry> cache = new WebViewHostCache<>(4);
    private final Set<Long> usedProfiles = new HashSet<>();
    private final Runnable dispatch = this::dispatchActivation;
    private Entry current;
    private volatile boolean destroyed;

    private static final class Entry {
        final long id;
        final WebView view;
        final Object fingerprint;
        ScriptHandler script;
        String proxy;
        WebViewHostSession.Request request;
        final WebViewHostPageState page = new WebViewHostPageState();
        volatile boolean disposed;

        Entry(long id, WebView view, Object fingerprint, String proxy) {
            this.id = id;
            this.view = view;
            this.fingerprint = fingerprint;
            this.proxy = proxy;
        }
    }

    public WebViewHost(Activity activity, AccountsStore store, ProfileStore profiles,
                       FrameLayout container, Callbacks callbacks) {
        this.activity = Objects.requireNonNull(activity);
        this.store = Objects.requireNonNull(store);
        this.profiles = profiles;
        this.container = Objects.requireNonNull(container);
        this.callbacks = Objects.requireNonNull(callbacks);
    }

    public void activate(long id, boolean animate) {
        checkMainThread();
        if (destroyed || store.findById(id) == null) return;
        request(id, animate, false, true);
    }

    public void retry() {
        checkMainThread();
        if (destroyed) return;
        long id = session.desiredId();
        if (id < 0 && current != null) id = current.id;
        if (store.findById(id) != null) request(id, false, true, true);
    }

    /** Call after store.reload; scans hidden cached views too. */
    public void invalidateChanged() {
        checkMainThread();
        if (destroyed) return;
        boolean refresh = false;
        long wanted = session.desiredId();
        for (Entry entry : cache.snapshot().values()) {
            Account account = store.findById(entry.id);
            if (account == null || !entry.fingerprint.equals(fingerprint(account.fp))) {
                refresh |= entry.id == wanted;
                remove(entry.id);
            } else if (!Objects.equals(entry.proxy, proxy(account))) {
                entry.page.invalidate();
                refresh |= entry.id == wanted;
            }
        }
        if (wanted >= 0 && store.findById(wanted) == null) session.forget(wanted);
        else if (refresh) request(wanted, false, false, false);
    }

    public void resume() {
        checkMainThread();
        if (destroyed || session.isForeground()) return;
        session.resume();
        scheduleDispatch();
    }

    public void pause() {
        checkMainThread();
        if (destroyed) return;
        session.pause();
        handler.removeCallbacksAndMessages(null);
        for (Entry entry : cache.snapshot().values()) suspend(entry);
        flushProfiles();
        // Do not clear or restore global proxy here: another Activity may now own a probe.
    }

    public WebView current() {
        checkMainThread();
        return destroyed || current == null || current.disposed ? null : current.view;
    }

    public boolean hasCurrent() { return current() != null; }

    /** Release only the in-memory WebView; the Profile remains available for import replacement. */
    public void release(long id) {
        checkMainThread();
        if (destroyed) return;
        session.forget(id);
        remove(id);
    }

    /** Returns false when profile deletion failed; the caller must not claim data was cleared. */
    public boolean purge(long id) {
        checkMainThread();
        if (destroyed) return false;
        release(id);
        try {
            if (profiles == null) throw new IllegalStateException("Profile API unavailable");
            Profile existing = profiles.getProfile(profileName(id));
            boolean deleted = profiles.deleteProfile(profileName(id));
            if (!deleted && existing != null) throw new IllegalStateException("Profile retained");
            usedProfiles.remove(id);
            return true;
        } catch (RuntimeException | LinkageError failure) {
            logFailure("purge", id, failure);
            callbacks.notifyUser(text(R.string.webview_host_purge_failed));
            return false;
        }
    }

    public void destroy() {
        checkMainThread();
        if (destroyed) return;
        destroyed = true;
        session.destroy();
        handler.removeCallbacksAndMessages(null);
        flushProfiles();
        current = null;
        for (Entry entry : cache.drain().values()) dispose(entry);
        usedProfiles.clear();
    }

    private void request(long id, boolean animate, boolean reload, boolean explicit) {
        if (current != null && current.id != id) current.view.setVisibility(View.GONE);
        session.request(id, animate, reload, explicit);
        // Global proxy changes must never leave old visible or hidden views loading.
        for (Entry entry : cache.snapshot().values()) suspend(entry);
        scheduleDispatch();
    }

    private void scheduleDispatch() {
        handler.removeCallbacks(dispatch);
        if (!destroyed && session.isForeground() && activityAlive()) handler.post(dispatch);
    }

    private void dispatchActivation() {
        if (destroyed || !activityAlive()) return;
        WebViewHostSession.Request request = session.take();
        if (request == null) return;
        Account account = store.findById(request.id);
        if (account == null) {
            session.complete(request);
            session.forget(request.id);
            return;
        }
        String expectedProxy = proxy(account);
        // The helper serializes actual set/clear operations; no WebView exists or loads early.
        ProxyHelper.apply(expectedProxy, ok -> {
            if (Looper.myLooper() == Looper.getMainLooper()) applied(request, expectedProxy, ok);
            else if (!destroyed) handler.post(() -> applied(request, expectedProxy, ok));
        });
    }

    private void applied(WebViewHostSession.Request request, String expectedProxy, boolean ok) {
        if (destroyed) return;
        if (!session.complete(request) || !activityAlive()) {
            scheduleDispatch();
            return;
        }
        Account account = store.findById(request.id);
        if (account == null) {
            session.forget(request.id);
            remove(request.id);
            return;
        }
        if (!Objects.equals(expectedProxy, proxy(account))) {
            request(request.id, request.animate, request.reload, false);
            return;
        }
        if (!ok) {
            failActivation(request.id, R.string.webview_host_proxy_failed);
            return;
        }
        Entry target = cache.peek(request.id);
        if (target != null && !target.fingerprint.equals(fingerprint(account.fp))) {
            remove(target.id);
            target = null;
        }
        if (target == null) target = create(account);
        if (target == null) return;
        for (Entry evicted : cache.touch(target.id, target).values()) dispose(evicted);
        if (!session.accepts(request) || !activityAlive()) {
            remove(target.id);
            scheduleDispatch();
            return;
        }
        boolean reload = request.reload || target.page.needsLoad()
                || !Objects.equals(target.proxy, expectedProxy);
        target.proxy = expectedProxy;
        target.request = request;
        target.view.setVisibility(View.VISIBLE);
        target.view.getSettings().setBlockNetworkLoads(false);
        target.view.onResume();
        if (target.view.getParent() == null) container.addView(target.view);
        current = target;
        for (Entry entry : cache.snapshot().values()) {
            if (entry != target) entry.view.setVisibility(View.GONE);
        }
        store.setCurrent(target.id);
        // Resolve live data after async apply, never reuse Account captured at creation.
        callbacks.activated(account, request.animate);
        if (!active(target)) return;
        if (reload) load(target, true);
        else callbacks.finished(target.id, false);
    }

    private Entry create(Account account) {
        Entry entry = null;
        try {
            if (profiles == null || !WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
                throw new IllegalStateException("Profile API unavailable");
            }
            WebView view = new WebView(activity);
            entry = new Entry(account.id, view, fingerprint(account.fp), proxy(account));
            // Bind profile before getSettings, script installation, parent attach, or any load.
            WebViewCompat.setProfile(view, profileName(account.id));
            usedProfiles.add(account.id);
            view.setLayoutParams(new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            view.setBackgroundColor(0xFF121316);
            WebSettings settings = view.getSettings();
            settings.setBlockNetworkLoads(true);
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setDatabaseEnabled(true);
            settings.setSupportMultipleWindows(false);
            settings.setMediaPlaybackRequiresUserGesture(true);
            String systemUa = settings.getUserAgentString();
            if (systemUa != null) {
                systemUa = systemUa.replace("; wv", "").replaceAll("\\s*Version/[\\d.]+", "");
            }
            String ua = FingerprintScript.userAgent(account.fp, systemUa);
            if (ua != null && !ua.isEmpty()) settings.setUserAgentString(ua);
            if (FingerprintScript.hasOverrides(account.fp)) {
                if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                    String script = FingerprintScript.documentStartScript(account.fp, account.id);
                    if (script != null) entry.script = WebViewCompat.addDocumentStartJavaScript(
                            view, script, Collections.singleton("*"));
                } else {
                    callbacks.notifyUser(text(R.string.webview_host_script_unsupported));
                }
            }
            view.setWebViewClient(client(entry));
            final Entry owned = entry;
            view.setWebChromeClient(new WebChromeClient() {
                @Override public boolean onShowFileChooser(WebView ignored,
                        ValueCallback<Uri[]> callback, FileChooserParams params) {
                    return active(owned) && callbacks.chooseFile(callback, params);
                }
            });
            callbacks.attach(view, account.id);
            return entry;
        } catch (RuntimeException | LinkageError failure) {
            if (entry != null) dispose(entry);
            logFailure("create", account.id, failure);
            failActivation(account.id, R.string.webview_host_create_failed);
            return null;
        }
    }

    private void load(Entry entry, boolean reload) {
        if (!active(entry)) return;
        entry.page.begin();
        callbacks.loading(entry.id);
        if (!active(entry)) return;
        if (reload && entry.view.getUrl() != null) entry.view.reload();
        else entry.view.loadUrl(START_URL);
    }

    private WebViewClient client(Entry entry) {
        return new WebViewClient() {
            @Override public void onPageStarted(WebView view, String url, Bitmap icon) {
                if (!active(entry)) return;
                entry.page.started();
                if (!entry.page.isFailed()) callbacks.loading(entry.id);
            }

            @Override public void onPageFinished(WebView view, String url) {
                if (!active(entry)) return;
                entry.page.finished();
                // An error page also finishes. The session's alternative budget is untouched.
                callbacks.finished(entry.id, entry.page.isFailed());
            }

            @Override public void onReceivedError(WebView view, WebResourceRequest request,
                                                   WebResourceError error) {
                if (!request.isForMainFrame() || !active(entry)) return;
                failPage(entry, text(R.string.webview_host_network_error));
                if (isProxyError(error.getErrorCode())) maybeFailover(entry);
            }

            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                                       WebResourceResponse response) {
                if (request.isForMainFrame() && active(entry)) {
                    failPage(entry, activity.getString(R.string.webview_host_http_error,
                            response.getStatusCode()));
                }
            }

            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler,
                                                      SslError error) {
                handler.cancel();
                if (active(entry) && Objects.equals(view.getUrl(), error.getUrl())) {
                    failPage(entry, text(R.string.webview_host_certificate_error));
                }
            }

            @Override public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler,
                                                            String host, String realm) {
                // This callback does not prove a 407 challenge; never pass proxy secrets to sites.
                handler.cancel();
            }

            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                if (destroyed || entry.disposed || cache.peek(entry.id) != entry) return true;
                boolean rebuild = current == entry && session.desiredId() == entry.id;
                remove(entry.id);
                if (rebuild && store.findById(entry.id) != null) {
                    request(entry.id, false, true, false);
                    callbacks.notifyUser(text(R.string.webview_host_renderer_restarting));
                }
                return true;
            }

            @Override public WebResourceResponse shouldInterceptRequest(WebView view,
                                                                          WebResourceRequest request) {
                // This callback is off-main; do not touch session/cache/Activity state here.
                return destroyed || entry.disposed ? null : callbacks.intercept(request);
            }

            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return navigate(entry, request.getUrl(), request.isForMainFrame());
            }

            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return navigate(entry, Uri.parse(url), true);
            }
        };
    }

    private boolean navigate(Entry entry, Uri uri, boolean mainFrame) {
        if (!active(entry)) return true;
        String scheme = uri.getScheme();
        if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) return false;
        // Do not let a hidden iframe open another Activity.
        if (!mainFrame) return true;
        try {
            activity.startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (RuntimeException failure) {
            callbacks.notifyUser(text(R.string.webview_host_external_unavailable));
        }
        return true;
    }

    private void maybeFailover(Entry entry) {
        if (!active(entry)) return;
        Account live = store.findById(entry.id);
        if (live == null || proxy(live).isEmpty()
                || ProxyPool.next(live.proxyPool, live.proxy) == null
                || !session.tryAlternative(entry.id)) return;
        String next = store.failoverProxy(entry.id);
        if (next == null || Objects.equals(next, entry.proxy)) return;
        callbacks.notifyUser(text(R.string.webview_host_proxy_alternative));
        request(entry.id, false, true, false);
    }

    private void failPage(Entry entry, String message) {
        entry.page.failed();
        callbacks.error(entry.id, message);
        callbacks.finished(entry.id, true);
    }

    private void failActivation(long id, int messageRes) {
        String message = text(messageRes);
        callbacks.notifyUser(message);
        callbacks.error(id, message);
        callbacks.finished(id, true);
    }

    private boolean active(Entry entry) {
        return !destroyed && !entry.disposed && current == entry && activityAlive()
                && session.isSettled(entry.id) && session.accepts(entry.request)
                && cache.peek(entry.id) == entry && store.findById(entry.id) != null;
    }

    private void suspend(Entry entry) {
        if (entry.disposed) return;
        entry.page.suspend();
        try {
            entry.view.getSettings().setBlockNetworkLoads(true);
            entry.view.stopLoading();
            entry.view.onPause();
        } catch (RuntimeException failure) {
            logFailure("pause", entry.id, failure);
        }
    }

    private void remove(long id) {
        Entry entry = cache.remove(id);
        if (entry == null) return;
        if (current == entry) current = null;
        dispose(entry);
    }

    private void dispose(Entry entry) {
        if (entry.disposed) return;
        entry.disposed = true;
        flushProfile(entry.id);
        // Each cleanup step is isolated so a provider error cannot skip destroy().
        try { entry.view.stopLoading(); } catch (RuntimeException ignored) { }
        try { entry.view.onPause(); } catch (RuntimeException ignored) { }
        try { entry.view.setWebChromeClient(null); } catch (RuntimeException ignored) { }
        try { entry.view.setWebViewClient(null); } catch (RuntimeException ignored) { }
        try { entry.view.setDownloadListener(null); } catch (RuntimeException ignored) { }
        try { if (entry.script != null) entry.script.remove(); } catch (RuntimeException ignored) { }
        try {
            if (entry.view.getParent() instanceof ViewGroup) {
                ((ViewGroup) entry.view.getParent()).removeView(entry.view);
            }
        } catch (RuntimeException ignored) { }
        try { entry.view.destroy(); } catch (RuntimeException failure) {
            logFailure("destroy", entry.id, failure);
        }
    }

    private void flushProfiles() {
        for (Long id : new HashSet<>(usedProfiles)) flushProfile(id);
    }

    private void flushProfile(long id) {
        if (profiles == null) return;
        try {
            Profile profile = profiles.getProfile(profileName(id));
            if (profile != null) profile.getCookieManager().flush();
        } catch (RuntimeException | LinkageError failure) {
            logFailure("flush", id, failure);
        }
    }

    private boolean activityAlive() { return !activity.isFinishing() && !activity.isDestroyed(); }
    private String text(int res) { return activity.getString(res); }
    private static String profileName(long id) { return "acct_" + id; }
    private static String proxy(Account account) { return account.proxy == null ? "" : account.proxy.trim(); }

    private static Object fingerprint(Fingerprint fp) {
        Fingerprint f = fp == null ? new Fingerprint() : fp;
        // Structural equality avoids delimiter collisions in freely edited custom UA strings.
        return Arrays.asList(f.uaMode, f.uaCustom, f.timezone, f.locale, f.webdriver, f.noise, f.webrtc);
    }

    private static boolean isProxyError(int code) {
        return code == WebViewClient.ERROR_HOST_LOOKUP || code == WebViewClient.ERROR_CONNECT
                || code == WebViewClient.ERROR_PROXY_AUTHENTICATION || code == WebViewClient.ERROR_IO
                || code == WebViewClient.ERROR_TIMEOUT;
    }

    private static void logFailure(String operation, long id, Throwable failure) {
        // Exception messages can include proxy URLs or credentials. Log only the type and ID.
        Log.w(TAG, operation + " id=" + id + " type=" + failure.getClass().getSimpleName());
    }

    private static void checkMainThread() {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            throw new IllegalStateException("WebViewHost requires the main thread");
        }
    }
}
