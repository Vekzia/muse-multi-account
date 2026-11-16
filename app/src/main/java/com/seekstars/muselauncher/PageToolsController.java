package com.seekstars.muselauncher;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.URLUtil;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import androidx.appcompat.app.AlertDialog;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.io.ByteArrayInputStream;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Set;
import java.util.WeakHashMap;
import java.util.function.Supplier;

/** Owns page tools, never navigation or account persistence. UI methods run on the main thread. */
public final class PageToolsController {
    private final Activity activity;
    private final Supplier<WebView> currentWebView;
    private final Supplier<Account> currentAccount;
    private final BlockingSettings blocking;
    private final DownloadRepository downloads;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Set<WebView> attached = Collections.newSetFromMap(new WeakHashMap<>());
    private final Set<AlertDialog> dialogs = Collections.newSetFromMap(new WeakHashMap<>());
    private AlertDialog findDialog;
    private WebView findView;
    private EditText findInput;
    private TextWatcher findWatcher;
    private Runnable pendingFind;
    private long findGeneration;
    private volatile boolean destroyed;

    public PageToolsController(Activity activity, Supplier<WebView> currentWebView,
                               Supplier<Account> currentAccount) {
        this.activity = activity;
        this.currentWebView = currentWebView;
        this.currentAccount = currentAccount;
        blocking = new BlockingSettings(activity);
        downloads = new DownloadRepository(activity);
    }

