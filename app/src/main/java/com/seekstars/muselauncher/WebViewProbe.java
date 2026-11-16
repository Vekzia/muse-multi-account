package com.seekstars.muselauncher;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.webkit.HttpAuthHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/** One main-thread temporary proxy session; the owned WebView never outlives its attempt. */
final class WebViewProbe {
    interface Result { void complete(boolean ok, String reason, long elapsedMs); }
    // A real small 200 document. Unlike generate_204 it commits a WebView document.
    private static final String ENDPOINT = "https://www.gstatic.com/robots.txt";
    private static final long TIMEOUT_MS = 10000;
    private final Context context;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ProbeSession gate = new ProbeSession();
    private final ProxyHelper.Temporary proxy = ProxyHelper.temporary();
    private WebView view;
    private Runnable timeout;
    private boolean closed;

    WebViewProbe(Context context) { this.context = context; }

    void run(String address, Result result) {
        if (closed) return;
        final long token = gate.begin();
        if (token == 0) throw new IllegalStateException("probe already active");
        final long started = SystemClock.uptimeMillis();
        timeout = () -> fail(token, context.getString(R.string.config_proxy_timeout), result);
        handler.postDelayed(timeout, TIMEOUT_MS);
        proxy.apply(address, ok -> {
            if (closed) return;
            if (!ok) {
                fail(token, context.getString(address != null && address.contains("@")
                        ? R.string.proxy_auth_unsupported : R.string.proxy_apply_failed), result);
                return;
            }
            if (!gate.proxyApplied(token, true)) return;
            try {
                final WebView attempt = new WebView(context);
                view = attempt;
                attempt.getSettings().setCacheMode(WebSettings.LOAD_NO_CACHE);
                attempt.setWebViewClient(new WebViewClient() {
                    @Override public void onPageFinished(WebView webView, String url) {
                        if (!ENDPOINT.equals(url)) {
                            fail(token, context.getString(R.string.proxy_endpoint_error), result);
                        } else if (gate.pageFinished(token, true)) {
                            cleanupAttempt();
                            result.complete(true, null, SystemClock.uptimeMillis() - started);
                        }
                    }
                    @Override public void onReceivedError(WebView webView, WebResourceRequest request,
                                                          WebResourceError error) {
                        if (request.isForMainFrame()) {
                            // Do not expose descriptions/URLs that might contain credentials.
                            fail(token, context.getString(R.string.proxy_network_error, error.getErrorCode()), result);
                        }
                    }
                    @Override public void onReceivedHttpError(WebView webView, WebResourceRequest request,
                                                              WebResourceResponse response) {
                        if (request.isForMainFrame()) {
                            fail(token, context.getString(R.string.proxy_http_error, response.getStatusCode()), result);
                        }
                    }
                    @Override public boolean shouldOverrideUrlLoading(WebView webView, WebResourceRequest request) {
                        if (request.isForMainFrame() && !ENDPOINT.equals(request.getUrl().toString())) {
                            fail(token, context.getString(R.string.proxy_endpoint_error), result);
                            return true;
                        }
                        return false;
                    }
                    @Override public void onReceivedHttpAuthRequest(WebView webView, HttpAuthHandler auth,
                                                                   String host, String realm) {
                        // This API also receives origin-server challenges; never send proxy credentials here.
                        auth.cancel();
                        fail(token, context.getString(R.string.proxy_auth_unsupported), result);
                    }
                });
                attempt.loadUrl(ENDPOINT);
            } catch (RuntimeException failure) {
                fail(token, context.getString(R.string.proxy_endpoint_error), result);
            }
        });
    }

    private void fail(long token, String reason, Result result) {
        if (!gate.finish(token)) return;
        cleanupAttempt();
        result.complete(false, reason, 0);
    }

    private void cleanupAttempt() {
        if (timeout != null) handler.removeCallbacks(timeout);
        timeout = null;
        WebView old = view;
        view = null;
        if (old != null) {
            old.setWebViewClient(new WebViewClient());
            old.stopLoading();
            old.destroy();
        }
    }

    void close(String restore) {
        if (closed) return;
        closed = true;
        gate.cancel();
        cleanupAttempt();
        handler.removeCallbacksAndMessages(null);
        proxy.close(restore, null);
    }
}
