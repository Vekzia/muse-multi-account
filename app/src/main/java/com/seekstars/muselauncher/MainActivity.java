package com.seekstars.muselauncher;

import android.app.DownloadManager;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.Editable;
import android.text.InputType;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.TextWatcher;
import android.text.style.ForegroundColorSpan;
import android.util.Log;
import android.util.SparseArray;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.drawerlayout.widget.DrawerLayout;
import androidx.webkit.Profile;
import androidx.webkit.ProfileStore;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

public class MainActivity extends AppCompatActivity {

    private static final String START_URL = "https://muse.ai/";
    private static final int REQ_FILE = 10001;
    private static final int REQ_CONFIG = 10002;
    private static final int REQ_EXPORT = 10003;
    private static final int REQ_IMPORT = 10004;
    private static final long MIN_SPLASH_MS = 500;
    private static final long SPLASH_TIMEOUT_MS = 8000;
    private static final int COLOR_TEXT = 0xFFE9EBEE;
    private static final int COLOR_MUTED = 0xFF8A9099;
    private static final int COLOR_ICON = 0xFF7D838C;
    /** muse.ai 登录会话 cookie（httpOnly）。匿名访问只会落下 hatch_native_auth_* 等流程 cookie。 */
    private static final String AUTH_COOKIE_MARKER = "hatch_sess=";

    private AccountsStore store;
    private ProfileStore profileStore;

    private DrawerLayout drawerLayout;
    private View drawerContent;
    private View rail;
    private View edgeSwipe;
    private LinearLayout railAvatars;
    private LinearLayout accountList;
    private EditText searchInput;
    private View drawerEmpty;
    private TextView accCount;
    private FrameLayout webContainer;
    private View emptyState;
    private View splash;
    private TextView splashName;
    private View errorOverlay;
    private TextView errorMsg;

    /** 每个账号一个独立 WebView（Profile 只能在 WebView 初始化前设置一次） */
    private static final int MAX_ALIVE_WEBVIEWS = 4; // LRU：最多同时保留的账号页面数（含当前）
    private final LruAccountRegistry<WebView> webViews = new LruAccountRegistry<>(MAX_ALIVE_WEBVIEWS);
    private final SparseArray<Boolean> webLoaded = new SparseArray<>();
    /** 主框架加载出错标记（错误遮罩依据），重试成功后清除 */
    private final SparseArray<Boolean> webErrored = new SparseArray<>();
    /** 加载耗时统计起点 */
    private final SparseArray<Long> loadStartAt = new SparseArray<>();
    private WebView currentWebView;

    private long editId = -1;
    private long confirmDelId = -1;
    private EditText renameInput;
    private long splashShownAt;
    private final Runnable hideSplashRunnable = this::hideSplash;
    /** 每个账号创建 WebView 时实际生效的指纹签名；配置页回来后据此判断要不要重建页面 */
    private final SparseArray<String> appliedFp = new SparseArray<>();
    /** 本轮加载是否已经因代理问题换过节点：每次加载只换一次，避免池内死循环 reload */
    private final SparseArray<Boolean> failoverTried = new SparseArray<>();
    /** 导出到系统文件选择器期间的待写内容（SAF 回调里才知道目标 Uri） */
    private String pendingExportText;

    private ValueCallback<Uri[]> fileCallback;
    private boolean fullscreen;
    private float edgeStartX;
    private long edgeDownAt;

    /** M4: 登录态分块探测。androidx Profile API 强制主线程调用，无法后台化；
     *  改为主线程分块（每块 20 个账号，块间让出一帧），账号多时不阻塞 UI，脏标记合并请求 */
    private static final int PROBE_CHUNK = 20;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final java.util.concurrent.atomic.AtomicBoolean probeRunning =
            new java.util.concurrent.atomic.AtomicBoolean(false);
    private final java.util.concurrent.atomic.AtomicBoolean probeDirty =
            new java.util.concurrent.atomic.AtomicBoolean(false);
    private List<Account> probeQueue;
    private int probeIndex;
    private boolean probeChanged;

