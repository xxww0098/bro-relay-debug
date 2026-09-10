# Relay Shield 修复计划

状态：实施中，尚未部署新版。更新：2026-09-11。

## Next Agent Prompt

01/02 本地诊断和入口配置、03 Worker 限额、04 加密协议及 05 集成已完成。51 项回归、Chromium 链路、真实 workerd 和线上加密往返通过，详见 [验证记录](verification.md)。新版 Worker 已部署到 `relay.xxww.club`；最后的自动回复关闭帧配置已本地验证，但补发因 Cloudflare OAuth 失效而待完成。01/07 的目标远端网络测量仍待实测。用户明确优先 Cloudflare，非 CF Hub 与 HTTPS 回退暂缓。

采用新扩展、CLI、Hub 协同切换，重新生成配对秘密，不自动降级明文。基线为 `f59e615`；用户已有三处版本号改为 0.1.5，应保留。尚缺远端网络测量，不能声称大陆可达性验收完成。已有 Cloudflare API 访问能力，部署使用现有 `browser-relay-hub` Worker。

- [ ] [01 可达性诊断与基线](slices/01-reachability.md)
- [ ] [02 运行时入口与权限](slices/02-endpoints.md)
- [x] [03 Worker 资源限制；非 CF Hub 暂缓](slices/03-portable-hub.md)
- [x] [04 加密协议验证原型](slices/04-crypto-contract.md)
- [x] [05 端到端加密集成](slices/05-encrypted-rpc.md)
- [ ] [06 HTTPS 回退验证及条件实施](slices/06-https-fallback.md)
- [ ] [07 演练与发布验收](slices/07-validation.md)

## 目标与顺序

远端浏览器与操作端都主动出站连接 Hub；远端不开放入站端口。目标是在指定网络获得可测量的连接可靠性，并使 Hub 无法读取或伪造浏览器操作。不能承诺全国、所有运营商或国家级过滤下始终可达。

正式入口为 `https://relay.xxww.club`；CLI 使用该 HTTPS 源，扩展连接 `wss://relay.xxww.club/v1/device/connect`。复用 `BRO_RELAY_HUB_URL` 同步构建默认值和权限；实施时将构建配置设为 `BRO_RELAY_HUB_URL=https://relay.xxww.club`；用户已授权实施；通过测试后绑定既有 Worker 并同步配置。域名所有权与后端托管分开决定，自有域名仍须通过 01 的远端链路验收。

2026-09-10 已通过 Cloudflare API 只读核查：当前账户的 `639366.xyz`、`gmali.buzz`、`ozon-pod.com`、`xxww.club` 四个 zone 均 active、未暂停。各自 `relay.<zone>` 未见 DNS 记录、Workers 自定义域绑定或 Workers 路由占用；这表示配置层可作为候选，不表示已经部署或网络可达。用户已于 2026-09-11 选定 `relay.xxww.club`；前两个根域已有临时邮件 Worker，保留现有业务。已查到其他子域的非代理 A 记录，但不据此假定这些主机可部署 Hub。随后已绑定所选自定义域并部署新版 Worker，详见验证记录。

依赖：`01 → 02 → 05 → 07`，`04 → 05`；03 本轮仅执行 Worker 资源限制，非 CF 部署暂缓。04 可与入口工作独立进行。06 在 05 后按实测决定，必要时成为 07 的发布前置。第一个有用成果是两端各自的诊断报告，第二个是远端直连候选 Hub 的真实 RPC。

## 已核实的八项发现

