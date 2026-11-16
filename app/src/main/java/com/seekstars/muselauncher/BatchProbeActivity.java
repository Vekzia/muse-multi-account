package com.seekstars.muselauncher;

import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.TextUtils;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.HttpAuthHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * 批量测活：把「每个账号的每条代理」摊平成一个队列，串行跑一遍真实连通性测试。
 *
 * <p>为什么必须串行：{@code WebViewController 的 ProxyController} 是应用级全局开关，
 * 同一时刻只能有一条代理生效；并发测活时后一条会覆盖前一条，测出来的结果全是错的。
 *
 * <p>为什么用隐藏 WebView 而不是 {@code HttpURLConnection}：WebView 用的正是跑页面时的那套
 * 代理栈（含 407 挑战、SOCKS 认证），测出来的"通"才和真实浏览一致；用 Java 网络栈测通、
 * WebView 却连不上，是这类工具最常见的假阳性来源。
 */
public class BatchProbeActivity extends AppCompatActivity {

    private static final String TEST_URL = "https://www.gstatic.com/generate_204";
    private static final long PROBE_TIMEOUT_MS = 8000;

    private AccountsStore store;

    private LinearLayout listView;
    private TextView progressView;
    private TextView startBtn;
    private TextView cleanBtn;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final List<Item> items = new ArrayList<>();
    /** 已测出失效的代理：账号 id → 失效代理集合，供"清理失效项"使用 */
    private final java.util.Map<Long, Set<String>> failed = new java.util.HashMap<>();

    private WebView probeView;
    private Runnable timeoutRunnable;
    private String[] probeCreds;
    private int index;
    private boolean running;

    /** 一行待测项：某账号的某条代理 */
    private static final class Item {
        final long accountId;
        final String accountName;
        final String proxy;
        TextView statusView;
        Boolean ok;          // null 未测，true/false 结果

        Item(long accountId, String accountName, String proxy) {
            this.accountId = accountId;
            this.accountName = accountName;
            this.proxy = proxy;
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_batch_probe);

        store = new AccountsStore(this);
        listView = findViewById(R.id.probeList);
        progressView = findViewById(R.id.probeProgress);
        startBtn = findViewById(R.id.probeStart);
        cleanBtn = findViewById(R.id.probeClean);

        findViewById(R.id.probeBack).setOnClickListener(v -> finish());
        startBtn.setOnClickListener(v -> {
            if (running) stop();
            else start();
        });
        cleanBtn.setOnClickListener(v -> cleanFailed());

        if (!ProxyHelper.supported()) {
            progressView.setText(R.string.batch_unsupported);
            startBtn.setEnabled(false);
            cleanBtn.setEnabled(false);
        }
        buildItems();
        render();
    }

    @Override
    protected void onDestroy() {
        running = false;
        handler.removeCallbacksAndMessages(null);
        destroyProbeView();
        // 测活期间改了全局代理，退出时恢复当前账号的配置，否则主页面会莫名其妙走最后一条测试代理
        Account cur = store.findById(store.getCurrentId());
        ProxyHelper.apply(cur != null ? cur.proxy : "");
        super.onDestroy();
    }

    // ---------- 队列构建与渲染 ----------

    private void buildItems() {
        items.clear();
        for (Account a : store.all()) {
            List<String> pool = a.proxyPool;
            if (pool == null || pool.isEmpty()) {
                if (a.proxy != null && !a.proxy.isEmpty()) {
                    items.add(new Item(a.id, a.name, ProxyPool.normalize(a.proxy)));
                }
                continue;
            }
            for (String p : pool) {
                items.add(new Item(a.id, a.name, ProxyPool.normalize(p)));
            }
        }
    }

    private void render() {
        listView.removeAllViews();
        if (items.isEmpty()) {
            TextView empty = new TextView(this);
            empty.setText(R.string.batch_none);
            empty.setTextColor(getColor(R.color.text_muted));
            empty.setTextSize(13f);
            empty.setPadding(dp(4), dp(20), dp(4), dp(4));
            listView.addView(empty);
            progressView.setText(getString(R.string.batch_idle, 0));
            return;
        }
        for (Item it : items) {
            listView.addView(makeRow(it));
        }
        updateProgress();
    }

