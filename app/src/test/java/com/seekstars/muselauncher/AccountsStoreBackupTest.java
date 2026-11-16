package com.seekstars.muselauncher;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** 二开：备份导入 / 代理池 在存储层的语义（HashMap 假 KV，纯 JVM） */
public class AccountsStoreBackupTest {

    private AccountsStore store() {
        return new AccountsStore(new AccountsStoreTest.FakeKv());
    }

    private Account incoming(long id, String name) {
        Account a = new Account(id, name);
        a.avatar = "A";
        a.proxy = "http://1.1.1.1:3129";
        a.proxyPool = new ArrayList<>(Arrays.asList("http://1.1.1.1:3129", "socks5://2.2.2.2:1080"));
        a.tags = new ArrayList<>(Arrays.asList("主力", "测试"));
        a.fp.timezone = "America/Los_Angeles";
        a.fp.noise = true;
        return a;
    }

    @Test
    public void importAppendAssignsFreshIdsAndRemaps() {
        AccountsStore s = store();
        s.addDefault();                       // 本机已有 id=1
        List<Account> in = new ArrayList<>();
        in.add(incoming(1L, "备份号 A"));      // 备份里的 id=1 与本机撞车
        in.add(incoming(2L, "备份号 B"));

        AccountsStore.ImportOutcome out = s.importAccounts(in, false);

        assertEquals(2, out.added);
        assertEquals(0, out.skipped);
        assertEquals(3, s.all().size());
        // 撞车的 id 被重新分配，不能和本机已有的 1 冲突
        long newA = out.idMap.get(1L);
        long newB = out.idMap.get(2L);
        assertNotEquals(1L, newA);
        assertNotEquals(newA, newB);
        assertEquals("备份号 A", s.findById(newA).name);
        // 全字段都要带过来
        Account a = s.findById(newA);
        assertEquals(2, a.proxyPool.size());
        assertEquals(2, a.tags.size());
        assertEquals("America/Los_Angeles", a.fp.timezone);
        assertTrue(a.fp.noise);
    }

    @Test
    public void importSkipsDuplicateNames() {
        AccountsStore s = store();
        s.addDefault();                       // "Muse 1"
        List<Account> in = new ArrayList<>();
        in.add(incoming(9L, "Muse 1"));        // 同名：不能覆盖（会毁掉本机登录态）
        in.add(incoming(10L, "新号"));
        in.add(incoming(11L, "   "));          // 空名字丢弃

        AccountsStore.ImportOutcome out = s.importAccounts(in, false);

        assertEquals(1, out.added);
        assertEquals(2, out.skipped);
        assertEquals(2, s.all().size());
        assertTrue(out.idMap.containsKey(10L));
        assertTrue(!out.idMap.containsKey(9L));
    }

    @Test
    public void importReplaceClearsAndReportsRemovedIds() {
        AccountsStore s = store();
        s.addDefault();
        s.addDefault();
        List<Long> before = new ArrayList<>();
        for (Account a : s.all()) before.add(a.id);

        AccountsStore.ImportOutcome out = s.importAccounts(
                new ArrayList<>(Arrays.asList(incoming(5L, "只剩我"))), true);

        assertEquals(1, out.added);
        assertEquals(1, s.all().size());
        assertEquals("只剩我", s.all().get(0).name);
        assertEquals(before, out.removedIds);   // 旧 Profile 由调用方按这个删
        assertEquals(s.all().get(0).id, s.getCurrentId());
    }

    @Test
    public void importedIdsSurviveReloadAndStayMonotonic() {
        AccountsStoreTest.FakeKv kv = new AccountsStoreTest.FakeKv();
        AccountsStore s = new AccountsStore(kv);
        s.addDefault();
        long newId = s.importAccounts(
                new ArrayList<>(Arrays.asList(incoming(77L, "导入号"))), false).idMap.get(77L);

        AccountsStore reopened = new AccountsStore(kv);
        assertEquals(2, reopened.all().size());
        assertEquals("导入号", reopened.findById(newId).name);
        // 再建号不能复用已分配的 id
        Account next = reopened.addDefault();
        assertTrue(next.id > newId);
    }

    @Test
    public void snapshotIsDeepCopy() {
        AccountsStore s = store();
        Account a = s.addDefault();
        a.proxyPool.add("http://3.3.3.3:8080");
        a.tags.add("x");
        a.fp.locale = "en-US";
        s.save();

        List<Account> snap = s.snapshot();
        snap.get(0).name = "被改坏";
        snap.get(0).proxyPool.clear();
        snap.get(0).fp.locale = "ja-JP";

        assertEquals(a.name, s.all().get(0).name);
        assertEquals(1, s.all().get(0).proxyPool.size());
        assertEquals("en-US", s.all().get(0).fp.locale);
    }

    @Test
    public void setProxyPoolPutsActiveFirstAndDedupes() {
        AccountsStore s = store();
        Account a = s.addDefault();
        s.setProxyPool(a.id,
                Arrays.asList("http://1.1.1.1:1", "socks5://2.2.2.2:1080", "1.1.1.1:1"),
                "socks5://2.2.2.2:1080");

        Account got = s.findById(a.id);
        assertEquals(Arrays.asList("socks5://2.2.2.2:1080", "http://1.1.1.1:1"), got.proxyPool);
        assertEquals("socks5://2.2.2.2:1080", got.proxy);
    }

    @Test
    public void failoverRotatesAndPersists() {
        AccountsStoreTest.FakeKv kv = new AccountsStoreTest.FakeKv();
        AccountsStore s = new AccountsStore(kv);
        Account a = s.addDefault();
        s.setProxyPool(a.id, Arrays.asList("http://1.1.1.1:1", "http://2.2.2.2:2"), "http://1.1.1.1:1");

        assertEquals("http://2.2.2.2:2", s.failoverProxy(a.id));
        // 落盘：重开实例仍是轮换后的代理，不会冷启动再试死代理
        assertEquals("http://2.2.2.2:2", new AccountsStore(kv).findById(a.id).proxy);
    }

    @Test
    public void failoverReturnsNullWhenNothingToSwitch() {
        AccountsStore s = store();
        Account a = s.addDefault();
        a.proxy = "http://1.1.1.1:1";
        a.proxyPool.clear();
        s.save();
        assertNull(s.failoverProxy(a.id));
        assertEquals("http://1.1.1.1:1", s.findById(a.id).proxy);
    }
}