    private final Runnable probeStep = this::probeStep;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            showWebViewUpgradeDialog();
            return;
        }

        setContentView(R.layout.activity_main);
        store = new AccountsStore(this);
        checkStoreNotice();
        profileStore = ProfileStore.getInstance();

        drawerLayout = findViewById(R.id.drawerLayout);
        drawerContent = findViewById(R.id.drawerContent);
        rail = findViewById(R.id.rail);
        edgeSwipe = findViewById(R.id.edgeSwipe);
        railAvatars = findViewById(R.id.railAvatars);
        accountList = findViewById(R.id.accountList);
        searchInput = findViewById(R.id.drawerSearch);
        drawerEmpty = findViewById(R.id.drawerEmpty);
        accCount = findViewById(R.id.accCount);
        webContainer = findViewById(R.id.webContainer);
        errorOverlay = findViewById(R.id.errorOverlay);
        errorMsg = findViewById(R.id.errorMsg);
        emptyState = findViewById(R.id.emptyState);
        splash = findViewById(R.id.splash);
        splashName = findViewById(R.id.splashName);

        findViewById(R.id.btnRailExpand).setOnClickListener(v ->
                drawerLayout.openDrawer(drawerContent));
        findViewById(R.id.btnCollapse).setOnClickListener(v ->
                drawerLayout.closeDrawer(drawerContent));
        findViewById(R.id.btnRailAdd).setOnClickListener(v -> addAccount());
        findViewById(R.id.btnAddAccount).setOnClickListener(v -> addAccount());
        findViewById(R.id.btnEmptyAdd).setOnClickListener(v -> addAccount());
        findViewById(R.id.btnFullscreen).setOnClickListener(v -> enterFullscreen());
        findViewById(R.id.btnExport).setOnClickListener(v -> startExport());
        findViewById(R.id.btnImport).setOnClickListener(v -> startImport());
        findViewById(R.id.btnBatchProbe).setOnClickListener(v ->
                startActivity(new Intent(this, BatchProbeActivity.class)));

        // 加载失败遮罩：重试按钮重新加载当前账号页面
        findViewById(R.id.btnRetry).setOnClickListener(v -> {
            long curId = store.getCurrentId();
            if (currentWebView != null && curId >= 0) {
                // 手动重试等于"再给我一次机会"：允许再换一条池内代理（自动轮换每轮只做一次）
                failoverTried.put((int) curId, false);
                webErrored.put((int) curId, false);
                hideErrorOverlay();
                loadStartAt.put((int) curId, SystemClock.uptimeMillis());
                Log.i("MusePerf", "load retry id=" + curId);
                currentWebView.reload();
            }
        });

        // 搜索框：输入即时按名称 + 标签过滤
        searchInput.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int a, int b, int c) {
            }

            @Override
            public void onTextChanged(CharSequence s, int a, int b, int c) {
            }

            @Override
            public void afterTextChanged(Editable s) {
                renderAccounts();
            }
        });

        edgeSwipe.setOnTouchListener((v, event) -> {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    edgeStartX = event.getX();
                    edgeDownAt = SystemClock.uptimeMillis();
                    return true;
                case MotionEvent.ACTION_UP: {
                    float dx = event.getX() - edgeStartX;
                    boolean swipeIn = dx > dp(24);
                    boolean tap = Math.abs(dx) < dp(8)
                            && (SystemClock.uptimeMillis() - edgeDownAt) < 500;
                    if (swipeIn || tap) exitFullscreen();
                    return true;
                }
                default:
                    return true;
            }
        });

        Long cur = store.getCurrentId();
        if (cur == null || cur < 0 || store.findById(cur) == null) {
            if (store.all().isEmpty()) {
                renderAccounts();
            } else {
                switchTo(store.all().get(0).id, false);
            }
        } else {
            switchTo(cur, false);
        }

        // 恢复上次的全屏状态；调试 extra 优先
        if (store.isFullscreen()) enterFullscreen();

        // 调试入口：am start --ez show_drawer true / --el start_account <id> / --ez fullscreen true
        Intent launchIntent = getIntent();
        if (launchIntent != null) handleLaunchExtras(launchIntent);
    }

    @Override
    protected void onNewIntent(Intent launchIntent) {
        super.onNewIntent(launchIntent);
        // 应用已在前台时 am start 的 extra 走这里，同样要生效
        setIntent(launchIntent);
        if (launchIntent != null) handleLaunchExtras(launchIntent);
    }

    private void handleLaunchExtras(Intent launchIntent) {
        // M1: 调试/自动化参数仅 debug 构建响应；release 对 intent extra 不做任何动作，
        // 避免第三方应用通过显式 intent 操纵账号配置（如改写代理）。
        if (!LaunchCommands.enabled(BuildConfig.DEBUG)) return;
        LaunchCommands cmd = LaunchCommands.fromIntent(launchIntent);
        // 先切账号（switchTo 会关抽屉），再处理全屏，最后开抽屉，保证终态符合预期
        if (cmd.startAccount >= 0 && store.findById(cmd.startAccount) != null) {
            switchTo(cmd.startAccount, true);
        }
        if (cmd.hasFullscreen) {
            if (cmd.fullscreen) {
                enterFullscreen();
            } else {
                exitFullscreen();
            }
        }
        if (cmd.showDrawer) {
            drawerLayout.openDrawer(drawerContent);
        }
        if (cmd.hasOpenConfig) {
            long cfgId = cmd.openConfigId >= 0 ? cmd.openConfigId : store.getCurrentId();
            if (cfgId >= 0) {
                openConfig(cfgId, cmd.proxyPreset, cmd.proxyAutoTest, cmd.proxySave);
            }
        }
        if (cmd.searchQuery != null) {
            searchInput.setText(cmd.searchQuery);
        }
        if (cmd.dumpAuth) {
            dumpAuthState();
        }
        if (cmd.addAccount) {
            addAccount();
        }
        if (cmd.hasDelAccount && cmd.delAccountId >= 0 && store.findById(cmd.delAccountId) != null) {
            deleteAccount(cmd.delAccountId);
        }
    }

    private void dumpAuthState() {
        for (Account a : store.all()) {
            Profile p = profileStore.getProfile(profileName(a.id));
            String cookies = null;
            try {
                cookies = p != null ? p.getCookieManager().getCookie("https://muse.ai/") : null;
            } catch (Exception ignored) {
            }
            Log.i("MuseAuth", "acct=" + a.id + " name=" + a.name
                    + " cookies=" + cookieNames(cookies));
            WebView wv = webViews.get(a.id);
            if (wv != null) {
                wv.evaluateJavascript(
                        "(function(){try{return 'LS:'+(Object.keys(localStorage).join(',')||'-')"
                                + "+'|CK:'+document.cookie}catch(e){return 'ERR:'+e}})()",
                        v -> Log.i("MuseAuth", "acct=" + a.id + " js=" + v));
            } else {
                Log.i("MuseAuth", "acct=" + a.id + " js=<no webview>");
            }
        }
    }

    private static String cookieNames(String header) {
        if (header == null) return "null";
        StringBuilder sb = new StringBuilder("[");
        for (String c : header.split(";")) {
            c = c.trim();
            int eq = c.indexOf('=');
            sb.append(eq > 0 ? c.substring(0, eq) : c).append(' ');
        }
        return sb.append(']').toString();
    }

    // ---------- 全屏模式 ----------

    private void enterFullscreen() {
        if (fullscreen) return;
        fullscreen = true;
        store.setFullscreen(true);
        rail.setVisibility(View.GONE);
        edgeSwipe.setVisibility(View.VISIBLE);
        // 锁定抽屉，避免左缘手势先被抽屉拦截
        drawerLayout.setDrawerLockMode(DrawerLayout.LOCK_MODE_LOCKED_CLOSED);
        drawerLayout.closeDrawer(drawerContent);
    }

    private void exitFullscreen() {
        if (!fullscreen) return;
        fullscreen = false;
        store.setFullscreen(false);
        rail.setVisibility(View.VISIBLE);
        edgeSwipe.setVisibility(View.GONE);
        drawerLayout.setDrawerLockMode(DrawerLayout.LOCK_MODE_UNLOCKED);
    }

    // ---------- WebView（每账号独立实例） ----------

    private WebView getOrCreateWebView(final Account a) {
        WebView wv = webViews.get(a.id);
        if (wv != null) return wv;

        wv = new WebView(this);
        wv.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        wv.setBackgroundColor(0xFF121316);

        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setSupportMultipleWindows(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        // 去掉 WebView 标识（; wv / Version/4.0），否则 muse.ai 会把页面重定向到 Play 商店
        String systemUa = s.getUserAgentString();
        if (systemUa != null) {
            systemUa = systemUa.replace("; wv", "");
            systemUa = systemUa.replaceAll("\\s*Version/[\\d.]+", "");
        }
        // 账号配了 UA 预设时覆盖成对应平台的 Chrome UA；跟随系统时就是上面那串去标识 UA
        String accountUa = FingerprintScript.userAgent(a.fp, systemUa);
        if (accountUa != null && !accountUa.isEmpty()) s.setUserAgentString(accountUa);
        appliedFp.put((int) a.id, fpSignature(a.fp));

        wv.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                if (webErrored.get((int) a.id, false)) {
                    // 新一次加载开始：清错误标记，失败会由 onReceivedError 重新置位
                    webErrored.put((int) a.id, false);
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                webLoaded.put((int) a.id, true);
                failoverTried.put((int) a.id, false); // 加载成功：下轮再出错允许再换节点
                Long st = loadStartAt.get((int) a.id);
                if (st != null) {
                    Log.i("MusePerf", "load end id=" + a.id + " cost="
                            + (SystemClock.uptimeMillis() - st) + "ms errored="
                            + webErrored.get((int) a.id, false));
                    loadStartAt.remove((int) a.id);
                }
                if (a.id != store.getCurrentId()) return;
                if (webErrored.get((int) a.id, false)) {
                    showErrorOverlay(null); // 错误页已渲染，保持遮罩等用户重试
                } else {
                    hideErrorOverlay();
                }
                long elapsed = SystemClock.uptimeMillis() - splashShownAt;
                webContainer.postDelayed(hideSplashRunnable,
                        Math.max(0, MIN_SPLASH_MS - elapsed));
                refreshLogged();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request,
                                        WebResourceError error) {
                if (!request.isForMainFrame()) return;
                webErrored.put((int) a.id, true);
                Log.i("MusePerf", "load error id=" + a.id
                        + " desc=" + error.getDescription());
                if (a.id == store.getCurrentId()) {
                    showErrorOverlay(error.getDescription() != null
                            ? error.getDescription().toString() : null);
                }
                maybeFailover(a, view, error.getErrorCode());
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // M2: 渲染进程崩溃时销毁并重建该账号的 WebView，返回 true 拦截，避免拖垮整个应用。
                // 账号的 Profile 数据不受影响，重建后仍是同一隔离环境（登录态保留）。
                Long crashedId = null;
                for (Map.Entry<Long, WebView> en : webViews.snapshot().entrySet()) {
                    if (en.getValue() == view) {
                        crashedId = en.getKey();
                        break;
                    }
                }
                webViews.remove(crashedId != null ? crashedId : -1L);
                if (crashedId != null) webLoaded.remove(crashedId.intValue());
                webContainer.removeView(view);
                view.destroy();

                boolean wasCurrent = crashedId != null
                        && crashedId.longValue() == store.getCurrentId();
                if (wasCurrent) {
                    currentWebView = null;
                    Account ca = store.findById(crashedId);
                    WebView nv = ca != null ? getOrCreateWebView(ca) : null;
                    if (nv != null) {
                        nv.setVisibility(View.VISIBLE);
                        currentWebView = nv;
                    }
                }
                if (crashedId != null) {
                    Log.i("MuseWebview", "renderer gone, id=" + crashedId + " rebuilt=" + wasCurrent);
                    toast(getString(R.string.toast_webview_recovered));
                }
                return true;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                Uri u = Uri.parse(url);
                String scheme = u.getScheme();
                if ("http".equals(scheme) || "https".equals(scheme)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) {
                }
                return true;
            }
        });

        wv.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                    return true;
                } catch (Exception e) {
                    fileCallback = null;
                    toast(getString(R.string.toast_no_filechooser));
                    return false;
                }
            }
        });

        wv.setDownloadListener((url, userAgent, contentDisposition, mimeType, length) -> {
            try {
                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                req.setNotificationVisibility(
                        DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                if (userAgent != null) req.addRequestHeader("User-Agent", userAgent);
                DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                dm.enqueue(req);
                toast(getString(R.string.toast_download_started));
            } catch (Exception e) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (Exception ignored) {
                }
            }
        });

        // Profile 必须在任何页面加载前设置，且每个 WebView 只能设置一次
        try {
            WebViewCompat.setProfile(wv, profileName(a.id));
        } catch (Exception e) {
            wv.destroy();
            toast("创建隔离环境失败：" + e.getMessage());
            return null;
        }

        // 指纹脚本必须抢在页面脚本之前执行：用 document-start 注入而不是 onPageStarted +
        // evaluateJavascript，后者与页面首个脚本是竞态，navigator.webdriver 之类早读拿不到覆写值
        if (a.fp != null && FingerprintScript.hasOverrides(a.fp)
                && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            String script = FingerprintScript.documentStartScript(a.fp, a.id);
            if (script != null) {
                try {
                    WebViewCompat.addDocumentStartJavaScript(wv, script, Collections.singleton("*"));
                } catch (Exception e) {
                    Log.w("MuseFp", "inject failed id=" + a.id + " " + e.getMessage());
                }
            }
        }

        loadStartAt.put((int) a.id, SystemClock.uptimeMillis());
        Log.i("MusePerf", "load start id=" + a.id);
        wv.loadUrl(START_URL);
        webContainer.addView(wv);
        webViews.put(a.id, wv);
        return wv;
    }

    private void showErrorOverlay(String msg) {
        if (msg != null && !msg.isEmpty()) {
            errorMsg.setText(msg);
        } else {
            errorMsg.setText(R.string.error_generic);
        }
        errorOverlay.setVisibility(View.VISIBLE);
    }

    private void hideErrorOverlay() {
        errorOverlay.setVisibility(View.GONE);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(
                    WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
            return;
        }
        if (requestCode == REQ_CONFIG && resultCode == RESULT_OK) {
            // 配置已保存：代理/头像/名称可能变化，重新应用并重渲染
            Account cur = store.findById(store.getCurrentId());
            if (cur != null) {
                ProxyHelper.apply(cur.proxy);
                failoverTried.put((int) cur.id, false);
                String applied = appliedFp.get((int) cur.id);
                if (applied != null && !applied.equals(fpSignature(cur.fp))) {
                    // UA 与 document-start 脚本无法原地改：销毁重建该账号页面（Profile 保留，登录态不丢）
                    rebuildWebView(cur.id);
                    toast(getString(R.string.toast_fp_applied_next));
                }
            }
            renderAccounts();
            return;
        }
        if (requestCode == REQ_EXPORT) {
            String text = pendingExportText;
            pendingExportText = null;
            if (resultCode != RESULT_OK || data == null || data.getData() == null || text == null) return;
            try {
                writeText(data.getData(), text);
                toast(getString(R.string.backup_export_ok, store.all().size(),
                        displayName(data.getData())));
            } catch (Exception e) {
                toast(getString(R.string.backup_export_fail, String.valueOf(e.getMessage())));
            }
            return;
        }
        if (requestCode == REQ_IMPORT) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                handleImport(data.getData());
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (currentWebView != null) currentWebView.onResume();
        // 配置页等可能在别处改过存储；刷新内存列表并重应用当前账号代理
        store.reload();
        checkStoreNotice();
        refreshLogged();
        Account cur = store.findById(store.getCurrentId());
        ProxyHelper.apply(cur != null ? cur.proxy : "");
    }

    @Override
    protected void onPause() {
        if (currentWebView != null) currentWebView.onPause();
        try {
            for (Account a : store.all()) {
                Profile p = profileStore.getProfile(profileName(a.id));
                if (p != null) p.getCookieManager().flush();
            }
        } catch (Exception ignored) {
        }
        super.onPause();
    }

    @Override
    public void onBackPressed() {
        if (fullscreen) {
            exitFullscreen();
        } else if (drawerLayout.isDrawerOpen(drawerContent)) {
            drawerLayout.closeDrawer(drawerContent);
        } else if (currentWebView != null && currentWebView.canGoBack()) {
            currentWebView.goBack();
        } else {
            moveTaskToBack(true);
        }
    }

    // ---------- 账号操作 ----------

    private void openConfig(long id) {
        openConfig(id, null, false, false);
    }

    private void openConfig(long id, String proxyPreset, boolean autoTest, boolean autoSave) {
        Intent i = new Intent(this, AccountConfigActivity.class);
        i.putExtra("account_id", id);
        if (proxyPreset != null) {
            i.putExtra("proxy_preset", proxyPreset);
            i.putExtra("proxy_autotest", autoTest);
            i.putExtra("proxy_save", autoSave);
        }
        startActivityForResult(i, REQ_CONFIG);
    }

    private void addAccount() {
        // 新环境继承当前账号的代理：国内直连 muse.ai 不通，空代理的新环境必然卡在加载（问题 2）
        Account prev = store.findById(store.getCurrentId());
        Account a = store.addDefault(prev != null ? prev.proxy : null);
        editId = -1;
        confirmDelId = -1;
        switchTo(a.id, true);
        toast(getString(R.string.toast_created, a.name));
    }

    private void switchTo(long id, boolean animate) {
        Account a = store.findById(id);
        if (a == null) return;
        store.setCurrent(id);
        ProxyHelper.apply(a.proxy);
        renderAccounts();

        if (currentWebView != null) currentWebView.onPause();

        WebView target = getOrCreateWebView(a);
        if (target == null) return;

        target.setVisibility(View.VISIBLE);
        target.onResume();
        currentWebView = target;
        for (Map.Entry<Long, WebView> en : webViews.snapshot().entrySet()) {
            if (en.getValue() != target) en.getValue().setVisibility(View.GONE);
        }
        // M4: LRU 驱逐超出上限的旧账号页面（Profile 数据保留，仅页面状态丢弃）
        for (long evictedId : webViews.touchAndEvict(a.id, target)) {
            WebView old = webViews.remove(evictedId);
            if (old != null) {
                webLoaded.remove((int) evictedId);
                webContainer.removeView(old);
                old.destroy();
                Log.i("MuseWebview", "lru evict id=" + evictedId);
            }
        }

        // 目标页面若处于错误态：自动重新加载，避免停留在无法恢复的错误页（问题 1）
        if (webErrored.get((int) a.id, false)) {
            webErrored.put((int) a.id, false);
            loadStartAt.put((int) a.id, SystemClock.uptimeMillis());
            Log.i("MusePerf", "load reload-on-switch id=" + a.id);
            target.reload();
        }
        hideErrorOverlay();

        if (animate) showSplashFor(a);
        drawerLayout.closeDrawer(drawerContent);
    }

    private void commitRename(long id) {
        Account a = store.findById(id);
        editId = -1;
        if (a == null) {
            renderAccounts();
            return;
        }
        String name = renameInput != null ? renameInput.getText().toString().trim() : "";
        if (name.length() > 16) name = name.substring(0, 16);
        if (name.isEmpty() || name.equals(a.name)) {
            renderAccounts();
            return;
        }
        store.rename(id, name);
        renderAccounts();
        toast(getString(R.string.toast_renamed, name));
    }

    private void deleteAccount(long id) {
        Account a = store.findById(id);
        if (a == null) return;
        // 页面实例 / 指纹记录 / 隔离 Profile 一起清（与导入覆盖走同一条路径，避免两处漏项）
        purgeAccount(id);
        store.remove(id);
        editId = -1;
        confirmDelId = -1;
        renderAccounts();
        toast(getString(R.string.toast_deleted));
        long cur = store.getCurrentId();
        if (cur >= 0) switchTo(cur, true);
    }

    private void refreshLogged() {
        if (!probeRunning.compareAndSet(false, true)) {
            probeDirty.set(true); // 已有一轮在跑，结束后补一轮
            return;
        }
        probeQueue = new ArrayList<>(store.all());
        probeIndex = 0;
        probeChanged = false;
        probeStep();
    }

    private void probeStep() {
        if (probeQueue == null || probeIndex >= probeQueue.size()) {
            probeQueue = null;
            probeRunning.set(false);
            if (probeDirty.compareAndSet(true, false)) refreshLogged();
            return;
        }
        int end = Math.min(probeIndex + PROBE_CHUNK, probeQueue.size());
        for (int i = probeIndex; i < end; i++) {
            Account a = probeQueue.get(i);
            try {
                Profile p = profileStore.getProfile(profileName(a.id));
                // 不能用 hasCookies()：匿名访问也会落下 Cloudflare/Meta 埋点 cookie，一律误判已登录。
                // 只认 muse.ai 的登录会话 cookie hatch_sess。
                String cookies = p != null
                        ? p.getCookieManager().getCookie("https://muse.ai/") : null;
                boolean logged = cookies != null && cookies.contains(AUTH_COOKIE_MARKER);
                if (logged != a.logged) {
                    a.logged = logged;
                    probeChanged = true;
                }
            } catch (Exception ignored) {
            }
        }
        probeIndex = end;
        if (probeChanged && editId == -1 && confirmDelId == -1) renderAccounts();
        mainHandler.postDelayed(probeStep, 16); // 让出一帧再继续下一块
    }

    private String profileName(long id) {
        return "acct_" + id;
    }

    // ---------- 渲染 ----------

    private void renderAccounts() {
        railAvatars.removeAllViews();
        accountList.removeAllViews();
        String q = query();
        int shown = 0;
        for (Account a : store.all()) {
            if (!matches(a, q)) continue;
            shown++;
            railAvatars.addView(makeRailAvatar(a));
            accountList.addView(makeDrawerRow(a));
        }
        accCount.setText(getString(R.string.accounts_count_fmt, store.all().size()));
        emptyState.setVisibility(store.all().isEmpty() ? View.VISIBLE : View.GONE);
        drawerEmpty.setVisibility(!q.isEmpty() && shown == 0 ? View.VISIBLE : View.GONE);
    }

    private String query() {
        return searchInput != null ? searchInput.getText().toString().trim() : "";
    }

    /** 按 名称 + 标签 过滤（忽略大小写，空 query 全匹配） */
    private boolean matches(Account a, String q) {
        if (q.isEmpty()) return true;
        String key = q.toLowerCase();
        if (a.name.toLowerCase().contains(key)) return true;
        for (String t : a.tags) {
            if (t.toLowerCase().contains(key)) return true;
        }
        return false;
    }

    private void showSplashFor(Account a) {
        splashName.setText(a.name);
        splash.setVisibility(View.VISIBLE);
        splashShownAt = SystemClock.uptimeMillis();
        webContainer.removeCallbacks(hideSplashRunnable);
        // 已加载过的账号不会再次触发 onPageFinished，直接短延时收起
        Boolean loaded = webLoaded.get((int) a.id);
        if (loaded != null && loaded) {
            webContainer.postDelayed(hideSplashRunnable, 450);
        }
        // 兜底：加载异常时也不会卡在过渡层
        webContainer.postDelayed(hideSplashRunnable, SPLASH_TIMEOUT_MS);
    }

    private void hideSplash() {
        webContainer.removeCallbacks(hideSplashRunnable);
        splash.setVisibility(View.GONE);
    }

    private View makeRailAvatar(Account a) {
        FrameLayout wrap = new FrameLayout(this);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(40), dp(40));
        lp.topMargin = dp(4);
        lp.bottomMargin = dp(4);
        wrap.setLayoutParams(lp);
        wrap.setBackgroundResource(a.id == store.getCurrentId()
                ? R.drawable.bg_rail_active : R.drawable.bg_rail_btn);

        TextView tile = makeTile(dp(38), 20, a.avatar);
        wrap.addView(tile, new FrameLayout.LayoutParams(dp(38), dp(38), Gravity.CENTER));

        View dot = new View(this);
        dot.setBackgroundResource(a.logged ? R.drawable.bg_dot_on : R.drawable.bg_dot_off);
        FrameLayout.LayoutParams dlp = new FrameLayout.LayoutParams(dp(10), dp(10),
                Gravity.BOTTOM | Gravity.END);
        dlp.rightMargin = dp(1);
        dlp.bottomMargin = dp(1);
        wrap.addView(dot, dlp);

        wrap.setOnClickListener(v -> switchTo(a.id, true));
        return wrap;
    }

    private View makeDrawerRow(Account a) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(10), dp(9), dp(10), dp(9));
        LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        rlp.bottomMargin = dp(4);
        row.setLayoutParams(rlp);

        // 删除确认态
        if (confirmDelId == a.id) {
            row.setBackgroundResource(R.drawable.bg_row);
            TextView msg = new TextView(this);
            msg.setText(getString(R.string.confirm_delete_fmt, a.name));
            msg.setTextColor(COLOR_TEXT);
            msg.setTextSize(12.5f);
            msg.setLineSpacing(dp(2), 1f);
            row.addView(msg, new LinearLayout.LayoutParams(0,
                    ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            row.addView(makeTextBtn(getString(R.string.btn_delete), true,
                    v -> deleteAccount(a.id)));
            row.addView(makeTextBtn(getString(R.string.btn_cancel), false,
                    v -> {
                        confirmDelId = -1;
                        renderAccounts();
                    }));
            return row;
        }

        // 重命名编辑态
        if (editId == a.id) {
            row.setBackgroundResource(R.drawable.bg_row);
            row.addView(makeTile(dp(40), 20, a.avatar));

            EditText input = new EditText(this);
            input.setText(a.name);
            input.setTextColor(COLOR_TEXT);
            input.setHintTextColor(0xFF686E78);
            input.setHint(R.string.rename_hint);
            input.setTextSize(13.5f);
            input.setBackgroundResource(R.drawable.bg_rename);
            input.setSingleLine(true);
            input.setInputType(InputType.TYPE_CLASS_TEXT);
            input.setImeOptions(EditorInfo.IME_ACTION_DONE);
            input.setPadding(dp(10), dp(7), dp(10), dp(7));
            LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(0,
                    ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            ilp.leftMargin = dp(8);
            input.setLayoutParams(ilp);
            input.setOnEditorActionListener((v, actionId, event) -> {
                if (actionId == EditorInfo.IME_ACTION_DONE) {
                    commitRename(a.id);
                    return true;
                }
                return false;
            });
            row.addView(input);
            renameInput = input;

            row.addView(makeIconBtn(R.drawable.ic_check, 0xFFFFFFFF, R.drawable.bg_editbtn_ok,
                    getString(R.string.cd_rename), v -> commitRename(a.id)));
            row.addView(makeIconBtn(R.drawable.ic_close, COLOR_ICON, R.drawable.bg_editbtn,
                    getString(R.string.btn_cancel), v -> {
                        editId = -1;
                        renderAccounts();
                    }));
            row.post(() -> {
                input.requestFocus();
                input.selectAll();
            });
            return row;
        }

        // 常规态
        row.setBackgroundResource(a.id == store.getCurrentId()
                ? R.drawable.bg_row_active : R.drawable.bg_row);
        row.addView(makeTile(dp(40), 20, a.avatar));

        LinearLayout info = new LinearLayout(this);
        info.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        ilp.leftMargin = dp(11);
        info.setLayoutParams(ilp);

        TextView name = new TextView(this);
        name.setText(a.name);
        name.setTextColor(COLOR_TEXT);
        name.setTextSize(14.5f);
        name.setTypeface(Typeface.DEFAULT_BOLD);
        name.setMaxLines(1);
        name.setEllipsize(android.text.TextUtils.TruncateAt.END);
        info.addView(name);

        String status = getString(a.logged ? R.string.status_logged : R.string.status_not_logged);
        SpannableString ss = new SpannableString("●  " + status);
        ss.setSpan(new ForegroundColorSpan(a.logged ? 0xFF34C759 : 0xFF4A4F57),
                0, 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        TextView sub = new TextView(this);
        sub.setText(ss);
        sub.setTextColor(COLOR_MUTED);
        sub.setTextSize(11.5f);
        sub.setPadding(0, dp(3), 0, 0);
        sub.setMaxLines(1);
        sub.setEllipsize(android.text.TextUtils.TruncateAt.END);
        info.addView(sub);

        row.addView(info);
        row.addView(makeIconBtn(R.drawable.ic_settings, COLOR_ICON, R.drawable.bg_rail_btn,
                getString(R.string.cd_config), v -> openConfig(a.id)));
        row.addView(makeIconBtn(R.drawable.ic_pencil, COLOR_ICON, R.drawable.bg_rail_btn,
                getString(R.string.cd_rename), v -> {
                    editId = a.id;
                    confirmDelId = -1;
                    renderAccounts();
                }));
        row.addView(makeIconBtn(R.drawable.ic_trash, COLOR_ICON, R.drawable.bg_rail_btn,
                getString(R.string.cd_delete), v -> {
                    confirmDelId = a.id;
                    editId = -1;
                    renderAccounts();
                }));

        row.setOnClickListener(v -> switchTo(a.id, true));
        return row;
    }

    private TextView makeTile(int sizePx, float textSp, String text) {
        TextView t = new TextView(this);
        t.setBackgroundResource(R.drawable.bg_mtile);
        t.setText(text == null || text.isEmpty() ? "m" : text);
        t.setTypeface(Typeface.create("serif", Typeface.BOLD_ITALIC));
        t.setTextColor(0xFF2F7CF6);
        t.setTextSize(textSp);
        t.setGravity(Gravity.CENTER);
        t.setIncludeFontPadding(false);
        t.setLayoutParams(new ViewGroup.LayoutParams(sizePx, sizePx));
        return t;
    }

    private ImageButton makeIconBtn(int icon, int tint, int bg, String cd,
                                    View.OnClickListener onClick) {
        ImageButton b = new ImageButton(this);
        b.setImageResource(icon);
        b.setImageTintList(ColorStateList.valueOf(tint));
        b.setBackgroundResource(bg);
        b.setContentDescription(cd);
        b.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        b.setPadding(dp(6), dp(6), dp(6), dp(6));
        b.setOnClickListener(onClick);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(30), dp(30));
        lp.leftMargin = dp(6);
        b.setLayoutParams(lp);
        return b;
    }

    private TextView makeTextBtn(String text, boolean danger, View.OnClickListener onClick) {
        TextView b = new TextView(this);
        b.setText(text);
        b.setTextColor(0xFFFFFFFF);
        b.setTextSize(12);
        b.setGravity(Gravity.CENTER);
        b.setBackgroundResource(danger ? R.drawable.bg_delbtn_ok : R.drawable.bg_editbtn);
        b.setPadding(dp(10), dp(6), dp(10), dp(6));
        b.setOnClickListener(onClick);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.leftMargin = dp(6);
        b.setLayoutParams(lp);
        return b;
    }

    // ---------- 代理失败轮换 ----------

    /**
     * 主框架加载失败时，若账号配了多条代理且本轮还没换过，就换池里下一条重试。
     *
     * 只对"像代理问题"的错误码生效：域名解析/连接/超时/IO 失败。证书错误之类的换代理也没用，
     * 换了反而把用户的可用配置改坏。每轮只换一次，避免整池都死时无限 reload。
     */
    private void maybeFailover(Account a, WebView view, int errorCode) {
        if (!isProxyError(errorCode)) return;
        if (a.proxy == null || a.proxy.isEmpty()) return;          // 走系统网络失败：没有池可换
        if (a.proxyPool == null || a.proxyPool.size() < 2) return;
        if (failoverTried.get((int) a.id, false)) return;
        String before = a.proxy;
        String next = store.failoverProxy(a.id);
        if (next == null || next.equals(before)) return;
        failoverTried.put((int) a.id, true);
        ProxyHelper.apply(next);
        webErrored.put((int) a.id, false);
        loadStartAt.put((int) a.id, SystemClock.uptimeMillis());
        Log.i("MuseProxy", "failover id=" + a.id + " " + before + " -> " + next);
        if (a.id == store.getCurrentId()) {
            toast(getString(R.string.toast_proxy_failover, stripScheme(next)));
        }
        view.reload();
    }

    private static boolean isProxyError(int code) {
        return code == WebViewClient.ERROR_HOST_LOOKUP
                || code == WebViewClient.ERROR_PROXY_AUTHENTICATION
                || code == WebViewClient.ERROR_CONNECT
                || code == WebViewClient.ERROR_IO
                || code == WebViewClient.ERROR_TIMEOUT;
    }

    private static String stripScheme(String proxy) {
        int i = proxy.indexOf("://");
        return i >= 0 ? proxy.substring(i + 3) : proxy;
    }

    private static String fpSignature(Fingerprint f) {
        if (f == null) return "";
        return f.uaMode + "|" + f.uaCustom + "|" + f.timezone + "|" + f.locale
                + "|" + f.webdriver + "|" + f.noise + "|" + f.webrtc;
    }

    /** 销毁某账号的页面实例并重建（Profile 与登录态保留），用于指纹变更后让 UA/注入脚本重新生效 */
    private void rebuildWebView(long id) {
        WebView old = webViews.remove(id);
        if (old != null) {
            if (old == currentWebView) currentWebView = null;
            webContainer.removeView(old);
            old.destroy();
        }
        webLoaded.remove((int) id);
        webErrored.remove((int) id);
        appliedFp.remove((int) id);
        if (id == store.getCurrentId()) switchTo(id, false);
    }

    /** 清掉一个账号的全部运行时痕迹：页面实例 + 隔离 Profile（Cookie / localStorage / 存储） */
    private void purgeAccount(long id) {
        WebView wv = webViews.remove(id);
        if (wv != null) {
            if (wv == currentWebView) currentWebView = null;
            webContainer.removeView(wv);
            wv.destroy();
        }
        webLoaded.remove((int) id);
        webErrored.remove((int) id);
        appliedFp.remove((int) id);
        failoverTried.remove((int) id);
        try {
            Profile p = profileStore.getProfile(profileName(id));
            if (p != null) {
                p.getCookieManager().removeAllCookies(null);
                p.getCookieManager().flush();
                p.getWebStorage().deleteAllData();
            }
            profileStore.deleteProfile(profileName(id));
        } catch (Exception ignored) {
        }
    }

    // ---------- 备份：导出 ----------

    private void startExport() {
        if (store.all().isEmpty()) {
            toast(getString(R.string.backup_export_empty));
            return;
        }
        String[] modes = {
                getString(R.string.backup_mode_config),
                getString(R.string.backup_mode_cookies),
                getString(R.string.backup_mode_cookies_enc),
        };
        new AlertDialog.Builder(this)
                .setTitle(R.string.backup_export_title)
                .setItems(modes, (d, which) -> {
                    if (which == 2) {
                        askPassword(R.string.backup_password_title, pw -> exportNow(true, pw));
                    } else {
                        exportNow(which == 1, null);
                    }
                })
                .show();
    }

    private void exportNow(boolean includeCookies, String password) {
        Map<Long, String> cookies = includeCookies ? collectCookies() : null;
        String json = BackupCodec.toJson(store.snapshot(), cookies, System.currentTimeMillis());
        if (json == null) {
            toast(getString(R.string.backup_export_fail, "序列化失败"));
            return;
        }
        String text = json;
        if (password != null) {
            try {
                text = BackupCrypto.encrypt(json, password);
            } catch (Exception e) {
                toast(getString(R.string.backup_export_fail, String.valueOf(e.getMessage())));
                return;
            }
        }
        pendingExportText = text;
        String stamp = new SimpleDateFormat("yyyyMMdd-HHmm", Locale.US).format(new Date());
        String name = "muse-accounts-" + stamp + (password != null ? ".mbak" : ".json");
        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType(password != null ? "application/octet-stream" : "application/json")
                .putExtra(Intent.EXTRA_TITLE, name);
        try {
            startActivityForResult(i, REQ_EXPORT);
        } catch (Exception e) {
            pendingExportText = null;
            toast(getString(R.string.backup_export_fail, String.valueOf(e.getMessage())));
        }
    }

    /** 逐账号取 muse.ai 的 cookie 头（含 httpOnly 的 hatch_sess，这是登录态的唯一凭据） */
    private Map<Long, String> collectCookies() {
        Map<Long, String> out = new LinkedHashMap<>();
        for (Account a : store.all()) {
            try {
                Profile p = profileStore.getProfile(profileName(a.id));
                if (p == null) continue;
                String c = p.getCookieManager().getCookie("https://muse.ai/");
                if (c != null && !c.isEmpty()) out.put(a.id, c);
            } catch (Exception ignored) {
            }
        }
        return out;
    }

    // ---------- 备份：导入 ----------

    private void startImport() {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType("*/*");
        try {
            startActivityForResult(i, REQ_IMPORT);
        } catch (Exception e) {
            toast(getString(R.string.backup_import_bad));
        }
    }

    private void handleImport(Uri uri) {
        String text;
        try {
            text = readText(uri);
        } catch (Exception e) {
            toast(getString(R.string.backup_import_bad));
            return;
        }
        if (text == null || text.trim().isEmpty()) {
            toast(getString(R.string.backup_import_bad));
            return;
        }
        if (BackupCrypto.isEncrypted(text)) {
            askPassword(R.string.backup_import_password_title, pw -> parseAndImport(text, pw));
        } else {
            parseAndImport(text, null);
        }
    }

    private void parseAndImport(String text, String password) {
        String json = text;
        if (password != null) {
            try {
                json = BackupCrypto.decrypt(text, password);
            } catch (Exception e) {
                toast(getString(R.string.backup_import_password_wrong));
                return;
            }
        }
        BackupCodec.Snapshot snap = BackupCodec.parse(json);
        if (snap == null || snap.accounts.isEmpty()) {
            toast(getString(R.string.backup_import_bad));
            return;
        }
        String[] modes = {
                getString(R.string.backup_import_merge),
                getString(R.string.backup_import_replace),
        };
        new AlertDialog.Builder(this)
                .setTitle(R.string.backup_import_mode_title)
                .setItems(modes, (d, which) -> {
                    if (which == 1) {
                        new AlertDialog.Builder(this)
                                .setTitle(R.string.backup_import_mode_title)
                                .setMessage(getString(R.string.backup_import_confirm_replace,
                                        store.all().size()))
                                .setNegativeButton(R.string.btn_cancel, null)
                                .setPositiveButton(R.string.btn_delete,
                                        (d2, w2) -> doImport(snap, true))
                                .show();
                    } else {
                        doImport(snap, false);
                    }
                })
                .show();
    }

    private void doImport(BackupCodec.Snapshot snap, boolean replaceAll) {
        AccountsStore.ImportOutcome out = store.importAccounts(snap.accounts, replaceAll);
        // 覆盖导入：旧账号的隔离环境必须一起删掉，否则 Profile 会在设备上越积越多
        for (long oldId : out.removedIds) purgeAccount(oldId);
        int restored = 0;
        for (Map.Entry<Long, String> e : snap.cookies.entrySet()) {
            Long newId = out.idMap.get(e.getKey());
            if (newId == null) continue;     // 同名跳过/未导入的账号没有落点
            if (applyCookies(newId, e.getValue())) restored++;
        }
        failoverTried.clear();
        appliedFp.clear();
        webLoaded.clear();
        webErrored.clear();
        loadStartAt.clear();
        renderAccounts();
        toast(getString(R.string.backup_import_done, out.added, out.skipped));
        if (restored > 0) toast(getString(R.string.backup_cookie_restored, restored));
        long cur = store.getCurrentId();
        if (cur >= 0) switchTo(cur, false);
        refreshLogged();
    }

    /**
     * 把 cookie 头逐条写回账号的隔离 Profile。
     *
     * 说明：CookieManager 只能接受单条 Set-Cookie 形式，所以这里把 "k=v; k2=v2" 拆开重挂，
     * 统一落到 muse.ai 域（同时覆盖 www 子域）并保留 HttpOnly —— 会话 cookie 掉了 HttpOnly
     * 会变成页面 JS 可读，等于把登录凭据暴露给站点脚本。
     */
    private boolean applyCookies(long accountId, String header) {
        if (header == null || header.isEmpty()) return false;
        try {
            // 必须用 getOrCreate：导入到新机的账号还没建过 WebView，getProfile 会返回 null，
            // 那样 Cookie 会静默写不进去（表现为"导入成功但全是未登录"）
            Profile p = profileStore.getOrCreateProfile(profileName(accountId));
            if (p == null) return false;
            CookieManager cm = p.getCookieManager();
            boolean any = false;
            for (String part : header.split(";")) {
                String kv = part.trim();
                if (kv.isEmpty()) continue;
                int eq = kv.indexOf('=');
                if (eq <= 0) continue;
                String cname = kv.substring(0, eq).trim();
                String value = kv.substring(eq + 1).trim();
                if (cname.isEmpty()) continue;
                cm.setCookie("https://muse.ai/", cname + "=" + value
                        + "; Domain=muse.ai; Path=/; Secure; HttpOnly");
                any = true;
            }
            cm.flush();
            return any;
        } catch (Exception e) {
            return false;
        }
    }

    /** 密码输入对话框（导出加密口令 / 导入解密口令共用一个） */
    private interface PassCallback {
        void onPass(String password);
    }

    private void askPassword(int titleRes, PassCallback cb) {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        input.setHint(R.string.backup_password_hint);
        input.setSingleLine(true);
        FrameLayout wrap = new FrameLayout(this);
        wrap.setPadding(dp(18), dp(8), dp(18), 0);
        wrap.addView(input);
        new AlertDialog.Builder(this)
                .setTitle(titleRes)
                .setView(wrap)
                .setNegativeButton(R.string.btn_cancel, null)
                .setPositiveButton(R.string.btn_ok, (d, w) -> {
                    String pw = input.getText().toString();
                    if (pw.length() < 6) {
                        toast(getString(R.string.backup_password_short));
                        return;
                    }
                    cb.onPass(pw);
                })
                .show();
    }

    private String readText(Uri uri) throws Exception {
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            if (in == null) throw new Exception("无法读取文件");
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            int total = 0;
            while ((n = in.read(buf)) > 0) {
                total += n;
                if (total > 16 * 1024 * 1024) throw new Exception("备份文件过大");
                bos.write(buf, 0, n);
            }
            return new String(bos.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private void writeText(Uri uri, String text) throws Exception {
        try (OutputStream out = getContentResolver().openOutputStream(uri, "wt")) {
            if (out == null) throw new Exception("无法写入文件");
            out.write(text.getBytes(StandardCharsets.UTF_8));
            out.flush();
        }
    }

    /** SAF 的 Uri 拿不到真实文件名，优先查 _display_name，退回最后一段路径 */
    private String displayName(Uri uri) {
        try (android.database.Cursor c = getContentResolver().query(uri,
                new String[]{"_display_name"}, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String n = c.getString(0);
                if (n != null && !n.isEmpty()) return n;
            }
        } catch (Exception ignored) {
        }
        String last = uri.getLastPathSegment();
        return last != null ? last : uri.toString();
    }

    // ---------- 其他 ----------

    private void showWebViewUpgradeDialog() {
        new AlertDialog.Builder(this)
                .setTitle(R.string.webview_need_update_title)
                .setMessage(R.string.webview_need_update_msg)
                .setCancelable(false)
                .setPositiveButton(R.string.webview_update_btn, (d, w) -> {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW,
                                Uri.parse("market://details?id=com.google.android.webview")));
                    } catch (Exception e) {
                        try {
                            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(
                                    "https://play.google.com/store/apps/details?id=com.google.android.webview")));
                        } catch (Exception ignored) {
                        }
                    }
                    finish();
                })
                .setNegativeButton(R.string.btn_exit, (d, w) -> finish())
                .show();
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }

    /** M3: 账号存储损坏/自愈提示（takeLoadNotice 取走即清，不重复弹） */
    private void checkStoreNotice() {
        String n = store.takeLoadNotice();
        if ("recovered".equals(n)) {
            toast(getString(R.string.toast_store_recovered));
        } else if ("corrupt".equals(n)) {
            toast(getString(R.string.toast_store_corrupt));
        }
    }

    private int dp(int v) {
        return Math.round(getResources().getDisplayMetrics().density * v);
    }
}
