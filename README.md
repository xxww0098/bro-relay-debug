# Bro Relay Debug

用一个驱动 ID 连接用户正在使用的 Chrome / Edge。远端电脑只安装扩展，
无需 Node、SSH、本地守护进程或开放端口。代理端通过 CLI 操作已有登录态的页面。

## 部署到 Cloudflare

Cloudflare 上部署的是 **Hub（Worker + Durable Objects）**。浏览器扩展交给用户安装，
CLI 和技能运行在代理电脑上。三者通过同一个 Hub 地址通信。

以下命令均在项目根目录执行。部署和打包电脑需要 Node.js 22.16+、npm、系统 `zip`，
以及有 Workers 部署权限的 Cloudflare 账号。远端浏览器电脑不需要这些开发工具。

### 1. 安装依赖并登录

```sh
cd /Users/xxww/Code/REPO/bro-relay-debug
npm ci
npx wrangler@4 --version
npx wrangler@4 login
npx wrangler@4 whoami
```

`login` 会打开浏览器授权。`whoami` 用于确认部署账号；如果属于多个账号，
在 [hub/wrangler.toml](hub/wrangler.toml) 顶部、`name` 同级添加
`account_id = "你的 Cloudflare Account ID"`。

### 2. 确认部署配置

使用仓库现有的 [hub/wrangler.toml](hub/wrangler.toml)，无需创建新的 Worker 工程。

- `name` 是 Cloudflare 中的 Worker 名称。首次部署前可改为自己的名称；后续更新保持一致。
- `workers_dev = true` 启用 Cloudflare 提供的公网域名，无需先购买域名。
- `DEVICES` 绑定和 `BrowserRelayDevice` 类名必须与代码一致。
- `migrations` 中的 `new_sqlite_classes` 用于首次创建 Durable Object 命名空间，
  Wrangler 部署时处理，无需手动创建数据库。后续部署保留已有迁移记录。

这个 Hub 不需要额外的 KV、R2、D1 或统一访问密码。每个浏览器的驱动 ID 由扩展生成，
用于授权该浏览器的连接，不应填写到 Cloudflare 配置中。
配置中的迁移格式见 [Cloudflare Durable Object 迁移说明](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/)。

### 3. 检查并发布 Hub

先打包检查，不发布：

```sh
npx wrangler@4 deploy --config hub/wrangler.toml --dry-run
```

检查通过后正式部署：

```sh
npx wrangler@4 deploy --config hub/wrangler.toml
```

记下终端输出的正式地址，例如：

```text
https://bro-relay-debug-hub.YOUR_SUBDOMAIN.workers.dev
```

