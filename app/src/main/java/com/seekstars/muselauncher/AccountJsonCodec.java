package com.seekstars.muselauncher;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** 账号列表 JSON 编解码（纯 Java，可单元测试）。读取对损坏数据有容错。 */
final class AccountJsonCodec {

    private AccountJsonCodec() {
    }

    /** 序列化失败（理论上不会发生）返回 null，调用方应跳过本次写盘以保留旧数据 */
    static String toJson(List<Account> accounts) {
        try {
            JSONArray arr = new JSONArray();
            for (Account a : accounts) {
                JSONObject o = new JSONObject();
                putAccount(o, a);
                arr.put(o);
            }
            return arr.toString();
        } catch (Exception e) {
            return null;
        }
    }

    /** 写单个账号字段；备份编解码复用同一实现，避免两处 schema 漂移 */
    static void putAccount(JSONObject o, Account a) throws Exception {
        o.put("id", a.id);
        o.put("name", a.name);
        o.put("avatar", a.avatar);
        o.put("proxy", a.proxy);
        JSONArray poolArr = new JSONArray();
        for (String p : a.proxyPool) poolArr.put(p);
        o.put("proxyPool", poolArr);
        JSONArray tagArr = new JSONArray();
        for (String t : a.tags) tagArr.put(t);
        o.put("tags", tagArr);
        o.put("group", a.group == null ? "" : a.group);
        o.put("pinned", a.pinned);
        o.put("lastUsedAt", a.lastUsedAt);
        if (a.fp != null && a.fp.anyOverride()) o.put("fp", fingerprintToJson(a.fp));
    }

    /** 读单个账号（id/name 缺失时抛异常，由调用方跳过该条）；未知字段一律忽略 */
    static Account readAccount(JSONObject o) throws Exception {
        Account a = new Account(o.getLong("id"), o.getString("name"));
        a.avatar = o.optString("avatar", "m");
        a.proxy = o.optString("proxy", "");
        JSONArray poolArr = o.optJSONArray("proxyPool");
        if (poolArr != null) {
            for (int j = 0; j < poolArr.length(); j++) {
                String p = poolArr.optString(j);
                if (!p.isEmpty() && !a.proxyPool.contains(p)) a.proxyPool.add(p);
            }
        }
        JSONArray tagArr = o.optJSONArray("tags");
        if (tagArr != null) {
            for (int j = 0; j < tagArr.length(); j++) {
                String t = tagArr.optString(j);
                if (!t.isEmpty()) a.tags.add(t);
            }
        }
        a.group = normalizeGroup(o.optString("group", ""));
        a.pinned = o.optBoolean("pinned", false);
        a.lastUsedAt = Math.max(0L, o.optLong("lastUsedAt", 0L));
        a.fp = fingerprintFromJson(o.optJSONObject("fp"));
        return a;
    }

    static JSONObject fingerprintToJson(Fingerprint f) throws Exception {
        JSONObject o = new JSONObject();
        o.put("uaMode", f.uaMode);
        if (f.uaCustom != null && !f.uaCustom.isEmpty()) o.put("uaCustom", f.uaCustom);
        if (f.timezone != null && !f.timezone.isEmpty()) o.put("tz", f.timezone);
        if (f.locale != null && !f.locale.isEmpty()) o.put("locale", f.locale);
        if (f.webdriver) o.put("webdriver", true);
        if (f.noise) o.put("noise", true);
        if (f.webrtc) o.put("webrtc", true);
        return o;
    }

    /** null / 非法输入返回默认指纹（旧的备份文件和旧版本数据都没有 fp 字段） */
    static Fingerprint fingerprintFromJson(JSONObject o) {
        Fingerprint f = new Fingerprint();
        if (o == null) return f;
        f.uaMode = o.optString("uaMode", Fingerprint.UA_SYSTEM);
        f.uaCustom = o.optString("uaCustom", "");
        f.timezone = o.optString("tz", "");
        f.locale = o.optString("locale", "");
        f.webdriver = o.optBoolean("webdriver", false);
        f.noise = o.optBoolean("noise", false);
        f.webrtc = o.optBoolean("webrtc", false);
        f.sanitize();
        return f;
    }

    static String normalizeGroup(String value) {
        if (value == null) return "";
        String group = value.trim();
        return group.length() <= 24 ? group : group.substring(0, 24);
    }

    /**
     * 解析账号列表。
     *
     * @return 顶层不是合法 JSON 数组时返回 null（由调用方走备份恢复）；
     *         数组合法但某一条目字段损坏时跳过该条目，其余照常返回。
     */
    static List<Account> fromJsonOrNull(String raw) {
        if (raw == null) return null;
        JSONArray arr;
        try {
            arr = new JSONArray(raw);
        } catch (Exception e) {
            return null;
        }
        List<Account> out = new ArrayList<>();
        for (int i = 0; i < arr.length(); i++) {
            try {
                out.add(readAccount(arr.getJSONObject(i)));
            } catch (Exception ignoredEntry) {
                // 单条损坏不影响其余条目
            }
        }
        return out;
    }
}
