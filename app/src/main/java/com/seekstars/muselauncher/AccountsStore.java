package com.seekstars.muselauncher;

import android.content.Context;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 账号元数据持久化。各账号的登录数据由 WebView Profile 负责持久化。
 *
 * 防损设计（M3）：
 * - 每次成功保存前，把上一次的 list 值滚动备份到 list_prev；
 * - list 解析失败时：原始值留底到 list_corrupt（可人工找回），并尝试从 list_prev 自愈；
 * - 单条账号数据损坏只跳过该条，不影响其余；
 * - loadNotice 通过 takeLoadNotice() 上抛给 UI 提示用户。
 */
public class AccountsStore {
    private static final String PREFS = "accounts";
    private static final String KEY_FULLSCREEN = "fullscreen";

    private final KeyValueStore prefs;
    private final List<Account> accounts = new ArrayList<>();
    private long nextId = 1;
    private long currentId = -1;
    private String loadNotice;

    public AccountsStore(Context ctx) {
        this(new SharedPreferencesStore(ctx, PREFS));
    }

    /** 测试用：注入任意键值实现 */
    public AccountsStore(KeyValueStore store) {
        prefs = store;
        load();
    }

    public synchronized void reload() {
        load();
    }

    private void load() {
        loadNotice = null;
        accounts.clear();
        List<Account> parsed = AccountJsonCodec.fromJsonOrNull(prefs.getString("list", "[]"));
        if (parsed == null) {
            String raw = prefs.getString("list", "");
            if (raw != null && !raw.isEmpty() && !"[]".equals(raw)) {
                // 原始数据留底，避免被后续保存彻底覆盖，人工可找回
                prefs.putString("list_corrupt", raw);
                loadNotice = "corrupt";
            }
            // 尝试从上一次保存前的备份自愈
            List<Account> recovered = AccountJsonCodec.fromJsonOrNull(prefs.getString("list_prev", null));
            if (recovered != null && !recovered.isEmpty()) {
                accounts.addAll(recovered);
                loadNotice = "recovered";
                // 只写回 list 主键。此时 nextId/currentId 还没从磁盘读入，
                // 绝不能走完整 save()（会用字段默认值 nextId=1 覆盖真实值，造成 id 冲突）
                String json = AccountJsonCodec.toJson(accounts);
                if (json != null) prefs.putString("list", json);
            }
        } else {
            accounts.addAll(parsed);
        }
        nextId = prefs.getLong("nextId", 1);
        currentId = prefs.getLong("currentId", -1);
        if (accounts.isEmpty()) {
            currentId = -1;
        } else if (findById(currentId) == null) {
            currentId = accounts.get(0).id;
        }
    }

    public synchronized void save() {
        try {
            String json = AccountJsonCodec.toJson(accounts);
            if (json == null) return; // 序列化异常：跳过本次写盘，保留旧数据
            Map<String, Object> vals = new HashMap<>();
            String prevList = prefs.getString("list", null);
            if (prevList != null) vals.put("list_prev", prevList); // 滚动备份
            vals.put("list", json);
            vals.put("nextId", nextId);
            vals.put("currentId", currentId);
            prefs.putAll(vals);
        } catch (Exception ignored) {
        }
    }

    /**
     * 取走本次加载的结果提示：null=正常，"recovered"=已从备份自愈，"corrupt"=损坏已留底。
     * 取走后清空，避免重复提示。
     */
    public synchronized String takeLoadNotice() {
        String n = loadNotice;
        loadNotice = null;
        return n;
    }

    public synchronized List<Account> all() {
        return accounts;
    }

    public synchronized Account findById(long id) {
        for (Account a : accounts) {
            if (a.id == id) return a;
        }
        return null;
    }

    public synchronized long getCurrentId() {
        return currentId;
    }

    /** 新建账号，默认名 "Muse N"（N 与账号 id 一致）。 */
    public synchronized Account addDefault() {
        Account a = new Account(nextId, "Muse " + nextId);
        nextId++;
        accounts.add(a);
        currentId = a.id;
        save();
        return a;
    }

    /** 新建账号并继承指定代理（国内直连 muse.ai 不通，新环境沿用可用网络路径），返回新账号。 */
    public synchronized Account addDefault(String inheritProxy) {
        Account a = addDefault();
        if (inheritProxy != null && !inheritProxy.isEmpty()) {
            a.proxy = inheritProxy;
            save();
        }
        return a;
    }

