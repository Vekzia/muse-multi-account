package com.seekstars.muselauncher;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** 备份文件编解码：往返一致、脏数据容错、不可变快照 */
public class BackupCodecTest {

    private static final long T = 1699999999999L;

    /** 3 个账号，第 1 个把 proxyPool/tags/fp 全字段铺满 */
    private List<Account> sample() {
        List<Account> l = new ArrayList<>();

        Account a = new Account(1L, "Muse 1");
        a.avatar = "😊";
        a.proxy = "http://1.2.3.4:3129";
        a.proxyPool.add("http://1.2.3.4:3129");
        a.proxyPool.add("socks5://5.6.7.8:1080");
        a.tags.add("主力");
        a.tags.add("电商");
        a.fp = new Fingerprint();
        a.fp.uaMode = Fingerprint.UA_WINDOWS;
        a.fp.uaCustom = "";
        a.fp.timezone = "America/Los_Angeles";
        a.fp.locale = "en-US";
        a.fp.webdriver = true;
        a.fp.noise = true;
        a.fp.webrtc = true;
        l.add(a);

        Account b = new Account(3L, "Muse 3");
        b.avatar = "m";
        b.proxy = "http://9.9.9.9:8080";
        b.proxyPool.add("http://9.9.9.9:8080");
        b.tags.add("备用");
        Fingerprint fb = new Fingerprint();
        fb.uaMode = Fingerprint.UA_MACOS;
        fb.timezone = "Asia/Shanghai";
        fb.webdriver = true;
        b.fp = fb;
        l.add(b);

        l.add(new Account(5L, "干杂活"));
        return l;
    }

    private static Map<Long, String> cookies() {
        Map<Long, String> m = new HashMap<>();
        m.put(1L, "hatch_sess=abc; _ga=GA1.1");
        m.put(3L, "hatch_sess=xyz");
        return m;
    }

    @Test
    public void roundTrip_preservesAllFields() {
        String json = BackupCodec.toJson(sample(), cookies(), T);
        assertNotNull(json);
        BackupCodec.Snapshot snap = BackupCodec.parse(json);
        assertNotNull(snap);
        assertEquals(BackupCodec.SCHEMA, snap.schema);
        assertEquals(1, snap.schema);
        assertEquals(T, snap.exportedAt);
        assertEquals(3, snap.accounts.size());

        Account a = snap.accounts.get(0);
        assertEquals(1L, a.id);
        assertEquals("Muse 1", a.name);
        assertEquals("😊", a.avatar);
        assertEquals("http://1.2.3.4:3129", a.proxy);
        assertEquals(2, a.proxyPool.size());
        assertEquals("http://1.2.3.4:3129", a.proxyPool.get(0));
        assertEquals("socks5://5.6.7.8:1080", a.proxyPool.get(1));
        assertEquals(2, a.tags.size());
        assertEquals("主力", a.tags.get(0));
        assertEquals("电商", a.tags.get(1));
        assertEquals(Fingerprint.UA_WINDOWS, a.fp.uaMode);
        assertEquals("America/Los_Angeles", a.fp.timezone);
        assertEquals("en-US", a.fp.locale);
        assertTrue(a.fp.webdriver);
        assertTrue(a.fp.noise);
        assertTrue(a.fp.webrtc);

        Account b = snap.accounts.get(1);
        assertEquals(3L, b.id);
        assertEquals(Fingerprint.UA_MACOS, b.fp.uaMode);
        assertEquals("Asia/Shanghai", b.fp.timezone);
        assertTrue(b.fp.webdriver);
        assertFalse(b.fp.noise);

        Account c = snap.accounts.get(2);
        assertEquals("干杂活", c.name);
        assertTrue(c.tags.isEmpty());
        assertFalse(c.fp.anyOverride());

        assertEquals("hatch_sess=abc; _ga=GA1.1", snap.cookies.get(1L));
        assertEquals("hatch_sess=xyz", snap.cookies.get(3L));
    }

    @Test
    public void rootShape_isBackupEnvelope() throws Exception {
        String json = BackupCodec.toJson(sample(), null, T);
        JSONObject root = new JSONObject(json);
        assertEquals("muse-launcher", root.getString("app"));
        assertEquals(1, root.getInt("schema"));
        assertEquals(T, root.getLong("exportedAt"));
        assertEquals(3, root.getJSONArray("accounts").length());
    }

