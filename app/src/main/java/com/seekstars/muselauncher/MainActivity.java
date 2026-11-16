package com.seekstars.muselauncher;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.MotionEvent;
import android.view.View;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.drawerlayout.widget.DrawerLayout;
import androidx.webkit.Profile;
import androidx.webkit.ProfileStore;
import androidx.webkit.WebViewFeature;

import java.util.ArrayList;
import java.util.List;

/** 主界面只协调导航和生命周期；账号、页面、备份、快切各自管理资源。 */
public class MainActivity extends AppCompatActivity {
    private static final int REQ_FILE = 10001;
    private static final int REQ_CONFIG = 10002;
    private static final long SPLASH_TIMEOUT_MS = 8000;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private AccountsStore store;
    private ProfileStore profiles;
    private WebViewHost host;
    private AccountRenderer renderer;
    private PageToolsController pageTools;
    private QuickAccessController quickAccess;
    private BackupController backups;
    private DrawerLayout drawer;
    private View drawerContent, rail, edgeSwipe, splash, errorOverlay;
    private TextView splashName, errorTitle, errorMessage;
    private EditText search;
    private ValueCallback<Uri[]> fileCallback;
    private boolean fullscreen, resumed;
    private long requestedUseId = -1;
    private long failedAccountId = -1;
    private boolean openDrawerAfterActivation;
    private float edgeStartX;
    private long edgeDownAt;
    private List<Long> authQueue;
    private int authIndex;
    private final Runnable hideSplashTask = this::hideSplash;
    private final Runnable authStepTask = this::probeAuthStep;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            showWebViewUpgradeDialog();
            return;
        }
        setContentView(R.layout.activity_main);
        store = new AccountsStore(this);
        profiles = ProfileStore.getInstance();
        drawer = findViewById(R.id.drawerLayout);
        drawerContent = findViewById(R.id.drawerContent);
        rail = findViewById(R.id.rail);
        edgeSwipe = findViewById(R.id.edgeSwipe);
        splash = findViewById(R.id.splash);
        splashName = findViewById(R.id.splashName);
        errorOverlay = findViewById(R.id.errorOverlay);
        errorTitle = findViewById(R.id.errorTitle);
        errorMessage = findViewById(R.id.errorMsg);
        search = findViewById(R.id.drawerSearch);
        quickAccess = new QuickAccessController(this);
        pageTools = new PageToolsController(this, () -> host == null ? null : host.current(),
                () -> store.findById(store.getCurrentId()));
        host = new WebViewHost(this, store, profiles, (FrameLayout) findViewById(R.id.webContainer),
                new WebViewHost.Callbacks() {
                    @Override public void attach(WebView view, long id) { pageTools.attach(view, id); }
                    @Override public WebResourceResponse intercept(WebResourceRequest request) {
                        return pageTools.intercept(request);
                    }
                    @Override public boolean chooseFile(ValueCallback<Uri[]> callback,
                                                        WebChromeClient.FileChooserParams params) {
                        return showFileChooser(callback, params);
                    }
                    @Override public void activated(Account account, boolean animate) {
                        failedAccountId = -1;
                        if (requestedUseId == account.id) {
                            store.markUsed(account.id);
                            requestedUseId = -1;
                        }
                        renderAccounts();
                        quickAccess.refresh();
                        if (openDrawerAfterActivation) {
                            openDrawerAfterActivation = false;
                            drawer.openDrawer(drawerContent);
                        } else drawer.closeDrawer(drawerContent);
                        errorOverlay.setVisibility(View.GONE);
                        if (animate) showSplash(account);
                    }
                    @Override public void loading(long id) {
                        if (id == store.getCurrentId()) {
                            pageTools.closeFind();
                            errorOverlay.setVisibility(View.GONE);
                        }
                    }
                    @Override public void finished(long id, boolean failed) {
                        // Host has already rejected stale sessions. A failed requested account
                        // may not be persisted as current yet, but must still settle its splash.
                        if (failed) { hideSplash(); return; }
                        if (id != store.getCurrentId()) return;
                        hideSplash();
                        errorOverlay.setVisibility(View.GONE);
                        refreshLogged();
                    }
                    @Override public void error(long id, String message) {
                        Account failed = store.findById(id);
                        if (failed == null) return;
                        failedAccountId = id;
                        hideSplash();
                        errorTitle.setText(getString(R.string.toolkit_account_load_failed, failed.name));
                        errorMessage.setText(message == null || message.isEmpty()
                                ? getString(R.string.error_generic) : message);
                        errorOverlay.setVisibility(View.VISIBLE);
                    }
                    @Override public void notifyUser(String message) { toast(message); }
                });
        renderer = new AccountRenderer(this, store,
                (LinearLayout) findViewById(R.id.railAvatars),
                (LinearLayout) findViewById(R.id.accountList), search,
                (TextView) findViewById(R.id.accCount), findViewById(R.id.emptyState),
                findViewById(R.id.drawerEmpty), new AccountRenderer.Callbacks() {
                    @Override public void select(long id) { switchTo(id, true); }
                    @Override public void configure(long id) { openConfig(id, null, false, false); }
                    @Override public void delete(long id) { deleteAccount(id); }
                    @Override public void metadataChanged() { quickAccess.refresh(); }
                    @Override public void shortcut(long id) {
                        Account account = store.findById(id);
                        if (account != null) AccountShortcuts.requestPin(MainActivity.this, account);
                    }
                });
        backups = new BackupController(this, store, profiles, new BackupController.Callbacks() {
            @Override public void beforeReplace(List<Long> ids) {
                pageTools.closeFind();
                host.pause();
                for (Long id : ids) if (id != null) host.release(id);
            }
            @Override public void purgeAccount(long id) {
                host.purge(id);
                AccountShortcuts.disable(MainActivity.this, id);
            }
            @Override public void afterImport() {
                renderAccounts();
                quickAccess.refresh();
                if (resumed) host.resume();
                if (store.getCurrentId() > 0) host.activate(store.getCurrentId(), false);
                refreshLogged();
            }
        });
        findViewById(R.id.btnRailExpand).setOnClickListener(v -> drawer.openDrawer(drawerContent));
        findViewById(R.id.btnCollapse).setOnClickListener(v -> drawer.closeDrawer(drawerContent));
        findViewById(R.id.btnRailAdd).setOnClickListener(v -> addAccount());
        findViewById(R.id.btnAddAccount).setOnClickListener(v -> addAccount());
        findViewById(R.id.btnEmptyAdd).setOnClickListener(v -> addAccount());
        findViewById(R.id.btnFullscreen).setOnClickListener(v -> enterFullscreen());
        findViewById(R.id.btnToolsMenu).setOnClickListener(v -> showTools());
        findViewById(R.id.btnRailTools).setOnClickListener(v -> showTools());
        findViewById(R.id.btnRetry).setOnClickListener(v -> host.retry());
        findViewById(R.id.btnErrorConfig).setOnClickListener(v -> {
            if (store.findById(failedAccountId) != null) {
                openConfig(failedAccountId, null, false, false);
            }
        });
        edgeSwipe.setOnClickListener(v -> exitFullscreen());
        edgeSwipe.setOnTouchListener((v, event) -> {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    edgeStartX = event.getX(); edgeDownAt = SystemClock.uptimeMillis(); return true;
                case MotionEvent.ACTION_UP:
                    float dx = event.getX() - edgeStartX;
                    if (dx > dp(24) || (Math.abs(dx) < dp(8)
                            && SystemClock.uptimeMillis() - edgeDownAt < 500)) v.performClick();
                    return true;
                default: return true;
            }
        });
        renderAccounts();
        checkStoreNotice();
        if (store.getCurrentId() > 0) host.activate(store.getCurrentId(), false);
        if (store.isFullscreen()) enterFullscreen();
        handleLaunch(getIntent());
    }

    private void showTools() {
        String[] choices = getResources().getStringArray(R.array.toolkit_actions);
        new AlertDialog.Builder(this).setTitle(R.string.toolkit_title).setItems(choices, (d, index) -> {
            switch (index) {
                case 0:
                    pageTools.closeFind(); host.retry(); break;
                case 1: pageTools.showFind(); break;
                case 2: pageTools.showDownloads(); break;
                case 3: pageTools.showBlockingSettings(); break;
                case 4: quickAccess.showSettings(); break;
                case 5: backups.startExport(); break;
                case 6: backups.startImport(); break;
                case 7: startActivity(new Intent(this, BatchProbeActivity.class)); break;
                case 8: pageTools.showImageTools(); break;
            }
        }).show();
    }

    private void switchTo(long id, boolean animate) {
        pageTools.closeFind();
        requestedUseId = id;
        host.activate(id, animate);
    }

    private void addAccount() {
        Account current = store.findById(store.getCurrentId());
        Account account = store.addDefault(current == null ? null : current.proxy);
        if (current != null) {
            account.proxyPool = new ArrayList<>(current.proxyPool);
            store.save();
        }
        switchTo(account.id, true);
        renderAccounts();
        toast(getString(R.string.toast_created, account.name));
    }

    private void deleteAccount(long id) {
        if (store.findById(id) == null) return;
        pageTools.closeFind();
        if (!host.purge(id)) return;
        store.remove(id);
        AccountShortcuts.disable(this, id);
        quickAccess.refresh();
        renderAccounts();
        toast(getString(R.string.toast_deleted));
        if (store.getCurrentId() > 0) switchTo(store.getCurrentId(), true);
        else { hideSplash(); errorOverlay.setVisibility(View.GONE); }
    }

    private void openConfig(long id, String proxy, boolean test, boolean save) {
        Intent intent = new Intent(this, AccountConfigActivity.class).putExtra("account_id", id);
        if (proxy != null) intent.putExtra("proxy_preset", proxy)
                .putExtra("proxy_autotest", test).putExtra("proxy_save", save);
        startActivityForResult(intent, REQ_CONFIG);
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (store != null) handleLaunch(intent);
    }

    private void handleLaunch(Intent intent) {
        if (intent == null) return;
        // release 可切换账号；管理命令仍严格走独立 debug 分支。
        if (ShortcutRoute.ACTION_SWITCH_ACCOUNT.equals(intent.getAction())) {
            long id = -1;
            try {
                Object raw = intent.getExtras() == null ? null
                        : intent.getExtras().get(ShortcutRoute.EXTRA_ACCOUNT_ID);
                id = ShortcutRoute.parse(intent.getAction(), raw);
            } catch (RuntimeException ignored) { }
            if (id > 0 && store.findById(id) != null) switchTo(id, true);
            else toast(getString(R.string.toolkit_account_missing));
            return;
        }
        if (!LaunchCommands.enabled(BuildConfig.DEBUG)) return;
        LaunchCommands commands;
        try { commands = LaunchCommands.fromIntent(intent); }
        catch (RuntimeException badExtras) { return; }
        if (commands.startAccount > 0) switchTo(commands.startAccount, true);
        if (commands.hasFullscreen) {
            if (commands.fullscreen) enterFullscreen(); else exitFullscreen();
        }
        if (commands.showDrawer) {
            openDrawerAfterActivation = true;
            drawer.openDrawer(drawerContent);
        }
        if (commands.hasOpenConfig) {
            long id = commands.openConfigId > 0 ? commands.openConfigId : store.getCurrentId();
            if (id > 0) openConfig(id, commands.proxyPreset, commands.proxyAutoTest, commands.proxySave);
        }
        if (commands.searchQuery != null) search.setText(commands.searchQuery);
        if (commands.addAccount) addAccount();
        if (commands.hasDelAccount) deleteAccount(commands.delAccountId);
        if (commands.dumpAuth) {
            // 仅输出状态，不把会话值放入 logcat。
            for (Account account : store.all())
                Log.i("MuseAuth", "acct=" + account.id + " logged=" + isLogged(account.id));
        }
    }

    private boolean showFileChooser(ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params) {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        fileCallback = callback;
        try { startActivityForResult(params.createIntent(), REQ_FILE); return true; }
        catch (RuntimeException error) {
            fileCallback = null;
            toast(getString(R.string.toast_no_filechooser));
            return false;
        }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
            return;
        }
        if (store == null) return;
        if (backups.onActivityResult(requestCode, resultCode, data)) return;
        quickAccess.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_CONFIG && resultCode == RESULT_OK) {
            store.reload();
            host.invalidateChanged();
            renderAccounts();
            quickAccess.refresh();
        }
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (quickAccess != null) quickAccess.onRequestPermissionsResult(requestCode, permissions, results);
    }

    @Override protected void onResume() {
        super.onResume();
        resumed = true;
        if (store == null) return;
        store.reload();
        checkStoreNotice();
        host.invalidateChanged();
        host.resume();
        renderAccounts();
        quickAccess.refresh();
        refreshLogged();
    }

    @Override protected void onPause() {
        resumed = false;
        if (host != null) host.pause();
        handler.removeCallbacks(authStepTask);
        authQueue = null;
        super.onPause();
    }

    @Override protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (fileCallback != null) { fileCallback.onReceiveValue(null); fileCallback = null; }
        if (backups != null) backups.destroy();
        if (pageTools != null) pageTools.destroy();
        if (renderer != null) renderer.dispose();
        if (host != null) host.destroy();
        if (quickAccess != null) quickAccess.destroy();
        super.onDestroy();
    }

    @Override public void onBackPressed() {
        if (store == null) { finish(); return; }
        if (pageTools.closeFind()) return;
        if (fullscreen) exitFullscreen();
        else if (drawer.isDrawerOpen(drawerContent)) drawer.closeDrawer(drawerContent);
        else if (host.current() != null && host.current().canGoBack()) host.current().goBack();
        else moveTaskToBack(true);
    }

    private void renderAccounts() { if (renderer != null) renderer.render(); }

    private void refreshLogged() {
        if (!resumed || profiles == null) return;
        handler.removeCallbacks(authStepTask);
        authQueue = new ArrayList<>();
        for (Account a : store.all()) authQueue.add(a.id);
        authIndex = 0;
        handler.post(authStepTask);
    }

    private void probeAuthStep() {
        if (!resumed || authQueue == null) return;
        int end = Math.min(authIndex + 20, authQueue.size());
        boolean changed = false;
        while (authIndex < end) {
            long id = authQueue.get(authIndex++);
            Account account = store.findById(id);
            if (account == null) continue;
            boolean logged = isLogged(id);
            if (account.logged != logged) { account.logged = logged; changed = true; }
        }
        if (changed) renderAccounts();
        if (authIndex < authQueue.size()) handler.postDelayed(authStepTask, 16);
        else authQueue = null;
    }

    private boolean isLogged(long id) {
        try {
            Profile profile = profiles.getProfile("acct_" + id);
            String cookies = profile == null ? null : profile.getCookieManager().getCookie("https://muse.ai/");
            if (cookies != null) for (String part : cookies.split(";")) {
                String cookie = part.trim();
                if (cookie.startsWith("hatch_sess=") && cookie.length() > "hatch_sess=".length()) return true;
            }
        } catch (RuntimeException ignored) { }
        return false;
    }

    private void showSplash(Account account) {
        splashName.setText(account.name);
        splash.setVisibility(View.VISIBLE);
        handler.removeCallbacks(hideSplashTask);
        handler.postDelayed(hideSplashTask, SPLASH_TIMEOUT_MS);
    }
    private void hideSplash() {
        handler.removeCallbacks(hideSplashTask);
        if (splash != null) splash.setVisibility(View.GONE);
    }
    private void enterFullscreen() {
        fullscreen = true;
        store.setFullscreen(true);
        rail.setVisibility(View.GONE);
        edgeSwipe.setVisibility(View.VISIBLE);
        drawer.setDrawerLockMode(DrawerLayout.LOCK_MODE_LOCKED_CLOSED);
        drawer.closeDrawer(drawerContent);
    }
    private void exitFullscreen() {
        fullscreen = false;
        store.setFullscreen(false);
        rail.setVisibility(View.VISIBLE);
        edgeSwipe.setVisibility(View.GONE);
        drawer.setDrawerLockMode(DrawerLayout.LOCK_MODE_UNLOCKED);
    }
    private void checkStoreNotice() {
        String notice = store.takeLoadNotice();
        if ("recovered".equals(notice)) toast(getString(R.string.toast_store_recovered));
        else if ("corrupt".equals(notice)) toast(getString(R.string.toast_store_corrupt));
    }
    private void showWebViewUpgradeDialog() {
        new AlertDialog.Builder(this).setTitle(R.string.webview_need_update_title)
                .setMessage(R.string.webview_need_update_msg)
                .setPositiveButton(R.string.webview_update_btn, (d, w) -> {
                    try { startActivity(new Intent(Intent.ACTION_VIEW,
                            Uri.parse("market://details?id=com.google.android.webview"))); }
                    catch (RuntimeException error) {
                        try { startActivity(new Intent(Intent.ACTION_VIEW,
                                Uri.parse("https://play.google.com/store/apps/details?id=com.google.android.webview"))); }
                        catch (RuntimeException ignored) { }
                    }
                    finish();
                }).setNegativeButton(R.string.btn_exit, (d, w) -> finish()).show();
    }
    private void toast(String message) { Toast.makeText(this, message, Toast.LENGTH_SHORT).show(); }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
