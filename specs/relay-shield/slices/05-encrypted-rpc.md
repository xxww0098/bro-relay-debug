# 05 端到端加密集成

依赖现有 Worker 资源限制与已通过的 04 wire-contract；按用户选择，非 CF 部署已暂缓。交付：SDK 加密请求、扩展验证后执行并加密结果；Hub 只路由密文。保留外层版本、路由、相关 ID、受限超时与尺寸，不暴露 method/path/body/status/capabilities 内容。外层路由错误与解密后的远端错误分开处理。

改动边界：cli/sdk.js、extension/remote-control.js 与协议共享模块负责信封；background 仍执行已有 API。Hub rpc 不再分类 API、分配 taskId 或构造明文取消。CLI 在加密前分配 taskId，取消走认证加密请求；端点强制任务时限与断线取消。若 Hub 丢弃取消，任务也必须在端点时限内停止，不能依赖“不可信 Hub 自觉取消”。已完成操作不能回滚。

SDK handshake 必须完成端点认证，不能凭 Hub hello 认定浏览器身份。状态接口只说明中继连接；capabilities、页面、截图、eval、错误详情均来自认证密文。单向结果丢失仍返回 unknown_outcome，保留 taskId，禁止写操作自动重发。用户关闭、轮换、切入口与权限撤销均使旧会话立即失效。

验证：运行一个录制并篡改帧的测试 Hub，确认页面/脚本/密钥不出现在其输入输出中，篡改不执行；截图往返不破坏；取消在排队中/执行中/结果丢失时符合现有合同；协议降级失败；新旧版本提示明确。更新现有信任 fresh hello 的测试，保留其余任务安全测试。生成 runtime 并检查打包不漏共享模块。

实现者可选择模块命名，不可接受明文 fallback 或删掉取消保障来缩短补丁。
