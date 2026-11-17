# Muse 会话维护与浏览器传输：GitHub 源码核验

本次为同仓库 Linux WebUI v1.7 的实现依据。只从公开仓库读取协议和测试，不导入注册机、邀请码处理或账号自动注册功能。未使用真实账号进行长时续期实验。

## 核验过的来源

| 来源 | 固定提交 | 可确认内容 |
| --- | --- | --- |
| [czg86389-hub/muse2api](https://github.com/czg86389-hub/muse2api/tree/19db32a3d6ef50dc87567a8ee0e35dd50c8f7837) | `19db32a` | 会话检查、VM唤醒、实际Cookie轮换、过期时间测试；MIT |
| [d4ncboz/museai](https://github.com/d4ncboz/museai/tree/b470724716ac923fa0de1f743c3c6310dcd0d5d1) | `b470724` | HTTP维护与浏览器CDP桥接，默认关闭/6h；部分错误状态判定较粗略；MIT |
| [www222fff/muse2api](https://github.com/www222fff/muse2api/tree/3a20b5e7aa4056c99c0eb8c732d73ce3804d5dbf) | `3a20b5e` | 浏览器驱动、会话维护和传输心跳分层；HTTP聊天driver存在占位，不能按README假设全部纯协议；MIT |
| [sqdshguy/wreq-js](https://github.com/sqdshguy/wreq-js/tree/0d52d5fa252841aeef34d4d063b1766a59612bf7) | `0d52d5f` / npm `3.2.0` | BoringSSL浏览器模板、HTTP2、代理和WebSocket；MIT |

搜索中也看到 `tu-kimei/muse-api`、`duwqijlk/muse-protocol` 使用 curl_cffi；前者未找到许可证，后者LICENSE为空。没有复制这两个仓库的实现。搜索到的多个“muse mirror”是同名无关项目，未确认一个可直接照搬的完整Muse网页镜像。

## 会话、VM、连接是三层

1. **认证会话**：`GET https://muse.ai/api/session`，发送该账号Cookie，Origin主站、Referer `/thread/new`，限制超时、不跟随跳转。已核验响应字段只有`status`、`vm_id`、`vm_state`；对象`status=assigned`代表最近检查有效。
2. **云VM**：显式启用后才发送 `POST /api/hatch/vm/wake`，JSON为 `{vm_id,retry_count:0,connect_attempt_id:UUID}`；HTTP200不等于已唤醒，后续GET观察到`assigned`和`RUNNING`才确认。
3. **传输连接**：WebSocket ping/pong、SSE心跳只说明连接活动，不证明认证Cookie或VM租约延期。

源码依据：[engine.py 会话与唤醒](https://github.com/czg86389-hub/muse2api/blob/19db32a3d6ef50dc87567a8ee0e35dd50c8f7837/engine.py#L549-L661)。Cookie可能在非assigned响应中轮换：[Cookie轮换测试](https://github.com/czg86389-hub/muse2api/blob/19db32a3d6ef50dc87567a8ee0e35dd50c8f7837/tests/test_session_cookie_rotation.py#L21-L83)。

`401`标记认证失效并暂停自动检查；`403`标记访问受限、不清Cookie、不宣告退出。`429`遵循Retry-After和退避，5xx/网络错误分别保留不确定结果。新实现默认关闭定时维护、默认6h、最多2个并发，VM唤醒默认关闭。

## “48h自动续期”的证据边界

同一外部仓库的README开头与代码注释声称48h续期，但[状态保存逻辑](https://github.com/czg86389-hub/muse2api/blob/19db32a3d6ef50dc87567a8ee0e35dd50c8f7837/store.py#L27-L73)与[测试](https://github.com/czg86389-hub/muse2api/blob/19db32a3d6ef50dc87567a8ee0e35dd50c8f7837/tests/test_session_health.py#L65-L98)明确不因检查成功虚推expiry；[README末段](https://github.com/czg86389-hub/muse2api/blob/19db32a3d6ef50dc87567a8ee0e35dd50c8f7837/README.md#L515)也说明续期以实际Cookie为准。

因此本项目仅保存上游真正下发的Set-Cookie，不把每次健康检查当作+48h；没有expiry显示未知，不以导入时间估算永久有效。

## 传输选择与验证方法

选定npm精确版本`wreq-js@3.2.0`及同版本平台binding，保留lockfile integrity。研究阶段实测Linux x64 Node20.19.5/22.14.0非root下HTTP2、HTTP/HTTPS/SOCKS认证代理、流式响应、子协议/文本/二进制WebSocket；未把这些说成与真实Chrome所有流量完全一致。项目测试进一步捕获本地TLS ClientHello模板的可复现特征，并与Node TLS比较。

库的原生流取消存在资源释放缺口，因此浏览器传输由有界子进程承载，关闭时终止对应进程；默认Node路径保留。使用独立账号Cookie Jar、手动重定向策略、显式代理且失败不转直连。WebSocket升级响应头尚未由依赖暴露，101 Set-Cookie不承诺同步；HTTP响应和会话维护负责实际Cookie轮换。

这些能力控制服务端的上游连接；访问工作台的浏览器至服务器连接是另一段TLS。字体/Worker/WebGPU由独立页面策略处理，不会因换网络库自动覆盖。