    @Test
    public void emptyList_isValidBackup() {
        String json = BackupCodec.toJson(new ArrayList<>(), null, T);
        assertNotNull(json);
        assertTrue(json.contains("\"accounts\":[]"));
        BackupCodec.Snapshot snap = BackupCodec.parse(json);
        assertNotNull(snap);
        assertTrue(snap.accounts.isEmpty());
        assertTrue(snap.cookies.isEmpty());
        assertFalse(snap.hadFingerprint);
        assertFalse(snap.hadCookies);

        // accounts 传 null 也不该炸
        BackupCodec.Snapshot snap2 = BackupCodec.parse(BackupCodec.toJson(null, null, T));
        assertNotNull(snap2);
        assertTrue(snap2.accounts.isEmpty());
    }

    @Test
    public void cookies_omittedWhenNoValueAndKeptOtherwise() {
        String noCookies = BackupCodec.toJson(sample(), null, T);
        assertFalse(noCookies.contains("\"cookies\""));

        String onlyOne = BackupCodec.toJson(sample(), cookies(), T);
        assertTrue(onlyOne.contains("hatch_sess=abc"));
        assertTrue(onlyOne.contains("hatch_sess=xyz"));

        BackupCodec.Snapshot snap = BackupCodec.parse(noCookies);
        assertTrue(snap.cookies.isEmpty());
        assertFalse(snap.hadCookies);

        // 空串 cookie 视为没有值，不写字段
        Map<Long, String> empty = new HashMap<>();
        empty.put(1L, "");
        assertFalse(BackupCodec.toJson(sample(), empty, T).contains("\"cookies\""));
    }

    @Test
    public void parse_invalidOrIncompatible_returnsNull() {
        assertNull(BackupCodec.parse(null));
        assertNull(BackupCodec.parse(""));
        assertNull(BackupCodec.parse("   \n\t "));
        assertNull(BackupCodec.parse("not json"));
        assertNull(BackupCodec.parse("{broken"));
        assertNull(BackupCodec.parse("[{\"id\":1,\"name\":\"顶层是数组\"}]"));
        assertNull(BackupCodec.parse("{\"app\":\"muse-launcher\",\"schema\":1}"));                 // 无 accounts
        assertNull(BackupCodec.parse("{\"schema\":1,\"accounts\":{}}"));                          // accounts 非数组
        assertNull(BackupCodec.parse("{\"schema\":1,\"accounts\":\"[]\"}"));
        assertNull(BackupCodec.parse("{\"schema\":99,\"accounts\":[]}"));                         // 未来版本必须拒绝
        assertNull(BackupCodec.parse("{\"schema\":0,\"accounts\":[]}"));
        assertNull(BackupCodec.parse("{\"accounts\":[]}"));                                       // 缺 schema
    }

    /** 单条 id 类型错：跳过该条，其余照常 */
    @Test
    public void parse_partialCorruption_skipsBadEntryOnly() {
        String json = "{\"app\":\"muse-launcher\",\"schema\":1,\"exportedAt\":1,\"accounts\":["
                + "{\"id\":1,\"name\":\"好账号\"},"
                + "{\"id\":\"不是数字\",\"name\":\"坏账号\"},"
                + "\"整个条目不是对象\","
                + "{\"name\":\"缺 id\"},"
                + "{\"id\":7,\"name\":\"另一个好账号\",\"tags\":[\"a\"]}]}";
        BackupCodec.Snapshot snap = BackupCodec.parse(json);
        assertNotNull(snap);
        assertEquals(2, snap.accounts.size());
        assertEquals("好账号", snap.accounts.get(0).name);
        assertEquals("另一个好账号", snap.accounts.get(1).name);
        assertEquals(7L, snap.accounts.get(1).id);
    }

    /** 超长 / 带换行的 cookie（仿页注入式）必须丢弃，账号本身保留 */
    @Test
    public void overlongOrInjectedCookie_dropped() {
        StringBuilder huge = new StringBuilder();
        while (huge.length() <= BackupCodec.MAX_COOKIE_LEN) huge.append('a');
        String overlong = huge.toString();

        String json = "{\"app\":\"muse-launcher\",\"schema\":1,\"exportedAt\":2,\"accounts\":["
                + "{\"id\":1,\"name\":\"超长 cookie\",\"cookies\":\"" + overlong + "\"},"
                + "{\"id\":2,\"name\":\"换行注入\",\"cookies\":\"a=1\\r\\nSet-Cookie: pwn=1\"},"
                + "{\"id\":3,\"name\":\"类型错\",\"cookies\":{\"k\":\"v\"}},"
                + "{\"id\":4,\"name\":\"正好边界\",\"cookies\":\"" + repeat('b', BackupCodec.MAX_COOKIE_LEN) + "\"}]}";

        BackupCodec.Snapshot snap = BackupCodec.parse(json);
        assertNotNull(snap);
        assertEquals(4, snap.accounts.size());          // 账号都在
        assertNull(snap.cookies.get(1L));
        assertNull(snap.cookies.get(2L));
        assertNull(snap.cookies.get(3L));
        assertEquals(BackupCodec.MAX_COOKIE_LEN, snap.cookies.get(4L).length());
        assertEquals(1, snap.cookies.size());
        assertTrue(snap.hadCookies);
        assertTrue(overlong.length() > BackupCodec.MAX_COOKIE_LEN);   // 确认长度确实越界
    }

