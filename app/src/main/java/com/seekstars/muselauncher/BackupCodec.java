package com.seekstars.muselauncher;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 备份文件（整包导出/导入）的编解码，纯 Java 可单元测试。
 *
 * 设计要点：
 * 1) 账号字段的读写一律转调 {@link AccountJsonCodec}，两处不各写一份 schema，
 *    否则以后给 Account 加字段时必然出现"正常存档有、备份里丢"的漂移。
 * 2) 解析对任何输入都不抛异常，坏数据一律降级为 null / 跳过单条：
 *    备份文件来自用户 U 盘、聊天记录、旧版本 App，是典型的不受信输入，
 *    导入流程不能因为一个坏字节就把整包丢掉，也不能让异常冒到 UI 线程。
 * 3) schema 采用"向后兼容、拒绝向前"策略：旧版本能读的文件继续能读，
 *    比自己新的文件直接拒绝——把新字段当旧格式读会把用户数据静默写坏。
 */
final class BackupCodec {

    /** 当前备份格式版本。加字段不需要升版本（读取端忽略未知字段），改语义才升。 */
    static final int SCHEMA = 1;

    /** 文件头标记，用来把"这是本 App 的备份"和任意 JSON 区分开 */
    static final String APP = "muse-launcher";

    /** cookie 单条长度上限：正常 Cookie 头远小于此，超过必然是注入/垃圾数据 */
    static final int MAX_COOKIE_LEN = 8192;

    private BackupCodec() {
    }

    /**
     * 序列化为备份文件文本。
     *
     * @param accounts      账号列表；null 或空都合法（输出 accounts:[]）
     * @param cookieHeaders 账号 id → Cookie 头；null 或不含该 id 时省略 cookies 字段
     * @param exportedAt    导出时间戳（毫秒），由调用方给，便于测试固定
     * @return 失败返回 null。单条账号序列化异常只跳过该条，不影响其余账号。
     */
    static String toJson(List<Account> accounts, Map<Long, String> cookieHeaders, long exportedAt) {
        try {
            JSONObject root = new JSONObject();
            root.put("app", APP);
            root.put("schema", SCHEMA);
            root.put("exportedAt", exportedAt);
            JSONArray arr = new JSONArray();
            if (accounts != null) {
                for (Account a : accounts) {
                    if (a == null) continue;
                    JSONObject o = new JSONObject();
                    try {
                        // 复用 AccountJsonCodec：id/name/avatar/proxy/proxyPool/tags/fp 全在这里
                        AccountJsonCodec.putAccount(o, a);
                    } catch (Exception ignoredEntry) {
                        // 单条脏数据（如 proxyPool 为 null）不该毁掉整份备份
                        continue;
                    }
                    String cookie = cookieHeaders == null ? null : cookieHeaders.get(a.id);
                    if (cookie != null && !cookie.isEmpty()) {
                        o.put("cookies", cookie);
                    }
                    arr.put(o);
                }
            }
            root.put("accounts", arr);
            return root.toString();
        } catch (Exception e) {
            // 走到这里说明连空壳 JSONObject 都构造不出来，调用方应提示导出失败
            return null;
        }
    }

    /**
     * 解析备份文件。
     *
     * @return 结构不可用时返回 null（null/空白/非 JSON/accounts 不是数组/
     *         schema 不在 1..SCHEMA）。单条账号损坏只跳过该条。
     */
    static Snapshot parse(String raw) {
        if (raw == null) return null;
        String text = raw.trim();
        if (text.isEmpty()) return null;

        JSONObject root;
        try {
            root = new JSONObject(text);
        } catch (Exception e) {
            return null;
        }

        // schema 缺失按 -1 处理 → 拒绝；大于 SCHEMA 的是新版文件，必须拒绝而不是猜
        int schema = root.optInt("schema", -1);
        if (schema < 1 || schema > SCHEMA) return null;

        JSONArray arr = root.optJSONArray("accounts");
        if (arr == null) return null;   // 含 accounts 是字符串/对象/缺失的情况

        // exportedAt 只是展示用（"这份备份是哪天导的"），坏了不影响数据本身
        long exportedAt = root.optLong("exportedAt", 0L);

        List<Account> accounts = new ArrayList<>();
        Map<Long, String> cookies = new LinkedHashMap<>();
        boolean hadFingerprint = false;
        boolean hadCookies = false;

        for (int i = 0; i < arr.length(); i++) {
            JSONObject o;
            try {
                o = arr.getJSONObject(i);
            } catch (Exception ignoredEntry) {
                continue;   // 该位置不是对象
            }
            Account a;
            try {
                a = AccountJsonCodec.readAccount(o);
            } catch (Exception ignoredEntry) {
                continue;   // id/name 缺失或类型错
            }
            if (a.fp == null) a.fp = new Fingerprint();
            // 备份文件可能被手工改过或来自别的分支，读入后统一复核一遍指纹字段
            a.fp.sanitize();

            // "文件里带 fp" 以原始 JSON 是否有该对象为准：这正是导入界面要告知用户的
            if (o.optJSONObject("fp") != null) hadFingerprint = true;

            Object rawCookie = o.opt("cookies");
            if (rawCookie != null && rawCookie != JSONObject.NULL) {
                // 非字符串的 cookies 直接当损坏处理，不做 toString 兜底
                String cookie = rawCookie instanceof String ? sanitizeCookie((String) rawCookie) : null;
                if (cookie != null) {
                    cookies.put(a.id, cookie);
                    hadCookies = true;   // 被丢弃的非法 cookie 不算"有登录态可恢复"
                }
            }

            accounts.add(a);
        }

        return new Snapshot(schema, exportedAt, accounts, cookies, hadFingerprint, hadCookies);
    }

    /**
     * Cookie 头校验，返回 null 表示丢弃该条。
     *
     * 超长和 CR/LF 必须挡掉：备份文件可以被人为构造，cookie 最终会塞进 OkHttp 请求头，
     * 换行就是响应拆分/头注入的入口。制表符放行是因为它不破坏头结构。
     */
    static String sanitizeCookie(String v) {
        if (v == null || v.isEmpty()) return null;
        if (v.length() > MAX_COOKIE_LEN) return null;
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            if (c < 0x20 && c != '\t') return null;
        }
        return v;
    }

    /**
     * 解析结果。
     *
     * List/Map 在构造时做防御性拷贝并包成不可变视图：导入流程会把这个快照
     * 分发给多个步骤（去重、写库、报错汇总），谁顺手 add/remove 一下就会串味，
     * 这里直接让它改不动。元素本身仍是可变的 Account，导入时要 copy() 后再改。
     */
    static final class Snapshot {
        public final int schema;
        public final long exportedAt;
        /** 已 sanitize 的账号，永不为 null */
        public final List<Account> accounts;
        /** 账号 id → Cookie 头，永不为 null，可为空 */
        public final Map<Long, String> cookies;
        /** 文件里至少一条账号带 fp */
        public final boolean hadFingerprint;
        /** 至少一条账号的 cookie 通过校验被保留 */
        public final boolean hadCookies;

        Snapshot(int schema, long exportedAt, List<Account> accounts, Map<Long, String> cookies,
                 boolean hadFingerprint, boolean hadCookies) {
            this.schema = schema;
            this.exportedAt = exportedAt;
            this.accounts = Collections.unmodifiableList(new ArrayList<>(accounts));
            this.cookies = Collections.unmodifiableMap(new LinkedHashMap<>(cookies));
            this.hadFingerprint = hadFingerprint;
            this.hadCookies = hadCookies;
        }
    }
}
