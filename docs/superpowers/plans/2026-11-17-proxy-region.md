# v1.8 代理出口地区与账号运维

目标：语言和IANA时区跟随每账号代理出口IP；不是工作台访问设备或服务器的地理位置。已授权继续执行，不再询问设计。

## 契约

- Fingerprint新增localeMode/timezoneMode：proxy|manual|native。缺失时非空现有locale/timezone推断manual，空值推断proxy（保留现有显式配置）。proxy值不写入手动字段，运行时派生effective profile；manual保留用户输入，native清空运行时覆盖。
- 指纹关闭不应用地区策略。未配代理：状态no_proxy，自动项未启用、保留原生行为且UI明确标识。已配代理+启用自动项：首次使用先识别，失败时不得用主机/浏览器地区冒充；Muse打开失败并显示可重试提示。手动/native字段不受查询失败影响。
- 查询从账户代理发往固定HTTPS ipwho.is/（服务端选项允许测试fixture替代），禁止携带账号Cookie/Authorization；验证ip、country_code、timezone.id，语言是国家默认映射推断，不是IP证明用户母语；多语言地区可手动覆盖。
- 无直连回退、不跟随重定向、12s总超时、32KiB JSON上限；HTTP/HTTPS/SOCKS使用现有requestUpstream代理路径。目标URL不由管理API传入。
- cache独立每账号且绑定代理完整配置的SHA256；只持久化IP/国家/建议语言/IANA时区/时间，不持久化代理URL或凭据。代理变更先失效，旧异步结果不得覆盖新配置。最多2查询并发、同账号去重，成功缓存1h、失败冷却60s，手动sync强制重查但不跨账号。
- launch先ensure（过期重查），同一页面使用缓存effectiveprofile；每个HTTP/WS/API alias/Worker、自检、保活发送一致地区参数。代理变更或刷新地区后需重开页面避免旧JS身份漂移。保持既有Cookie/指纹种子。
- 保存代理/切换备用、测活成功、手动sync可触发重查；GET只返回状态不发请求。备份不信任缓存跨主机恢复，import使cache失效，manual配置保留。

## 接口与分工

1. proxy/region-lookup.ts（独立worker）：export RegionObservation {ip,countryCode,timezone,locale:string|null}; lookupProxyRegion({proxy:string,endpoint?:string,fingerprint?:Fingerprint,signal?,timeoutMs?}):Promise<RegionObservation>; localeForCountry(code):string|null。仅固定provider JSON解析与映射、网络夹具测试。
2. proxy/account-region.ts（独立worker）：export AccountRegionManager({getAccount(id):Account|undefined,dataDir?,lookup:(account,signal)=>Promise<RegionObservation>,onChange?}). status(id):RegionStatus; ensure(id,{force?:boolean}?):Promise<RegionStatus>; invalidate(id):void; remove(id):void; stop():void; effective(account):Account。RegionStatus {state:'disabled'|'no_proxy'|'unknown'|'checking'|'ready'|'error',checkedAt:number|null,ip:string|null,countryCode:string|null,timezone:string|null,locale:string|null,error:'lookup_failed'|'unsupported_country'|null,stale:boolean}; no raw errors/hash/proxy. effective只针对fp.enabled，manual/native分别处理；proxy配置存在且所需自动值缺失抛status503固定错误。成功缓存计算fresh1h，失败60s；loadedsnapshot不是liveproof，只在同proxy且fresh时使用。
3. Parent：types/profile/store默认模式、API region GET/POSTsync（Bearer及编码路径校验）、server hooks/cache生命周期/有效profile、备份兼容与配置投影、自检、集成测试/docs版本/CI。
4. UI worker：指纹语言/时区自动/手动/原生select；代理出口面板GET状态/POSTsync；显示出口IP、国家、来源建议语言、时区、检测时间、失败/代理变化需重开；独立draft/IfMatch保留、SSE刷新不覆盖草稿。新账户默认自动；已有非空字段模式manual；不从浏览器时区或语言自动填值。

## 验收

红绿测试验证代理真实路径（HTTP CONNECT/SOCKS或已有transportfixtures）、不携带MuseCookie、失败不直连、JSON界限与时区有效性；状态隔离、代理变更/删除/导入迟到结果不写回、重启缓存、manual优先；浏览器打开两个不同出口fixture后Header/JS/Worker地区一致，切代理重开更新；全量server/build/Chromium+AndroidCI。独立审查后同forkfeaturebranch提交推送。
