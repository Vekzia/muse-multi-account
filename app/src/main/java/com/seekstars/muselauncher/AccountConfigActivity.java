package com.seekstars.muselauncher;

import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.widget.ArrayAdapter;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.Spinner;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;

import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.ArrayList;
import java.util.List;

/** 账号配置页：头像 / 名称 / 代理 / 标签，代理测活 */
public class AccountConfigActivity extends AppCompatActivity {

    private WebViewProbe probe;
    private boolean paused;
    /** Clash 默认端口：7890 混合(HTTP+SOCKS) / 7891 纯 HTTP / 7892 纯 SOCKS */
    private static final int[] CLASH_PORTS = {7890, 7891, 7892};
    private static final int PROBE_TIMEOUT_MS = 400;

    private AccountsStore store;
    private Account account;

    private TextView tile;
    private EditText avatarInput;
    private EditText nameInput;
    private EditText proxyInput;
    private EditText tagsInput;
    private EditText poolInput;
    private TextView poolStatus;
    private TextView poolTestAllBtn;
    private Spinner fpUaSpinner;
    private EditText fpUaCustomInput;
    private EditText fpTzInput;
    private EditText fpLocaleInput;
    private CheckBox fpWebdriverBox;
    private CheckBox fpNoiseBox;
    private CheckBox fpWebrtcBox;
    private TextView detectBtn;
    private TextView testBtn;
    private TextView testStatus;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean testing = false;
    private boolean detecting = false;
    /** proxy_save 调试模式：测活通过后自动入库（免触摸配置代理） */
    private boolean pendingSave = false;
    /** Spinner 下标 ↔ Fingerprint.UA_* 的映射，顺序与 fp_ua_* 文案一致 */
    private static final String[] UA_MODES = {
            Fingerprint.UA_SYSTEM, Fingerprint.UA_WINDOWS, Fingerprint.UA_MACOS,
            Fingerprint.UA_ANDROID, Fingerprint.UA_CUSTOM};