    public synchronized void rename(long id, String name) {
        Account a = findById(id);
        if (a != null) {
            a.name = name;
            save();
        }
    }

    public synchronized void remove(long id) {
        Account a = findById(id);
        if (a != null) accounts.remove(a);
        if (currentId == id) {
            currentId = accounts.isEmpty() ? -1 : accounts.get(0).id;
        }
        save();
    }

    public synchronized void setCurrent(long id) {
        if (currentId == id) return; // 无变化不写盘
        currentId = id;
        // M4: 只写 currentId 独立键，不再全量序列化账号列表（账号多时切换零开销）
        prefs.putLong("currentId", id);
    }

    // ---------- 代理池 ----------

    /**
     * 设置账号的代理池：active 会被提到池首，其余去重。
     * active 为空/非法时池内顺序原样保留，不改 account.proxy（避免把空代理写成显式项）。
     */
    public synchronized void setProxyPool(long id, List<String> pool, String active) {
        Account a = findById(id);
        if (a == null) return;
        a.proxyPool = ProxyPool.merge(pool, active);
        String act = ProxyPool.normalize(active);
        if (!act.isEmpty() && ProxyPool.isValid(act)) a.proxy = act;
        save();
    }

    /**
     * 当前代理疑似不通时，轮换到池里下一条并**落盘**。
     * 之所以持久化：否则每次冷启动都会先拿这条死代理重试一遍，白等一轮超时。
     *
     * @return 新代理；池里没有可换的（空/只有一条）返回 null，调用方保持原状
     */
    public synchronized String failoverProxy(long id) {
        Account a = findById(id);
        if (a == null) return null;
        String next = ProxyPool.next(a.proxyPool, a.proxy);
        if (next == null) return null;
        a.proxy = next;
        save();
        return next;
    }

    // ---------- 备份 / 导入 ----------

    /** 导入结果：新增条数、因重名跳过条数、旧 id → 新 id 映射（Cookie 回填用）、被清掉的旧 id */
    public static final class ImportOutcome {
        public int added;
        public int skipped;
        public final Map<Long, Long> idMap = new LinkedHashMap<>();
        public final List<Long> removedIds = new ArrayList<>();
    }

    /** 导出用深拷贝快照：导出过程中 UI 线程可能改账号，不能把活引用传出去 */
    public synchronized List<Account> snapshot() {
        List<Account> out = new ArrayList<>(accounts.size());
        for (Account a : accounts) out.add(a.copy());
        return out;
    }

    /**
     * 导入账号。
     *
     * 设计取舍：
     * - 备份里的 id 只在本机有意义，导入时**一律重新分配** id，避免和现有账号撞车
     *   （profile 名是 acct_&lt;id&gt;，撞 id 等于撞隔离环境）；
     * - 同名账号视为重复，跳过而不是覆盖——覆盖会连带毁掉本机已有的登录态；
     * - replaceAll=true 时先清空内存列表，旧 id 通过 removedIds 交回给调用方删 Profile。
     */
    public synchronized ImportOutcome importAccounts(List<Account> incoming, boolean replaceAll) {
        ImportOutcome out = new ImportOutcome();
        if (incoming == null || incoming.isEmpty()) return out;
        if (replaceAll) {
            for (Account a : accounts) out.removedIds.add(a.id);
            accounts.clear();
            currentId = -1;
        }
        for (Account src : incoming) {
            if (src == null) continue;
            String name = src.name != null ? src.name.trim() : "";
            if (name.isEmpty()) {
                out.skipped++;
                continue;
            }
            boolean dup = false;
            for (Account ex : accounts) {
                if (ex.name.equals(name)) {
                    dup = true;
                    break;
                }
            }
            if (dup) {
                out.skipped++;
                continue;
            }
            Account cp = src.copy();
            cp.fp.sanitize();
            Account a = new Account(nextId++, name);
            a.avatar = cp.avatar;
            a.proxy = cp.proxy;
            a.proxyPool = cp.proxyPool;
            a.tags = cp.tags;
            a.fp = cp.fp;
            accounts.add(a);
            out.idMap.put(src.id, a.id);
            out.added++;
        }
        if (currentId < 0 && !accounts.isEmpty()) currentId = accounts.get(0).id;
        save();
        return out;
    }

    public boolean isFullscreen() {
        return prefs.getBoolean(KEY_FULLSCREEN, false);
    }

    public void setFullscreen(boolean v) {
        prefs.putBoolean(KEY_FULLSCREEN, v);
    }
}
