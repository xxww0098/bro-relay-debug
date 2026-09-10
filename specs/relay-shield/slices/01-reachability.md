# 01 建立可达性证据

交付：两端分别运行的诊断报告，显示 `side, origin, stage, outcome, durationMs, observedAt`，stage 为 DNS、TLS、HTTPS health、WS auth、RPC。未经测量标为 unknown；前置失败时后续标为 skipped，不加模拟分数。

边界：扩展暴露最近连接阶段和时间；CLI 在现有 doctor 路径增加本机探测。浏览器 WebSocket 错误通常无法区分 DNS/TLS，输出 transport_failed，附远端系统诊断步骤，不虚构细分原因。health 成功仅证明本机到 Hub，不证明远端在线。公共诊断不携带 driver secret。

先记录当前入口，再用相同远端、时间窗和网络比较候选源；候选源不存在时先交付本地故障夹具。DNS 错误、TLS 错误、health 可用但 Upgrade 失败、设备离线分别留一条可复现证据。预设实验门槛为每个目标网络 100 次连接、成功率 ≥99%、在线 30 分钟及睡眠恢复成功；这是发布目标，不是已测结果。

测试：复用 mock-hub 注入失败，确保 doctor 不把操作端成功误报成远端成功，报告不泄露秘密。原有 status/连接错误仍可识别。实现者可决定 JSON 排版和辅助脚本命名；目标运营商、机器与候选主机由实际资源确定并写入报告。

实施证据（2026-09-11）：cli/doctor.js 已实现有期限的 DNS/TLS/健康检查，doctor 无配对也可运行；扩展状态提供 ws_auth/permission 的阶段、结果和时间。tests/doctor.test.mjs 已验证本机成功不等于远端成功、失败跳过后续、错误报告不带底层异常详情。目标远端的 100 次连接及 30 分钟观测仍待实际设备执行。