| 编号 | 源码事实 | 影响与修复阶段 |
|---|---|---|
| F1 | `.env.example` 默认 workers.dev；`config.js` 与 `extension/config.js` 是生成物 | 默认入口形成单点；具体 DNS/TLS 阻断原因须由远端测量。01–03 |
| F2 | `scripts/build.mjs` 已支持 `BRO_RELAY_HUB_URL`，同时生成 manifest 权限；`cli/sdk.js` 已有 `options.hubUrl` | 不是源码无法换域，而是普通用户不能运行时换入口。02 |
| F3 | `remote-control.js` 发送 `device.auth.secret`，SDK 发 Bearer；driver ID 包含该 secret | Hub 已知道旧秘密，不能用它直接做 E2EE 主密钥。04–05 |
| F4 | `worker.js`、`rpc.js` 解析 method/path/body、结果与取消指令 | TLS 终止后的 Hub 能读取并生成操作；未证明现网日志实际保存了内容。05 |
| F5 | `worker.js` 设备连接要求 Upgrade；SDK 已经使用 HTTPS POST | WS-only 限制在扩展→Hub 这一侧。06 |
| F6 | `remote-control.js` 20s hello；`offscreen.js` 15s 唤醒与 background 30s alarm 也触发 reconnect/heartbeat | 实际节奏不只是 20s；保活受 MV3 生命周期约束，不能随意延长。06–07 |
| F7 | SDK handshake 可相信 Hub 提供的新鲜 hello；Hub 会派生 taskId 并生成取消 | 不可信 Hub 下须由端点认证 capabilities、分配任务和取消，防止加密破坏既有语义。04–05 |
| F8 | `readJson` 完整读入后才限制字符数；WS 消息和 pending 未见同等资源上限 | 入口与密文信封都须按字节、并发、寿命限制资源；截图响应独立设上限。03、05 |

本次是修复规划所需的定向源码核查，不是穷尽式安全扫描。用户提到的预览、10 个补丁及评分模型未提供，也未在仓库找到，不能声称逐项验证过其内容。

## 对原结论的修正

- WSS/HTTPS 有链路加密；“明文过 Worker”应指 Hub TLS 终止后的应用明文。无 TLS 解密能力的旁路观察者无法直接匹配 JSON 字段，但仍能看到部分握手信息、IP、长度和时序。企业 TLS 检查属于另一威胁模型。[TLS 1.3](https://www.rfc-editor.org/rfc/rfc8446)
- “workers.dev 整区受干扰”和具体复位原因是待验证网络假设；源码只能证明依赖该入口。自定义域不能证明底层 IP、路由和 TLS 可达；证书与任播路径也不是同一概念。
- 18/73 不作为安全评分或验收指标。加密改善机密性，不修复 DNS/TLS；抖动不等于隐身；HTTPS 回退也不绕过域名/IP 封锁。

## 架构约束

入口由一个校验与连接配置契约拥有；构建默认值仍由 `scripts/build.mjs` 生成。SDK/CLI/扩展消费同一规则，skill runtime 只由构建复制，不独立手改。普通用户一次仅选择一个 Hub，不建立自动域名池。

扩展 `createRemoteControl` 唯一拥有连接 generation、关闭、轮换与重连。任务执行、去重、取消由端点拥有；Hub 只拥有路由、有限 pending 与传输租约。加密信封由一个浏览器/Node 可复用模块拥有；Hub 不导入执行器路径分类。本轮继续使用现有 Worker 与 Durable Objects；不增加 Node Hub、Redis、数据库或集群。

本计划经过 refactor-clean 的单一所有者检查：不新建平行 SDK、第二套任务状态机或独立维护的 runtime。Worker 是本轮唯一生产中继，不维持两套协议实现。

## 验证与边界

复用 `node --test`、`tests/hub.test.mjs`、`tests/cli.test.mjs`、`tests/extension-lifecycle.test.mjs`、`tests/extension-revocation.test.mjs`、`tests/build.test.mjs` 及 `npm run test:browser`。仅对变更契约补充行为检查；发布前跑完整测试及构建，在临时副本生成产物，避免覆盖用户版本改动。mock Hub 是测试夹具，不是可上线服务。

任何 UI 修改均以真实截图验收：最后运行 screenshot-critique 的无预设第二意见；有旧界面参照时先运行 compare-screenshots 比较。用户审阅是可逆设计的反馈机会，不是默认阻塞点。当前计划不制作 UI，也不宣称视觉验证已完成。

不包含流量伪装、域前置、自定义 TLS 栈、自动代理控制、多区域自动调度或匿名性保证。只有真实测试证明需要时，才单独提出长度填充或调度调整，并测量带宽与延迟代价。

## 参考依据

- [仓库](https://github.com/xxww0098/bro-relay-debug)：具体事实以本地基线提交为准。
- [Chrome WebSocket 生命周期](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)：Chrome 116 起，30s 活动窗口内的消息交换可延长 service worker 生命周期。
- [Chrome 可选权限](https://developer.chrome.com/docs/extensions/reference/api/permissions)：可声明可选 HTTPS hosts，在用户操作中仅请求选中源。
- [HKDF](https://www.rfc-editor.org/rfc/rfc5869)：密钥派生使用标准原语及测试向量，不自行设计密码算法。
