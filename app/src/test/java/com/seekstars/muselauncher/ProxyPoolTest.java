package com.seekstars.muselauncher;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * {@link ProxyPool} 的行为锁定测试。
 *
 * <p>这些用例的价值在于把"界面上看不出差别、真机上才炸"的边界固化下来：端口 0/65536、
 * 带路径的代理（ProxyConfig 会静默忽略）、未加方括号的 IPv6、全角逗号粘贴、
 * 以及"从最后一条失败后要回到第一条"的环形轮换。
 */
public class ProxyPoolTest {

    private static final String A = "http://1.2.3.4:3128";

    private static List<String> pool(String... items) {
        return new ArrayList<>(Arrays.asList(items));
    }

    // ---------- normalize ----------

    @Test
    public void normalize_nullAndBlankReturnEmpty() {
        assertEquals("", ProxyPool.normalize(null));
        assertEquals("", ProxyPool.normalize(""));
        assertEquals("", ProxyPool.normalize("   "));
        assertEquals("", ProxyPool.normalize("\t\r\n "));
    }

    @Test
    public void normalize_keepsExistingSchemeAndItsCase() {
        assertEquals("HTTP://1.2.3.4:80", ProxyPool.normalize("HTTP://1.2.3.4:80"));
        assertEquals("Socks5://[::1]:1080", ProxyPool.normalize("Socks5://[::1]:1080"));
        assertEquals("https://example.com:443", ProxyPool.normalize("https://example.com:443"));
        assertEquals("socks4://1.1.1.1:1080", ProxyPool.normalize("socks4://1.1.1.1:1080"));
    }

    @Test
    public void normalize_addsDefaultHttpScheme() {
        assertEquals("http://127.0.0.1:7890", ProxyPool.normalize("127.0.0.1:7890"));
        assertEquals("http://example.com:8080", ProxyPool.normalize("example.com:8080"));
        // scheme 保留大小写，主机名不动：回显时与用户输入一致，便于核对
        assertEquals("http://Example.COM:8080", ProxyPool.normalize("http://Example.COM:8080"));
    }

    @Test
    public void normalize_stripsInnerWhitespace() {
        assertEquals("http://127.0.0.1:7890", ProxyPool.normalize("127.0.0.1 : 7890"));
        assertEquals("http://127.0.0.1:7890", ProxyPool.normalize("  127.0.0.1:7890  "));
        assertEquals("http://127.0.0.1:7890", ProxyPool.normalize("127.0. 0.1:78 90"));
        assertEquals("socks5://u:p@1.2.3.4:1080", ProxyPool.normalize(" socks5://u:p @ 1.2.3.4:1080 "));
    }

    @Test
    public void normalize_keepsIpv6BracketForm() {
        assertEquals("socks5://[::1]:1080", ProxyPool.normalize("socks5://[::1]:1080"));
        assertEquals("http://[::ffff:1.2.3.4]:8080", ProxyPool.normalize("[::ffff:1.2.3.4]:8080"));
    }

    @Test
    public void normalize_doesNotLowercasePathOrCreds() {
        assertEquals("http://User:PassWord@Host.Example:8080",
                ProxyPool.normalize("http://User:PassWord@Host.Example:8080"));
    }

    // ---------- isValid ----------

    @Test
    public void isValid_acceptsLegalForms() {
        assertTrue(ProxyPool.isValid("http://1.2.3.4:3128"));
        assertTrue(ProxyPool.isValid("https://example.com:443"));
        assertTrue(ProxyPool.isValid("socks4://1.2.3.4:1080"));
        assertTrue(ProxyPool.isValid("socks5://[::1]:1080"));
        assertTrue(ProxyPool.isValid("socks5://[::ffff:1.2.3.4]:1080"));
        assertTrue(ProxyPool.isValid("http://u:p@1.2.3.4:3129"));
        assertTrue(ProxyPool.isValid("http://user@host:8080"));
        assertTrue(ProxyPool.isValid("127.0.0.1:7890"));
        assertTrue(ProxyPool.isValid("localhost:7890"));
        assertTrue(ProxyPool.isValid("my-host.local:65535"));
        assertTrue(ProxyPool.isValid("http://1.2.3.4:1"));
        assertTrue(ProxyPool.isValid("HTTP://1.2.3.4:3128"));
    }

