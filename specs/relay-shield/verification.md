# Relay Shield 验证记录

2026-09-11（Asia/Shanghai）。本轮代码和 Cloudflare 部署完成；目标远端网络验收仍未完成，规格不归档。

| 检查 | 结果 / 证据 |
| --- | --- |
| 完整回归 | `npm test`：51/51，通过，无跳过 |
| 浏览器链路 | `npm run test:browser`：临时 Chromium + opaque mock Hub，通过；包含截图、任务、断线、轮换和加密通信 |
| 真实 Worker | `npx wrangler dev --config hub/wrangler.toml --local --port 18797` + `node scripts/relay-test.mjs`，端点认证和加密往返通过 |
| 线上 Worker | `node scripts/relay-test.mjs https://relay.xxww.club`，连续两次通过；用测试配对和模拟执行器，不操作用户浏览器 |
| 部署 | `browser-relay-hub`；API deployment_id `fed8de9412484721b982e85d46333dbc`，2026-09-10T16:32:15Z；保留原 Durable Object namespace 和 v1 migration |
| 操作端诊断 | 未配对 `doctor`：DNS 12ms、TLS 2677ms、HTTPS health 702ms；远端 WS/RPC 明确 unknown |
| 构建 | `npm run build`：0.1.5 ZIP，默认 `https://relay.xxww.club` |
| 独立审查 | 密码协议及集成审查修复关闭会话额度泄漏、SDK 并发握手取消；最终补充代码复查结果见下 |
| 未测 | 指定远端主机/运营商、100 次连接成功率、30 分钟保活、实际远端 RPC p95、重连耗时、带宽；Edge 未独立测 |

线上部署后第一次探测收到旧协议的 `invalid_request`，随后重新配对的两次探测正常；该观察与部署传播相符，但没有进一步证明首次响应来源。

升级时配套更新扩展与 CLI，重置 ID 后重新连接。旧 ID 不兼容；没有明文降级。配对 ID 内含主密钥，不应贴到日志或公开截图。

故障覆盖由现有测试提供：篡改/反射/重放/错误会话拒绝执行，伪造明文响应不能冒充浏览器结果，断线后下一次显式请求重握手且不自动重试写操作，队列过期与正在执行任务的取消，Hub 请求大小/待处理数量/认证期限/读流期限。真实 DNS/TLS/Upgrade 阻断未注入生产。

HTTPS 长轮询和非 Cloudflare Hub 按当前范围暂缓：只有目标网络实测证明 WSS 不可用时才开启下一阶段。自定义域和端到端加密不能证明任意网络始终可达。

本地追加 `web_socket_auto_reply_to_close` 后，真实 workerd 加密往返和连接关闭均通过。线上尚未包含该标志：补发时 Cloudflare API OAuth 刷新返回 `invalid_client: Client not found`，重试同样失败。恢复连接后须重新部署并复测。

## 变更规模

相对 f59e615 的非空差异行；含生成的 skill runtime 副本，排除用户原有版本修改。注释按独立注释行统计，行内注释仍计入所在代码行，数字不是语法解析后的语句数。文档计数不含本表自身。

| 类别 | 新增 | 删除 | 净增 |
| --- | ---: | ---: | ---: |
| Production code (excl. standalone comments) | 1232 | 519 | 713 |
| Specs & docs | 179 | 7 | 172 |
| Comments | 19 | 8 | 11 |
| Tests / harness | 741 | 167 | 574 |

新增维护面为一个共享加密协议模块、doctor 命令、Hub 源设置和权限申请、Worker 配额及关闭回复配置；复用现有路由与 Durable Objects，无新数据库、后台服务或生产依赖。

补充 Codex CLI 复查运行约 10 分钟后未输出最终结论，已终止；其中沙箱监听测试遇到 EPERM，不能把该轮标为通过。此前独立协议/集成审查结论及本机完整回归不受此限制。
