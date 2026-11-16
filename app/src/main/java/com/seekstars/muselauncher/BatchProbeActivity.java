package com.seekstars.muselauncher;

import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.view.View;
import android.view.ViewGroup;
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
 * 代理栈，测出来的"通"才和真实浏览一致；代理 URL 账密不受此接口支持。用 Java 网络栈测通、
 * WebView 却连不上，是这类工具最常见的假阳性来源。
 */
public class BatchProbeActivity extends AppCompatActivity {

    private AccountsStore store;

    private LinearLayout listView;
    private TextView progressView;
    private TextView startBtn;
    private TextView cleanBtn;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final List<Item> items = new ArrayList<>();
    /** 已测出失效的代理：账号 id → 失效代理集合，供"清理失效项"使用 */
    private final java.util.Map<Long, Set<String>> failed = new java.util.HashMap<>();

    private WebViewProbe probe;
    private boolean paused;
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
    protected void onResume() {
        super.onResume();
        paused = false;
    }

    @Override
    protected void onPause() {
        paused = true;
        stop();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        running = false;
        handler.removeCallbacksAndMessages(null);
        closeProbe();
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
        proxy.setText(ProxyPolicy.display(it.proxy));
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
        if (paused || running || isFinishing() || !ProxyHelper.supported()) return;
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
        cleanBtn.setEnabled(false);
        probe = new WebViewProbe(this);
        startBtn.setText(R.string.batch_stop);
        updateProgress();
        probeNext();
    }

    private void stop() {
        running = false;
        handler.removeCallbacksAndMessages(null);
        closeProbe();
        startBtn.setText(R.string.batch_start);
        cleanBtn.setEnabled(ProxyHelper.supported());
        updateProgress();
    }

    private void probeNext() {
        if (!running || paused) return;
        if (index >= items.size()) {
            running = false;
            startBtn.setText(R.string.batch_start);
            closeProbe();
            cleanBtn.setEnabled(true);
            updateProgress();
            return;
        }
        Item it = items.get(index);
        if (it.statusView != null) {
            it.statusView.setText(R.string.batch_working);
            it.statusView.setTextColor(getColor(R.color.text_secondary));
        }
        updateProgress();

        probe.run(it.proxy, this::finishItem);
    }

    private void finishItem(boolean ok, String err, long ms) {
        if (!running || paused) return;

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

    private void closeProbe() {
        if (probe == null) return;
        WebViewProbe old = probe;
        probe = null;
        Account current = store == null ? null : store.findById(store.getCurrentId());
        old.close(current == null ? "" : current.proxy);
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
            ProxyPolicy.Cleanup cleanup = ProxyPolicy.cleanup(a.proxyPool, a.proxy, dead);
            if (cleanup.removed == 0) continue;
            store.setProxyPool(a.id, cleanup.kept, cleanup.active);
            affectedAccounts++;
            removed += cleanup.removed;
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

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }

    private int dp(int v) {
        return Math.round(getResources().getDisplayMetrics().density * v);
    }
}
