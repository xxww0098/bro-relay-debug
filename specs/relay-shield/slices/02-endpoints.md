# 02 运行时入口与权限

交付：扩展设置页可选 HTTPS origin，CLI `connect --hub <origin>` 保存 `{hubUrl, driverId}`，SDK 优先显式 options，再使用已保存连接，最后构建默认。不改变默认配置生成链路。

构建默认入口已由用户选定为 `https://relay.xxww.club`，配置值为 `BRO_RELAY_HUB_URL=https://relay.xxww.club`；设备 WSS 地址为 `wss://relay.xxww.club/v1/device/connect`。先复用 `BRO_RELAY_HUB_URL` 生成扩展、CLI 与 skill runtime 的统一地址；运行时配置是在此基础上的切换能力。

将现有 origin 校验收敛为共享函数：生产只接受 HTTPS origin，拒绝 userinfo、路径、query、fragment；HTTP 仅 localhost 测试。请求拒绝重定向。设置页从用户点击直接请求选中源的权限；manifest 声明 optional HTTPS hosts，安装时不授予全部源。权限拒绝保持旧配置；撤回当前源权限停止远控。

切换入口时先关闭旧 generation、取消任务和 detach，成功保存新设置后生成新凭据并连接，不把旧 secret 自动发送到新运营方。CLI 只在验证成功后原子写配置。复制的连接资料必须明确关联 origin，最终加密配对格式由 04 固化。

验证：两台本地测试 Hub 之间无需重打包切换；拒绝权限、非法 URL、旧 socket 回包、保存失败不会错误显示已连接。原有禁用/轮换/取消测试保持通过。SDK 注入测试保留；构建与 skill runtime 一致性通过。

实现者可决定设置布局和内部文件名，不可增加自动故障转移。UI 最后按 README 执行 screenshot-critique；与旧设置页比较时先执行 compare-screenshots。

实施证据（2026-09-11）：共享 origin 校验、CLI 保存 Hub、扩展地址表单与精确源权限检查已实现。切换旧 socket 关闭、凭据轮换及非法地址保留状态均有回归测试。完整 browser-test 通过；assets 中保存关闭/设置/错误截图与局部放大。与旧弹窗同尺寸比较确认实际像素变化；独立截图审查未发现可见裁切、重叠或可读性问题。默认域名将在生产绑定后同步生成。