    private View makeRow(Item it) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.VERTICAL);
        row.setBackgroundResource(R.drawable.bg_row);
        row.setPadding(dp(11), dp(9), dp(11), dp(9));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = dp(5);
        row.setLayoutParams(lp);

        TextView title = new TextView(this);
        title.setText(it.accountName);
        title.setTextColor(getColor(R.color.text_primary));
        title.setTextSize(13.5f);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        row.addView(title);

        TextView proxy = new TextView(this);
        proxy.setText(it.proxy);
        proxy.setTextColor(getColor(R.color.text_muted));
        proxy.setTextSize(11.5f);
        proxy.setPadding(0, dp(3), 0, 0);
        proxy.setSingleLine(true);
        proxy.setEllipsize(TextUtils.TruncateAt.MIDDLE);
        row.addView(proxy);

        TextView status = new TextView(this);
        status.setText(R.string.batch_waiting);
        status.setTextColor(getColor(R.color.text_dim));
        status.setTextSize(11.5f);
        status.setPadding(0, dp(3), 0, 0);
        row.addView(status);
        it.statusView = status;
        return row;
    }

    private void updateProgress() {
        int done = 0;
        int bad = 0;
        for (Item it : items) {
            if (it.ok != null) {
                done++;
                if (!it.ok) bad++;
            }
        }
        if (running) {
            progressView.setText(getString(R.string.batch_running, Math.min(done + 1, items.size()),
                    items.size()));
        } else if (done == 0) {
            progressView.setText(getString(R.string.batch_idle, items.size()));
        } else {
            progressView.setText(getString(R.string.batch_done, done - bad, bad));
        }
    }

    // ---------- 串行测活 ----------

    private void start() {
        if (items.isEmpty()) {
            buildItems();
            render();
            if (items.isEmpty()) return;
        }
        for (Item it : items) {
            it.ok = null;
            if (it.statusView != null) {
                it.statusView.setText(R.string.batch_waiting);
                it.statusView.setTextColor(getColor(R.color.text_dim));
            }
        }
        failed.clear();
        index = 0;
        running = true;
        startBtn.setText(R.string.batch_stop);
        updateProgress();
        probeNext();
    }

    private void stop() {
        running = false;
        handler.removeCallbacksAndMessages(null);
        destroyProbeView();
        startBtn.setText(R.string.batch_start);
        restoreProxy(store.getCurrentId());
        updateProgress();
    }

    private void probeNext() {
        if (!running) return;
        if (index >= items.size()) {
            running = false;
            startBtn.setText(R.string.batch_start);
            restoreProxy(store.getCurrentId());
            updateProgress();
            return;
        }
        Item it = items.get(index);
        if (it.statusView != null) {
            it.statusView.setText(R.string.batch_working);
            it.statusView.setTextColor(getColor(R.color.text_secondary));
        }
        updateProgress();

        ProxyHelper.apply(it.proxy);
        probeCreds = parseProxyCreds(it.proxy);
        final long startAt = SystemClock.uptimeMillis();

        probeView = new WebView(this);
        probeView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                finishItem(true, null, SystemClock.uptimeMillis() - startAt);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request,
                                        WebResourceError error) {
                if (request.isForMainFrame()) {
                    finishItem(false, String.valueOf(error.getDescription()), 0);
                }
            }

            @Override
            public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler,
                                                  String host, String realm) {
                // 代理 407 挑战：用 URL 内嵌账密应答
                if (probeCreds != null) {
                    handler.proceed(probeCreds[0], probeCreds[1]);
                } else {
                    handler.cancel();
                    finishItem(false, "需要代理认证", 0);
                }
            }
        });
        timeoutRunnable = () -> finishItem(false, null, 0);
        handler.postDelayed(timeoutRunnable, PROBE_TIMEOUT_MS);
        probeView.loadUrl(TEST_URL);
    }

    private void finishItem(boolean ok, String err, long ms) {
        if (!running) return;
        handler.removeCallbacks(timeoutRunnable);
        destroyProbeView();

        if (index < items.size()) {
            Item it = items.get(index);
            it.ok = ok;
            if (!ok) {
                Set<String> set = failed.get(it.accountId);
                if (set == null) {
                    set = new HashSet<>();
                    failed.put(it.accountId, set);
                }
                set.add(it.proxy);
            }
            if (it.statusView != null) {
                if (ok) {
                    it.statusView.setText(getString(R.string.batch_ok_fmt, ms));
                    it.statusView.setTextColor(getColor(R.color.green));
                } else {
                    String reason = err == null ? getString(R.string.config_proxy_timeout) : err;
                    it.statusView.setText(getString(R.string.batch_fail_fmt, reason));
                    it.statusView.setTextColor(0xFFE0645C);
                }
            }
        }
        index++;
        updateProgress();
        handler.postDelayed(this::probeNext, 60); // 让出主线程，尺寸动画/滚动不掉帧
    }

    private void destroyProbeView() {
        if (probeView != null) {
            probeView.destroy();
            probeView = null;
        }
    }

    /** 测活结束/中断后把全局代理恢复到指定账号的配置 */
    private void restoreProxy(long accountId) {
        Account a = store.findById(accountId);
        ProxyHelper.apply(a != null ? a.proxy : "");
    }

    // ---------- 清理失效项 ----------

    private void cleanFailed() {
        if (running) return;
        int affectedAccounts = 0;
        int removed = 0;
        for (Account a : new ArrayList<>(store.all())) {
            Set<String> dead = failed.get(a.id);
            if (dead == null || dead.isEmpty()) continue;
            if (a.proxyPool == null || a.proxyPool.isEmpty()) continue; // 单条代理：不删，删了就彻底没网
            List<String> kept = new ArrayList<>();
            for (String p : a.proxyPool) {
                if (!dead.contains(ProxyPool.normalize(p))) kept.add(p);
            }
            if (kept.isEmpty()) continue; // 全灭时保留原样，交给用户决定，不能清成空池
            String active = kept.contains(ProxyPool.normalize(a.proxy)) ? a.proxy : kept.get(0);
            store.setProxyPool(a.id, kept, active);
            affectedAccounts++;
            removed += a.proxyPool.size() - kept.size();
        }
        if (removed == 0) {
            toast(getString(R.string.batch_clean_none));
            return;
        }
        toast(getString(R.string.batch_cleaned, affectedAccounts, removed));
        buildItems();
        failed.clear();
        render();
    }

    // ---------- 工具 ----------

    /** 从代理地址解析 [user, pass]，无凭证返回 null（与配置页保持一致的口径） */
    private static String[] parseProxyCreds(String p) {
        if (p == null) return null;
        int at = p.lastIndexOf('@');
        if (at < 0) return null;
        String head = p.substring(0, at);
        int si = head.indexOf("://");
        String creds = si >= 0 ? head.substring(si + 3) : head;
        if (creds.isEmpty()) return null;
        int c = creds.indexOf(':');
        if (c < 0) return new String[]{creds, ""};
        return new String[]{creds.substring(0, c), creds.substring(c + 1)};
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }

    private int dp(int v) {
        return Math.round(getResources().getDisplayMetrics().density * v);
    }
}