    private static String repeat(char c, int n) {
        StringBuilder sb = new StringBuilder(n);
        for (int i = 0; i < n; i++) sb.append(c);
        return sb.toString();
    }

    @Test
    public void unknownExtraFields_ignored() {
        String json = "{\"app\":\"muse-launcher\",\"schema\":1,\"exportedAt\":3,"
                + "\"futureRoot\":{\"x\":1},\"accounts\":[{\"id\":9,\"name\":\"n\","
                + "\"futureField\":\"忽略我\",\"fp\":{\"uaMode\":\"windows\",\"futureFp\":1}}]}";
        BackupCodec.Snapshot snap = BackupCodec.parse(json);
        assertNotNull(snap);
        assertEquals(1, snap.accounts.size());
        assertEquals(9L, snap.accounts.get(0).id);
        assertEquals(Fingerprint.UA_WINDOWS, snap.accounts.get(0).fp.uaMode);
        assertTrue(snap.hadFingerprint);

        // 再导出一次：未知字段不会被带出来
        String again = BackupCodec.toJson(snap.accounts, snap.cookies, snap.exportedAt);
        assertFalse(again.contains("futureField"));
        assertFalse(again.contains("futureRoot"));
    }

    @Test
    public void hadFlags_reflectFileContent() {
        BackupCodec.Snapshot noFlags = BackupCodec.parse(BackupCodec.toJson(sample(), null, T));
        // sample() 里 3 条账号有 2 条带 fp，所以 hadFingerprint 为 true
        assertTrue(noFlags.hadFingerprint);
        assertFalse(noFlags.hadCookies);

        BackupCodec.Snapshot withCookies = BackupCodec.parse(BackupCodec.toJson(sample(), cookies(), T));
        assertTrue(withCookies.hadCookies);

        BackupCodec.Snapshot plain = BackupCodec.parse(
                "{\"schema\":1,\"accounts\":[{\"id\":1,\"name\":\"无 fp 无 cookie\"}]}");
        assertNotNull(plain);
        assertFalse(plain.hadFingerprint);
        assertFalse(plain.hadCookies);
    }

    /** 单条序列化异常只跳过该条：proxyPool 为 null 会触发 NPE，账号整体不写 */
    @Test
    public void toJson_skipsBadEntryOnly() {
        Account broken = new Account(2L, "坏账号");
        broken.proxyPool = null;   // putAccount 里遍历会 NPE
        List<Account> list = Arrays.asList(sample().get(0), broken, null, new Account(6L, "好账号"));
        String json = BackupCodec.toJson(list, null, T);
        assertNotNull(json);
        BackupCodec.Snapshot snap = BackupCodec.parse(json);
        assertNotNull(snap);
        assertEquals(2, snap.accounts.size());
        assertEquals(1L, snap.accounts.get(0).id);
        assertEquals(6L, snap.accounts.get(1).id);
    }

    /** 快照的 List/Map 是不可变视图：外部改不动，避免导入流程互相串味 */
    @Test
    public void snapshot_collectionsAreImmutable() {
        BackupCodec.Snapshot snap = BackupCodec.parse(BackupCodec.toJson(sample(), cookies(), T));
        assertNotNull(snap);
        assertThrows(UnsupportedOperationException.class, () -> snap.accounts.add(new Account(99L, "偷加")));
        assertThrows(UnsupportedOperationException.class, () -> snap.accounts.remove(0));
        assertThrows(UnsupportedOperationException.class, () -> snap.cookies.put(99L, "x=1"));
        assertThrows(UnsupportedOperationException.class, () -> snap.cookies.clear());
        assertEquals(3, snap.accounts.size());
        assertEquals(2, snap.cookies.size());
    }

    /** 与 AccountJsonCodec 共存：备份是对象信封，账号列表解码器应拒绝它，而内层数组照常可用 */
    @Test
    public void coexistsWithAccountJsonCodec() throws Exception {
        String backup = BackupCodec.toJson(sample(), cookies(), T);
        assertNull(AccountJsonCodec.fromJsonOrNull(backup));        // 信封不是数组 → null，不会误吞备份
        String arr = new JSONObject(backup).getJSONArray("accounts").toString();
        List<Account> fromArray = AccountJsonCodec.fromJsonOrNull(arr);
        assertNotNull(fromArray);
        assertEquals(3, fromArray.size());
        assertEquals("Muse 1", fromArray.get(0).name);
    }
}