    /** Call after setProfile and before loading; call again when a cached view becomes active. */
    public void attach(WebView webView, long accountId) {
        if (destroyed || webView == null) return;
        if (findView != null && findView != webView) closeFind();
        attached.add(webView);
        WeakReference<WebView> weakView = new WeakReference<>(webView);
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, length) -> {
            WebView source = weakView.get();
            if (!destroyed && source != null) requestDownload(source, accountId, url, contentDisposition, mimeType);
        });
        webView.setOnLongClickListener(v -> {
            if (destroyed) return false;
            WebView.HitTestResult hit = webView.getHitTestResult();
            if (hit == null) return false;
            if (hit.getType() == WebView.HitTestResult.IMAGE_TYPE) {
                showImageActions(webView, accountId, hit.getExtra());
                return true;
            }
            if (hit.getType() == WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE) {
                // Linked images' hit extra is the anchor URL; ask WebView for the actual image source.
                Handler imageHandler = new Handler(Looper.getMainLooper(), message -> {
                    if (!destroyed && currentWebView.get() == webView) {
                        showImageActions(webView, accountId, message.getData().getString("src"));
                    }
                    return true;
                });
                Message message = imageHandler.obtainMessage();
                webView.requestFocusNodeHref(message);
                return true;
            }
            return false;
        });
    }

    /** Safe on WebView request threads: immutable snapshot, no UI or preference reads. */
    public WebResourceResponse intercept(WebResourceRequest request) {
        if (destroyed || request == null || request.getUrl() == null) return null;
        if (!blocking.snapshot().shouldBlock(request.getUrl().toString(), request.isForMainFrame())) return null;
        return new WebResourceResponse("text/plain", "UTF-8", 200, "OK",
                Collections.singletonMap("Cache-Control", "no-store"), new ByteArrayInputStream(new byte[0]));
    }

    public void showFind() {
        if (!usable()) return;
        WebView webView = currentWebView.get();
        if (webView == null) { toast(R.string.pt_no_page); return; }
        closeFind();
        findView = webView;
        LinearLayout body = column();
        EditText input = new EditText(activity);
        input.setSingleLine(true);
        input.setHint(R.string.pt_find_hint);
        input.setContentDescription(activity.getString(R.string.pt_find_hint));
        body.addView(input, matchWrap());
        TextView count = label(R.string.pt_find_empty, 14);
        count.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        body.addView(count, matchWrap());
        LinearLayout navigation = new LinearLayout(activity);
        Button previous = button(R.string.pt_previous);
        Button next = button(R.string.pt_next);
        previous.setEnabled(false); next.setEnabled(false);
        navigation.addView(previous, new LinearLayout.LayoutParams(0, dp(48), 1));
        navigation.addView(next, new LinearLayout.LayoutParams(0, dp(48), 1));
        body.addView(navigation);
        previous.setOnClickListener(v -> { if (findView == webView) webView.findNext(false); });
        next.setOnClickListener(v -> { if (findView == webView) webView.findNext(true); });
        findInput = input;
        findWatcher = new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int before, int after) {}
            @Override public void onTextChanged(CharSequence s, int start, int before, int after) {
                long generation = ++findGeneration;
                if (pendingFind != null) handler.removeCallbacks(pendingFind);
                webView.setFindListener(null);
                webView.clearMatches();
                previous.setEnabled(false); next.setEnabled(false);
                String query = s.toString();
                count.setText(query.isEmpty() ? R.string.pt_find_empty : R.string.pt_find_searching);
                if (query.isEmpty()) return;
                pendingFind = () -> {
                    if (findView != webView || currentWebView.get() != webView || generation != findGeneration) return;
                    webView.setFindListener((active, total, done) -> {
                        if (findView != webView || generation != findGeneration || !done) return;
                        count.setText(total == 0 ? activity.getString(R.string.pt_find_none)
                                : activity.getString(R.string.pt_find_count, active + 1, total));
                        previous.setEnabled(total > 0); next.setEnabled(total > 0);
                    });
                    webView.findAllAsync(query);
                };
                handler.postDelayed(pendingFind, 180);
            }
            @Override public void afterTextChanged(Editable text) {}
        };
        input.addTextChangedListener(findWatcher);
        findDialog = new AlertDialog.Builder(activity).setTitle(R.string.pt_find_title).setView(body)
                .setPositiveButton(R.string.pt_close, null).create();
        findDialog.setOnDismissListener(d -> {
            if (findDialog == d) clearFindState();
        });
        findDialog.show();
        input.requestFocus();
    }

    public boolean closeFind() {
        boolean open = findView != null || findDialog != null;
        AlertDialog dialog = findDialog;
        clearFindState();
        if (dialog != null) dialog.dismiss();
        return open;
    }

    private void clearFindState() {
        ++findGeneration;
        if (pendingFind != null) handler.removeCallbacks(pendingFind);
        pendingFind = null;
        if (findInput != null && findWatcher != null) findInput.removeTextChangedListener(findWatcher);
        if (findView != null) {
            try { findView.setFindListener(null); findView.clearMatches(); }
            catch (RuntimeException ignored) { /* Host may already have evicted a renderer. */ }
        }
        findView = null; findDialog = null; findInput = null; findWatcher = null;
    }

    public void showBlockingSettings() {
        if (!usable()) return;
        LinearLayout body = column();
        CheckBox enabled = new CheckBox(activity);
        enabled.setText(R.string.pt_blocking_enabled);
        enabled.setMinHeight(dp(48));
        enabled.setChecked(blocking.isEnabled());
        body.addView(enabled);
        body.addView(label(R.string.pt_blocking_note, 14));
        body.addView(label(R.string.pt_blocked_label, 16));
        EditText blocked = rulesEditor(blocking.blockedText());
        body.addView(blocked, matchWrap());
        body.addView(label(R.string.pt_allowed_label, 16));
        EditText allowed = rulesEditor(blocking.allowedText());
        body.addView(allowed, matchWrap());
        Button sample = button(R.string.pt_sample_rules);
        body.addView(sample, matchWrap());
        TextView error = label(0, 14);
        error.setTextColor(0xffff9c9c);
        error.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        body.addView(error);
        sample.setOnClickListener(v -> showDialog(new AlertDialog.Builder(activity)
                .setTitle(R.string.pt_sample_title).setMessage(R.string.pt_sample_body)
                .setNegativeButton(android.R.string.cancel, null)
                .setPositiveButton(R.string.pt_sample_rules, (d, which) -> blocked.setText(BlockingSettings.SAMPLE_DOMAINS)).create()));
        ScrollView scroll = new ScrollView(activity);
        scroll.addView(body);
        AlertDialog dialog = new AlertDialog.Builder(activity).setTitle(R.string.pt_blocking_title)
                .setView(scroll).setNegativeButton(android.R.string.cancel, null)
                .setPositiveButton(R.string.pt_save, null).create();
        showDialog(dialog);
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            try {
                blocking.save(enabled.isChecked(), blocked.getText().toString(), allowed.getText().toString());
                dialog.dismiss(); toast(R.string.pt_rules_saved);
            } catch (IllegalArgumentException e) { error.setText(e.getMessage()); }
        });
    }

    public void showDownloads() {
        if (usable()) activity.startActivity(new Intent(activity, DownloadsActivity.class));
    }

    /** Optional keyboard-accessible image menu hook: paste an HTTP(S) image URL. */
    public void showImageTools() {
        if (!usable()) return;
        WebView webView = currentWebView.get();
        Account account = currentAccount.get();
        if (webView == null || account == null) { toast(R.string.pt_no_page); return; }
        EditText url = new EditText(activity);
        url.setSingleLine(true); url.setHint(R.string.pt_image_url);
        url.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        LinearLayout body = column(); body.addView(url, matchWrap());
        showDialog(new AlertDialog.Builder(activity).setTitle(R.string.pt_image_title).setView(body)
                .setNegativeButton(android.R.string.cancel, null)
                .setPositiveButton(android.R.string.ok, (d, which) -> showImageActions(webView, account.id, url.getText().toString())).create());
    }

    private void showImageActions(WebView source, long accountId, String rawUrl) {
        if (!usable()) return;
        if (rawUrl == null || rawUrl.isEmpty()) { toast(R.string.pt_image_unavailable); return; }
        final String url;
        try { url = DownloadPolicy.normalizeUrl(rawUrl); }
        catch (IllegalArgumentException e) { toast(R.string.pt_unsupported_url); return; }
        showDialog(new AlertDialog.Builder(activity).setTitle(R.string.pt_image_title)
                .setItems(new CharSequence[]{activity.getString(R.string.pt_image_save), activity.getString(R.string.pt_image_copy)}, (d, index) -> {
                    if (index == 0) requestDownload(source, accountId, url, null, null);
                    else {
                        ClipboardManager clipboard = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
                        if (clipboard != null) clipboard.setPrimaryClip(ClipData.newPlainText(activity.getString(R.string.pt_image_title), url));
                        toast(R.string.pt_copied);
                    }
                }).create());
    }

    private void requestDownload(WebView source, long accountId, String rawUrl, String disposition, String mimeType) {
        if (!usable()) return;
        final String url;
        try { url = DownloadPolicy.normalizeUrl(rawUrl); }
        catch (IllegalArgumentException e) { toast(R.string.pt_unsupported_url); return; }
        final boolean hasSessionCookies;
        final String userAgent;
        try {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
                // Read presence only for UI feedback; never capture cookie content in the callback.
                hasSessionCookies = !android.text.TextUtils.isEmpty(WebViewCompat.getProfile(source)
                        .getCookieManager().getCookie(DownloadPolicy.cookieUrl(url)));
                userAgent = DownloadPolicy.headerValue(source.getSettings().getUserAgentString());
            } else { toast(R.string.pt_profile_error); return; }
        } catch (RuntimeException e) { toast(R.string.pt_profile_error); return; }
        String filename = DownloadPolicy.sanitizeFilename(URLUtil.guessFileName(url, disposition, mimeType));
        Account active = currentAccount.get();
        // A hidden view can initiate a download; unknown proxy state must also get the warning.
        boolean confirmSystem = active == null || active.id != accountId || (active.proxy != null && !active.proxy.trim().isEmpty());
        Runnable enqueue = () -> enqueue(accountId, url, filename, mimeType, userAgent);
        String message = activity.getString(R.string.pt_public_download_body);
        if (hasSessionCookies) message += "\n\n" + activity.getString(R.string.pt_session_download_note);
        if (confirmSystem) message += "\n\n" + activity.getString(R.string.pt_proxy_body);
        if (confirmSystem || hasSessionCookies) {
            showDialog(new AlertDialog.Builder(activity).setTitle(R.string.pt_proxy_title)
                    .setMessage(message).setNegativeButton(android.R.string.cancel, null)
                    .setPositiveButton(R.string.pt_system_download, (d, which) -> enqueue.run()).create());
        } else enqueue.run();
    }

    private void enqueue(long accountId, String url, String filename, String mime, String userAgent) {
        if (!usable()) return;
        DownloadManager manager = (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null) { toast(R.string.pt_download_error); return; }
        long id = -1;
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url))
                    .setTitle(filename).setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename);
            for (java.util.Map.Entry<String, String> header : DownloadPolicy.forwardedHeaders(
                    Collections.singletonMap("User-Agent", userAgent)).entrySet()) {
                request.addRequestHeader(header.getKey(), header.getValue());
            }
            if (mime != null && mime.matches("[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+")) request.setMimeType(mime);
            id = manager.enqueue(request);
            downloads.add(new DownloadRepository.Record(id, accountId, filename, url, System.currentTimeMillis()));
            toast(R.string.pt_download_started);
        } catch (RuntimeException e) {
            // Never leave an untracked system task after a history write failure.
            if (id > 0) manager.remove(id);
            toast(R.string.pt_download_error);
        }
    }

    public void destroy() {
        if (destroyed) return;
        destroyed = true;
        closeFind();
        handler.removeCallbacksAndMessages(null);
        for (AlertDialog dialog : new ArrayList<>(dialogs)) dialog.dismiss();
        dialogs.clear();
        for (WebView webView : new ArrayList<>(attached)) {
            try { webView.setOnLongClickListener(null); webView.setDownloadListener(null); }
            catch (RuntimeException ignored) { }
        }
        attached.clear();
    }

    private boolean usable() { return !destroyed && !activity.isFinishing() && !activity.isDestroyed(); }
    private void showDialog(AlertDialog dialog) {
        dialogs.add(dialog); dialog.setOnDismissListener(d -> dialogs.remove(dialog)); dialog.show();
    }
    private void toast(int id) { Toast.makeText(activity, id, Toast.LENGTH_LONG).show(); }
    private int dp(int value) { return Math.round(value * activity.getResources().getDisplayMetrics().density); }
    private LinearLayout column() {
        LinearLayout layout = new LinearLayout(activity); layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(dp(24), dp(8), dp(24), dp(16)); return layout;
    }
    private LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }
    private TextView label(int text, int size) {
        TextView view = new TextView(activity); if (text != 0) view.setText(text);
        view.setTextSize(size); view.setTextColor(activity.getColor(R.color.text_primary));
        view.setPadding(0, dp(8), 0, dp(8)); return view;
    }
    private Button button(int text) {
        Button button = new Button(activity); button.setText(text); button.setMinHeight(dp(48));
        button.setAllCaps(false); return button;
    }
    private EditText rulesEditor(String value) {
        EditText input = new EditText(activity); input.setText(value); input.setHint(R.string.pt_rule_hint);
        input.setTextSize(14); input.setMinLines(3); input.setMaxLines(6);
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE
                | android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        return input;
    }
}
