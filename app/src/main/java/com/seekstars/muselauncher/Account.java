package com.seekstars.muselauncher;

import java.util.ArrayList;
import java.util.List;

public class Account {
    public final long id;
    public String name;
    /** 头像：1-2 个字符或 emoji，默认 "m" */
    public String avatar = "m";
    /** 当前生效的代理地址，空 = 跟随系统网络 */
    public String proxy = "";
    /**
     * 代理池：本账号的所有候选代理，顺序即优先级。
     * 约定 proxy 是池中正在使用的那一条；切换账号测活失败时按池顺序轮换。
     * 空列表表示只用 proxy 单条（兼容旧数据）。
     */
    public List<String> proxyPool = new ArrayList<>();
    /** 标签（侧栏可按标签搜索） */
    public List<String> tags = new ArrayList<>();
    /** 指纹隔离配置（UA / 时区 / 语言 / 自动化标记 / 加噪） */
    public Fingerprint fp = new Fingerprint();
    /** 登录态：运行时从 CookieManager 探测，不持久化 */
    public boolean logged;

    public Account(long id, String name) {
        this.id = id;
        this.name = name;
    }

    /** 深拷贝（不含运行时字段 logged） */
    public Account copy() {
        Account a = new Account(id, name);
        a.avatar = avatar;
        a.proxy = proxy;
        a.proxyPool = new ArrayList<>(proxyPool);
        a.tags = new ArrayList<>(tags);
        a.fp = fp != null ? fp.copy() : new Fingerprint();
        return a;
    }
}