使用终端实际输出的地址，不要照抄示例中的占位符。
发布与登录命令见 [Wrangler 官方命令说明](https://developers.cloudflare.com/workers/wrangler/commands/)。

### 4. 验证 Hub 可访问

将下面的域名替换为刚部署的地址：

```sh
curl --fail-with-body "https://bro-relay-debug-hub.YOUR_SUBDOMAIN.workers.dev/v1/health"
```

把 `YOUR_SUBDOMAIN` 替换为自己的子域。正常响应包含 `"ok": true`；
`service` 当前返回 `browser-relay-hub`，这是沿用的协议服务名。
健康检查成功只代表 Hub 已上线，还需完成下面的扩展连接验证。

### 5. 将 Hub 地址写入扩展和 CLI

首次配置时复制示例文件；已有 `.env` 时直接编辑，避免覆盖自己的设置：

```sh
cp .env.example .env
```

将 `.env` 中的值改为自己的正式地址：

```dotenv
BRO_RELAY_HUB_URL=https://bro-relay-debug-hub.YOUR_SUBDOMAIN.workers.dev
```

地址只包含 `https://` 和域名，不加 `/v1/rpc`、路径、查询参数或密码。
`.env.example` 中的默认地址是已有 Hub，部署自己的 Hub 后必须替换。
然后构建并安装技能：

```sh
npm run build
npm run skill:install
```

构建输出会显示本次使用的 Hub 地址，并生成 `dist/bro-relay-debug-extension.zip`。
同一地址会写入 CLI、扩展配置及扩展域名权限。构建时的进程环境变量优先于 `.env`；
如果输出的地址不是预期值，检查终端是否另设了 `BRO_RELAY_HUB_URL`。

`.env` 是**本地打包配置**，不是 Cloudflare Worker 的运行时变量。
只改 `.env` 不会更新已安装的扩展，也不会自动修改旧版 CLI。

### 6. 安装扩展并验证完整链路

将 `dist/bro-relay-debug-extension.zip` 交给用户，解压后在
`chrome://extensions` 或 `edge://extensions` 开启开发者模式，选择“加载解压缩的扩展”。
打开扩展的滑动开关，等待“已连接”，复制驱动 ID 提供给装有
[bro-connect](skills/bro-connect/SKILL.md) 的代理。

代理连接成功后，可在代理电脑验证：

```sh
node cli/index.js doctor
node cli/index.js tabs
```

`doctor` 应显示 `connected: true`，`tabs` 应列出远端打开的普通网页。
这才说明“代理 → Cloudflare Hub → 浏览器扩展”的整条链路正常。
移动项目目录后，重新执行 `npm run skill:install` 更新技能运行路径。

直接使用 CLI 时，运行 `node cli/index.js --help` 查看当前命令。
连接后先列出标签页，再用返回的标签页 ID 操作指定页面。

### 后续更新与排查

仅更新 Hub 代码且地址不变时，重新执行第 3 步的部署命令即可。
如果改变 Hub 域名，需要重新构建、分发扩展，并更新代理端 CLI；
用户覆盖原解压目录后，在扩展管理页点击重新加载。

查看 Hub 的实时日志：

```sh
npx wrangler@4 tail --config hub/wrangler.toml
```

| 现象 | 检查方法 |
| --- | --- |
| 部署提示未登录或账号不正确 | 重新运行 `login`、`whoami`，核对 `account_id` |
| 部署找不到入口或 `DEVICES` 绑定 | 在项目根目录执行命令，并保留 `--config hub/wrangler.toml` |
| 健康检查失败 | 核对部署输出的正式域名，以及两端电脑能否访问该地址 |
| Hub 正常，但扩展一直连接中 | 核对构建输出的地址，重新加载新扩展；远端网络必须允许连接该域名的 WSS |
| 扩展已连接，但 CLI 提示离线 | 确认扩展和 CLI 来自同一 Hub 配置，并使用当前驱动 ID 重新连接 |
| 修改 `.env` 后仍连接旧地址 | 重新运行构建，分发新扩展并更新代理端；检查终端环境变量是否覆盖 `.env` |

## 连接边界

扩展主动通过 WebSocket 连接 Hub；CLI 通过 HTTPS 请求同一个 Hub，Hub 将请求
转交给扩展中的浏览器执行器。驱动 ID 是访问凭证，代理端的连接文件使用受限权限保存。
停用开关会断开控制，重新启用保留原 ID；重新生成 ID 会使旧连接失效。

Hub 能看到转发内容，因此必须使用自己信任的 Hub。普通请求头脱敏不能替代对
页面内容的隐私判断。任务取消只停止后续操作，不撤销已完成的点击或提交；
网络超时后应检查任务和页面结果，不能盲目重试。

## 验证与维护

```sh
npm test
npm run test:browser
```

浏览器检查使用独立的临时 Chromium 配置和本地测试 Hub，不连接用户的生产页面。
首次运行若缺少测试浏览器，执行 `npx playwright install chromium`。
浏览器执行内核与 Hub 的来源见 [第三方声明](THIRD_PARTY_NOTICES.md)；
通用 CLI 操作入口在 [cli/](cli/)，技能只维护代理决策规则，不重复命令手册。