    /** 池内批量测活状态：串行跑（ProxyController 是全局开关，不能并发） */
    private boolean poolTesting = false;
    private List<String> poolQueue = new ArrayList<>();
    private int poolIndex;
    private int poolOk;
    private int poolFail;
    private final StringBuilder poolLog = new StringBuilder();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_config);

        long id = getIntent().getLongExtra("account_id", -1L);
        store = new AccountsStore(this);
        account = store.findById(id);
        if (account == null) {
            finish();
            return;
        }

        tile = findViewById(R.id.cfgTile);
        avatarInput = findViewById(R.id.cfgAvatar);
        nameInput = findViewById(R.id.cfgName);
        proxyInput = findViewById(R.id.cfgProxy);
        tagsInput = findViewById(R.id.cfgTags);
        poolInput = findViewById(R.id.cfgPool);
        poolStatus = findViewById(R.id.cfgPoolStatus);
        poolTestAllBtn = findViewById(R.id.cfgPoolTestAll);
        fpUaSpinner = findViewById(R.id.cfgFpUa);
        fpUaCustomInput = findViewById(R.id.cfgFpUaCustom);
        fpTzInput = findViewById(R.id.cfgFpTz);
        fpLocaleInput = findViewById(R.id.cfgFpLocale);
        fpWebdriverBox = findViewById(R.id.cfgFpWebdriver);
        fpNoiseBox = findViewById(R.id.cfgFpNoise);
        fpWebrtcBox = findViewById(R.id.cfgFpWebrtc);
        detectBtn = findViewById(R.id.cfgProxyDetect);
        testBtn = findViewById(R.id.cfgProxyTest);
        testStatus = findViewById(R.id.cfgProxyStatus);
        TextView proxyNote = new TextView(this);
        proxyNote.setText(R.string.proxy_runtime_note);
        proxyNote.setTextColor(getColor(R.color.text_muted));
        proxyNote.setTextSize(11.5f);
        ((android.view.ViewGroup) testStatus.getParent()).addView(proxyNote);

        findViewById(R.id.cfgBack).setOnClickListener(v -> finish());
        findViewById(R.id.cfgSave).setOnClickListener(v -> save());
        testBtn.setOnClickListener(v -> testProxy());
        detectBtn.setOnClickListener(v -> detectProxy());
        poolTestAllBtn.setOnClickListener(v -> startPoolTest());

        avatarInput.setText(account.avatar);
        nameInput.setText(account.name);
        proxyInput.setText(account.proxy);
        tagsInput.setText(TextUtils.join(", ", account.tags));
        poolInput.setText(ProxyPool.join(account.proxyPool));
        bindFingerprint();
        updateTile();
        avatarInput.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int a, int b, int c) {
            }

            @Override
            public void onTextChanged(CharSequence s, int a, int b, int c) {
            }

            @Override
            public void afterTextChanged(Editable s) {
                updateTile();
            }
        });

        if (!ProxyHelper.supported()) {
            testStatus.setText(R.string.config_proxy_unsupported);
            testBtn.setEnabled(false);
            detectBtn.setEnabled(false);
        }

        // 调试入口：预填代理 + 自动测活/自动保存（真机无法 adb 触摸，用于验证与配置代理）
        String preset = getIntent().getStringExtra("proxy_preset");
        if (preset != null) {
            proxyInput.setText(preset);
            if (getIntent().getBooleanExtra("proxy_save", false)) {
                pendingSave = true;
                proxyInput.post(this::testProxy);
            } else if (getIntent().getBooleanExtra("proxy_autotest", false)) {
                proxyInput.post(this::testProxy);
            }
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        paused = false;
    }

    @Override
    protected void onPause() {
        paused = true;
        cancelProbes();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        cancelProbes();
        super.onDestroy();
    }

    private void closeProbe() {
        if (probe == null) return;
        WebViewProbe old = probe;
        probe = null;
        Account current = store == null ? null : store.findById(store.getCurrentId());
        old.close(current == null ? "" : current.proxy);
    }

    private void cancelProbes() {
        testing = false;
        poolTesting = false;
        pendingSave = false;
        handler.removeCallbacksAndMessages(null);
        closeProbe();
        if (testBtn != null) {
            testBtn.setEnabled(ProxyHelper.supported());
            testBtn.setText(R.string.config_proxy_test);
            poolTestAllBtn.setEnabled(ProxyHelper.supported());
        }
    }

    private void updateTile() {
        String av = avatarInput.getText().toString().trim();
        if (av.length() > 2) av = av.substring(0, 2);
        tile.setText(av.isEmpty() ? "m" : av);
    }

    private void save() {
        if (persist()) finish();
    }

    /** 读取输入并写入 store（不退出页面，供测活通过后自动入库复用） */
    private boolean persist() {
        List<String> pool = ProxyPool.parse(poolInput.getText().toString());
        String active = ProxyPolicy.savedActive(proxyInput.getText().toString(), account.proxy, pool);
        if (active == null) {
            proxyInput.setError(getString(proxyInput.getText().toString().contains("@")
                    ? R.string.proxy_auth_unsupported : R.string.proxy_invalid));
            return false;
        }

        String avatar = avatarInput.getText().toString().trim();
        if (avatar.isEmpty()) avatar = "m";
        if (avatar.length() > 2) avatar = avatar.substring(0, 2);
        account.avatar = avatar;

        String name = nameInput.getText().toString().trim();
        if (!name.isEmpty()) {
            account.name = name.length() > 16 ? name.substring(0, 16) : name;
        }

        account.proxy = active;
        account.proxyPool = ProxyPool.merge(pool, active);
        account.fp = readFingerprint();

        List<String> tags = new ArrayList<>();
        for (String t : tagsInput.getText().toString().split("[,，]")) {
            String tag = t.trim();
            if (!tag.isEmpty()) tags.add(tag.length() > 8 ? tag.substring(0, 8) : tag);
        }
        account.tags = tags;

        store.save();
        setResult(RESULT_OK);
        return true;
    }

    // ---------- 指纹 ----------

    private void bindFingerprint() {
        String[] labels = {
                getString(R.string.fp_ua_system),
                getString(R.string.fp_ua_windows),
                getString(R.string.fp_ua_macos),
                getString(R.string.fp_ua_android),
                getString(R.string.fp_ua_custom),
        };
        ArrayAdapter<String> adapter = new ArrayAdapter<>(this,
                android.R.layout.simple_spinner_item, labels);
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        fpUaSpinner.setAdapter(adapter);

        Fingerprint f = account.fp != null ? account.fp : new Fingerprint();
        fpUaSpinner.setSelection(indexOfMode(f.uaMode));
        fpUaCustomInput.setText(f.uaCustom);
        fpTzInput.setText(f.timezone);
        fpLocaleInput.setText(f.locale);
        fpWebdriverBox.setChecked(f.webdriver);
        fpNoiseBox.setChecked(f.noise);
        fpWebrtcBox.setChecked(f.webrtc);
    }

    private static int indexOfMode(String mode) {
        for (int i = 0; i < UA_MODES.length; i++) {
            if (UA_MODES[i].equals(mode)) return i;
        }
        return 0;
    }

    /** 从界面读出指纹并做合法化（未知 UA 预设回落 system，时区/语言只允许安全字符） */
    private Fingerprint readFingerprint() {
        Fingerprint f = new Fingerprint();
        int pos = fpUaSpinner.getSelectedItemPosition();
        f.uaMode = pos >= 0 && pos < UA_MODES.length ? UA_MODES[pos] : Fingerprint.UA_SYSTEM;
        f.uaCustom = fpUaCustomInput.getText().toString().trim();
        f.timezone = fpTzInput.getText().toString().trim();
        f.locale = fpLocaleInput.getText().toString().trim();
        f.webdriver = fpWebdriverBox.isChecked();
        f.noise = fpNoiseBox.isChecked();
        f.webrtc = fpWebrtcBox.isChecked();
        f.sanitize();
        return f;
    }

    // ---------- 池内批量测活 ----------

    private void startPoolTest() {
        if (paused || isFinishing() || poolTesting || testing || !ProxyHelper.supported()) return;
        poolQueue = ProxyPool.parse(poolInput.getText().toString());
        if (poolQueue.isEmpty()) {
            poolStatus.setText(R.string.config_pool_empty);
            return;
        }
        poolTesting = true;
        poolIndex = poolOk = poolFail = 0;
        poolLog.setLength(0);
        poolTestAllBtn.setEnabled(false);
        testBtn.setEnabled(false);
        probe = new WebViewProbe(this);
        probePoolNext();
    }

    private void probePoolNext() {
        if (!poolTesting || paused) return;
        if (poolIndex >= poolQueue.size()) {
            poolTesting = false;
            poolTestAllBtn.setEnabled(true);
            testBtn.setEnabled(true);
            poolStatus.setText(poolLog.toString().trim());
            closeProbe();
            return;
        }
        String proxy = poolQueue.get(poolIndex);
        poolStatus.setText(getString(R.string.config_pool_testing, poolIndex + 1,
                poolQueue.size(), ProxyPolicy.display(proxy)));
        probe.run(proxy, this::finishPoolItem);
    }

    private void finishPoolItem(boolean ok, String err, long ms) {
        if (!poolTesting || paused) return;
        String proxy = ProxyPolicy.display(poolQueue.get(poolIndex));
        if (ok) {
            poolOk++;
            poolLog.append(getString(R.string.config_pool_ok, proxy, ms)).append('\n');
        } else {
            poolFail++;
            poolLog.append(getString(R.string.config_pool_fail, proxy, err)).append('\n');
        }
        poolStatus.setText(poolLog.toString().trim());
        poolIndex++;
        handler.post(this::probePoolNext);
    }

    // ---------- 代理测活 ----------

    private void testProxy() {
        if (paused || isFinishing() || testing || poolTesting || !ProxyHelper.supported()) return;
        String proxy = proxyInput.getText().toString().trim();
        if (proxy.isEmpty()) {
            testStatus.setText(R.string.config_proxy_empty);
            return;
        }
        testing = true;
        testBtn.setEnabled(false);
        poolTestAllBtn.setEnabled(false);
        testBtn.setText(R.string.config_proxy_testing);
        testStatus.setText("");
        probe = new WebViewProbe(this);
        probe.run(proxy, this::finishTest);
    }

    // ---------- Clash 端口探测 ----------

    private void detectProxy() {
        if (paused || detecting || testing || poolTesting) return;
        detecting = true;
        detectBtn.setEnabled(false);
        testStatus.setText(R.string.config_proxy_detecting);
        new Thread(() -> {
            int port = probeLocalProxy();
            runOnUiThread(() -> {
                detecting = false;
                if (isDestroyed() || isFinishing()) return;
                detectBtn.setEnabled(true);
                if (paused || testing || poolTesting) return;
                if (port > 0) {
                    proxyInput.setText(proxyUrlForPort(port));
                    testStatus.setText(getString(R.string.config_proxy_detect_found, port));
                } else {
                    testStatus.setText(R.string.config_proxy_detect_none);
                }
            });
        }).start();
    }

    /** 探测本机 Clash 默认端口，返回首个在监听的端口，未找到返回 0 */
    private static int probeLocalProxy() {
        for (int p : CLASH_PORTS) {
            try (Socket s = new Socket()) {
                s.connect(new InetSocketAddress("127.0.0.1", p), PROBE_TIMEOUT_MS);
                return p;
            } catch (Exception ignored) {
            }
        }
        return 0;
    }

    private static String proxyUrlForPort(int port) {
        // 7892 是纯 SOCKS，其余按 HTTP 混合端口处理
        return (port == 7892 ? "socks5://" : "http://") + "127.0.0.1:" + port;
    }

    private void finishTest(boolean ok, String err, long ms) {
        if (!testing || paused) return;
        testing = false;
        testBtn.setEnabled(true);
        poolTestAllBtn.setEnabled(true);
        testBtn.setText(R.string.config_proxy_test);
        boolean shouldSave = pendingSave;
        pendingSave = false;
        if (ok) {
            testStatus.setText(getString(R.string.config_proxy_ok) + "（" + ms + " ms）");
            if (shouldSave && persist()) {
                testStatus.setText(getString(R.string.config_proxy_saved)
                        + " · " + getString(R.string.config_proxy_ok) + "（" + ms + " ms）");
            }
        } else {
            testStatus.setText(getString(R.string.config_proxy_fail) + err);
        }
        closeProbe();
    }
}
