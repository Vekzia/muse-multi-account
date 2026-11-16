package com.seekstars.muselauncher;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

/** M3：账号列表 JSON 编解码的容错 */
public class AccountJsonCodecTest {

    private List<Account> sample() {
        List<Account> l = new ArrayList<>();
        Account a = new Account(2, "干杂活");
        a.avatar = "干";
        a.proxy = "http://u:p@1.2.3.4:3129";
        a.tags.add("电商");
        a.tags.add("主力");
        l.add(a);
        Account b = new Account(5, "Muse 😊");
        b.avatar = "😊";
        l.add(b);
        return l;
    }

    @Test
    public void roundTrip_preservesAllFields() {
        String json = AccountJsonCodec.toJson(sample());
        List<Account> back = AccountJsonCodec.fromJsonOrNull(json);
        assertEquals(2, back.size());
        Account a = back.get(0);
        assertEquals(2L, a.id);
        assertEquals("干杂活", a.name);
        assertEquals("干", a.avatar);
        assertEquals("http://u:p@1.2.3.4:3129", a.proxy);
        assertEquals(2, a.tags.size());
        assertEquals("电商", a.tags.get(0));
        assertEquals("主力", a.tags.get(1));
        assertEquals("😊", back.get(1).avatar);
    }

    @Test
    public void nullOrGarbage_returnsNull() {
        assertNull(AccountJsonCodec.fromJsonOrNull(null));
        assertNull(AccountJsonCodec.fromJsonOrNull("not json at all"));
        assertNull(AccountJsonCodec.fromJsonOrNull("{\"a\":1}"));   // 对象而非数组
        assertNull(AccountJsonCodec.fromJsonOrNull("[{broken"));
    }

    @Test
    public void emptyArray_emptyList() {
        List<Account> out = AccountJsonCodec.fromJsonOrNull("[]");
        assertTrue(out.isEmpty());
    }

    /** 单条损坏：跳过该条，其余保留 */
    @Test
    public void partialCorruption_skipsBadEntryOnly() {
        String json = "[{\"id\":2,\"name\":\"好账号\"},"
                + "{\"id\":\"不是数字\",\"name\":\"坏账号\"},"
                + "{\"id\":5,\"name\":\"另一个好账号\",\"proxy\":\"\",\"tags\":[]}]";
        List<Account> out = AccountJsonCodec.fromJsonOrNull(json);
        assertEquals(2, out.size());
        assertEquals("好账号", out.get(0).name);
        assertEquals("另一个好账号", out.get(1).name);
    }

    @Test
    public void newFields_roundTrip() {
        Account a = new Account(7L, "带指纹");
        a.proxy = "socks5://1.2.3.4:1080";
        a.proxyPool.add("socks5://1.2.3.4:1080");
        a.proxyPool.add("http://5.6.7.8:3129");
        a.fp.uaMode = Fingerprint.UA_MACOS;
        a.fp.timezone = "Asia/Tokyo";
        a.fp.locale = "ja-JP";
        a.fp.webdriver = true;
        a.fp.noise = true;

        String json = AccountJsonCodec.toJson(new ArrayList<>(java.util.Collections.singletonList(a)));
        List<Account> back = AccountJsonCodec.fromJsonOrNull(json);

        assertEquals(1, back.size());
        Account b = back.get(0);
        assertEquals(2, b.proxyPool.size());
        assertEquals("http://5.6.7.8:3129", b.proxyPool.get(1));
        assertEquals(Fingerprint.UA_MACOS, b.fp.uaMode);
        assertEquals("Asia/Tokyo", b.fp.timezone);
        assertEquals("ja-JP", b.fp.locale);
        assertTrue(b.fp.webdriver);
        assertTrue(b.fp.noise);
        assertFalse(b.fp.webrtc);
    }

    @Test
    public void oldDataWithoutNewFields_staysUsable() {
        // 旧版本写下的 JSON 没有 proxyPool / fp：必须照旧解析，不能因为新增字段把用户账号读丢
        List<Account> out = AccountJsonCodec.fromJsonOrNull(
                "[{\"id\":4,\"name\":\"老账号\",\"avatar\":\"老\",\"proxy\":\"127.0.0.1:7890\",\"tags\":[\"x\"]}]");
        assertEquals(1, out.size());
        Account a = out.get(0);
        assertTrue(a.proxyPool.isEmpty());
        assertEquals("127.0.0.1:7890", a.proxy);
        assertEquals(Fingerprint.UA_SYSTEM, a.fp.uaMode);
        assertFalse(a.fp.anyOverride());
    }

    @Test
    public void defaultFingerprint_isNotSerialized() {
        // 未配指纹的账号不该把 fp 字段写进存储：旧备份/旧版本互读时体积与形态都保持原样
        Account a = new Account(8L, "普通");
        String json = AccountJsonCodec.toJson(new ArrayList<>(java.util.Collections.singletonList(a)));
        assertFalse(json.contains("\"fp\""));
        assertFalse(json.contains("proxyPool") && json.contains("\"proxyPool\":[\""));
    }

    @Test
    public void hostileFingerprintValues_areSanitized() {
        // 时区/语言最终会进 JS 字面量：只允许安全字符，防止把注入内容塞进来
        String json = "[{\"id\":9,\"name\":\"x\",\"fp\":{\"tz\":\"UTC');alert(1);//\",\"locale\":\"en-US;evil\"}}]";
        List<Account> out = AccountJsonCodec.fromJsonOrNull(json);
        assertEquals(1, out.size());
        assertFalse(out.get(0).fp.timezone.contains("'"));
        assertFalse(out.get(0).fp.timezone.contains("("));
        assertFalse(out.get(0).fp.locale.contains("\\"));
        assertFalse(out.get(0).fp.locale.contains(";"));
    }

    @Test
    public void missingOptionalFields_defaults() {
        List<Account> out = AccountJsonCodec.fromJsonOrNull("[{\"id\":3,\"name\":\"n\"}]");
        assertEquals(1, out.size());
        assertEquals("m", out.get(0).avatar);
        assertEquals("", out.get(0).proxy);
        assertTrue(out.get(0).tags.isEmpty());
    }
}