    @Test
    public void isValid_rejectsIllegalForms() {
        assertFalse(ProxyPool.isValid(null));
        assertFalse(ProxyPool.isValid(""));
        assertFalse(ProxyPool.isValid("   "));
        assertFalse(ProxyPool.isValid("abc"));
        assertFalse(ProxyPool.isValid("1.2.3.4"));
        assertFalse(ProxyPool.isValid("http://:8080"));
        assertFalse(ProxyPool.isValid("http://1.2.3.4:0"));
        assertFalse(ProxyPool.isValid("http://1.2.3.4:65536"));
        assertFalse(ProxyPool.isValid("ftp://1.2.3.4:21"));
        assertFalse(ProxyPool.isValid("http://1.2.3.4:80/path"));
        assertFalse(ProxyPool.isValid("127.0.0.1:78a0"));
        assertFalse(ProxyPool.isValid("http://"));
        assertFalse(ProxyPool.isValid("://1.2.3.4:80"));
        assertFalse(ProxyPool.isValid("http://1.2.3.4:"));
        assertFalse(ProxyPool.isValid("http://1.2.3.4:-1"));
        assertFalse(ProxyPool.isValid("http://1.2.3.4:8080?x=1"));
        assertFalse(ProxyPool.isValid("http://a@b@1.2.3.4:80"));
        assertFalse(ProxyPool.isValid("http://user@"));
        assertFalse(ProxyPool.isValid("http://::1:1080"));
        assertFalse(ProxyPool.isValid("http://[::1:1080"));
        assertFalse(ProxyPool.isValid("http://[::1]1080"));
        assertFalse(ProxyPool.isValid("http://[abc]:1080"));
        assertFalse(ProxyPool.isValid("http://1.2.3.4:99999"));
        assertFalse(ProxyPool.isValid("http://h ost:80/x"));
    }

    // ---------- parse ----------

    @Test
    public void parse_splitsOnMixedSeparators() {
        String raw = "127.0.0.1:7890\nsocks5://127.0.0.1:1080，http://u:p@1.2.3.4:3129; "
                + "http://5.6.7.8:8080\t\thttps://example.com:443\r\nsocks4://9.9.9.9:1080；";
        List<String> got = ProxyPool.parse(raw);
        assertEquals(Arrays.asList(
                "http://127.0.0.1:7890",
                "socks5://127.0.0.1:1080",
                "http://u:p@1.2.3.4:3129",
                "http://5.6.7.8:8080",
                "https://example.com:443",
                "socks4://9.9.9.9:1080"), got);
    }

    @Test
    public void parse_dedupesKeepingFirstOccurrenceOrder() {
        List<String> got = ProxyPool.parse(
                "3.3.3.3:3333\nhttp://1.1.1.1:1111\n3.3.3.3:3333\nhttp://3.3.3.3:3333\n1.1.1.1:1111");
        assertEquals(Arrays.asList("http://3.3.3.3:3333", "http://1.1.1.1:1111"), got);
    }

    @Test
    public void parse_dropsInvalidEntries() {
        List<String> got = ProxyPool.parse(
                "abc\nhttp://1.2.3.4:0\n127.0.0.1:7890\nftp://1.2.3.4:21\nhttp://1.2.3.4:80/x\n,,,,,;;;;");
        assertEquals(Collections.singletonList("http://127.0.0.1:7890"), got);
    }

    @Test
    public void parse_emptyAndNullGiveEmptyMutableList() {
        assertTrue(ProxyPool.parse(null).isEmpty());
        assertTrue(ProxyPool.parse("").isEmpty());
        assertTrue(ProxyPool.parse("  \n , ， ; ； \t ").isEmpty());
        // 返回的必须是可修改的 ArrayList：Android 侧会继续往里加/删
        List<String> got = ProxyPool.parse("1.2.3.4:3128");
        assertTrue(got instanceof ArrayList);
        got.add("http://1.1.1.1:1111");
        assertEquals(2, got.size());
    }

    // ---------- next ----------

    @Test
    public void next_ringsForwardFromFailed() {
        List<String> p = pool("http://1.1.1.1:1", "http://2.2.2.2:2", "http://3.3.3.3:3");
        assertEquals("http://3.3.3.3:3", ProxyPool.next(p, "http://2.2.2.2:2"));
        assertEquals("http://2.2.2.2:2", ProxyPool.next(p, "http://1.1.1.1:1"));
    }

    @Test
    public void next_wrapsToFirstWhenLastFailed() {
        List<String> p = pool("http://1.1.1.1:1", "http://2.2.2.2:2", "http://3.3.3.3:3");
        assertEquals("http://1.1.1.1:1", ProxyPool.next(p, "http://3.3.3.3:3"));
    }

    @Test
    public void next_singleItemPoolReturnsNull() {
        List<String> p = pool(A);
        assertNull(ProxyPool.next(p, A));
        assertNull(ProxyPool.next(p, "1.2.3.4:3128"));
    }

    @Test
    public void next_failedNotInPoolReturnsFirst() {
        List<String> p = pool("http://1.1.1.1:1", "http://2.2.2.2:2");
        assertEquals("http://1.1.1.1:1", ProxyPool.next(p, "http://9.9.9.9:9"));
        // failed 未归一化也要能命中同一条，避免"轮换原地打转"
        assertEquals("http://2.2.2.2:2", ProxyPool.next(p, "1.1.1.1:1"));
    }

    @Test
    public void next_nullFailedReturnsFirst() {
        List<String> p = pool("http://1.1.1.1:1", "http://2.2.2.2:2");
        assertEquals("http://1.1.1.1:1", ProxyPool.next(p, null));
        assertEquals("http://1.1.1.1:1", ProxyPool.next(p, "   "));
    }

    @Test
    public void next_emptyPoolReturnsNull() {
        assertNull(ProxyPool.next(null, null));
        assertNull(ProxyPool.next(new ArrayList<>(), "http://1.1.1.1:1"));
    }

    @Test
    public void next_allEntriesEqualToFailedReturnsNull() {
        List<String> p = pool("1.2.3.4:3128", A, "http://1.2.3.4:3128");
        assertNull(ProxyPool.next(p, A));
    }

    // ---------- indexOf / first / join ----------

    @Test
    public void indexOf_matchesNormalizedEquivalent() {
        List<String> p = pool("http://1.1.1.1:1111", "1.2.3.4:3128");
        assertEquals(1, ProxyPool.indexOf(p, A));
        assertEquals(1, ProxyPool.indexOf(p, " 1.2.3.4 : 3128 "));
        assertEquals(0, ProxyPool.indexOf(p, "http://1.1.1.1:1111"));
        assertEquals(-1, ProxyPool.indexOf(p, "https://1.2.3.4:3128"));
        assertEquals(-1, ProxyPool.indexOf(p, null));
        assertEquals(-1, ProxyPool.indexOf(null, A));
        assertEquals(-1, ProxyPool.indexOf(new ArrayList<>(), A));
    }

    @Test
    public void first_handlesNullAndEmpty() {
        assertNull(ProxyPool.first(null));
        assertNull(ProxyPool.first(new ArrayList<>()));
        assertEquals(A, ProxyPool.first(pool(A, "http://1.1.1.1:1111")));
    }

    @Test
    public void join_roundTripsThroughParse() {
        List<String> p = ProxyPool.parse("127.0.0.1:7890\nsocks5://127.0.0.1:1080\nhttp://u:p@1.2.3.4:3129");
        String text = ProxyPool.join(p);
        assertEquals("http://127.0.0.1:7890\nsocks5://127.0.0.1:1080\nhttp://u:p@1.2.3.4:3129", text);
        assertEquals(p, ProxyPool.parse(text));
        assertEquals("", ProxyPool.join(null));
        assertEquals("", ProxyPool.join(new ArrayList<>()));
        assertEquals("", ProxyPool.join(pool("", "  ")));
    }

    // ---------- merge ----------

    @Test
    public void merge_putsActiveFirstAndDedupes() {
        List<String> p = pool("http://2.2.2.2:2", "1.2.3.4:3128", "http://3.3.3.3:3", A);
        List<String> got = ProxyPool.merge(p, " 1.2.3.4:3128 ");
        assertEquals(Arrays.asList(A, "http://2.2.2.2:2", "http://3.3.3.3:3"), got);
        assertEquals(A, got.get(0));
    }

    @Test
    public void merge_keepsPoolOrderWhenActiveBlankOrInvalid() {
        List<String> p = pool("http://2.2.2.2:2", "1.2.3.4:3128", "http://2.2.2.2:2");
        List<String> expect = Arrays.asList("http://2.2.2.2:2", A);
        assertEquals(expect, ProxyPool.merge(p, ""));
        assertEquals(expect, ProxyPool.merge(p, null));
        assertEquals(expect, ProxyPool.merge(p, "   "));
        assertEquals(expect, ProxyPool.merge(p, "not-a-proxy"));
        assertEquals(expect, ProxyPool.merge(p, "http://1.2.3.4:80/path"));
    }

    @Test
    public void merge_handlesNullPoolAndEmptyResult() {
        assertEquals(Collections.singletonList(A), ProxyPool.merge(null, A));
        assertTrue(ProxyPool.merge(null, null).isEmpty());
        assertTrue(ProxyPool.merge(new ArrayList<>(), "abc").isEmpty());
        // active 合法但池里有非法项：非法项不能出现在结果里
        assertEquals(Collections.singletonList(A),
                ProxyPool.merge(pool("abc", "http://1.2.3.4:0"), A));
    }

    // ---------- 真实回归 ----------

    @Test
    public void regression_realisticPoolKeepsInputOrder() {
        List<String> got = ProxyPool.parse(
                "127.0.0.1:7890\nsocks5://127.0.0.1:1080\nhttp://u:p@1.2.3.4:3129");
        assertEquals(3, got.size());
        assertEquals("http://127.0.0.1:7890", got.get(0));
        assertEquals("socks5://127.0.0.1:1080", got.get(1));
        assertEquals("http://u:p@1.2.3.4:3129", got.get(2));
        // 池首即当前生效项，轮换一次应落到第二条
        assertEquals("socks5://127.0.0.1:1080",
                ProxyPool.next(got, ProxyPool.first(got)));
    }
}
