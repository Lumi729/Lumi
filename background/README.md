# Lumos 后台回复（普通 + 自动）

由 Codex（g老师）维护。页面的定时器可能在手机后台暂停，本服务使用 Cloudflare Durable Objects Alarm 独立处理普通回复与自动回复请求，再通过 Web Push 唤醒手机的 Service Worker。发布网页不等于后台已部署：须在自己的 Cloudflare 配置一次。

## 手机部署

打开 [手机部署页面](https://lumi729.github.io/Lumi/background-setup.html)，有本地密钥生成器和逐步说明。

1. Cloudflare → Workers & Pages → 创建应用 → 导入 GitHub 仓库，选择 `Lumi729/Lumi` / `main`。
2. Worker 名称 `lumos-background`，根目录 `background`，构建命令 `npm ci && npm test`，部署命令 `npm run deploy`。不选择 Pages 静态站点。
3. 部署完成后，Worker 设置 → 变量和机密，添加四个 **Secret**。用手机部署页面生成：`ACCESS_TOKEN`、`STORAGE_KEY`、`VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`。生成器不会联网或持久保存密钥。四项只存到你自己的 Cloudflare，不提交到仓库。
4. `https://你的Worker地址/health` 应显示 `configured:true`。此接口仅显示是否配置，不返回密钥。
5. Lumos → 当前单人角色 → 设置 → AI 回复 → 后台自动回复。填 Worker 根地址和 `ACCESS_TOKEN`，明确同意上传 API 密钥、角色设定及上下文，启用并允许通知。
6. 先测试推送，再将自动回复延迟设为 1 分钟（确认每日次数还有余量），切后台等候，回来同步结果。最终实机验收需要你完成这一步；仓库测试不代表手机已收到通知。

默认可使用 workers.dev 地址。自己的域名可以在 Worker 的 Domains & Routes 中绑定；Lumos 前台继续使用原地址和原本的本地聊天数据。不要迁移前台域名来测试，否则浏览器不会自动共享原域的聊天存储。

若前台改用自己的域名，应同步修改 `wrangler.jsonc` 的 `APP_ORIGIN` 与 `VAPID_SUBJECT`，并修改前台 `/Lumi/` 路径配置；这不是此首版的部署步骤。

## 电脑部署（可选）

在此目录运行 `npm ci`、`npm test`、`npx wrangler login`、`npm run deploy`，然后 `npm run setup`。setup 只在本机生成四个 Secret，通过 Wrangler 写入你的 Worker；将连接口令写入本地 `.connection-token.txt` 供你填入 Lumos，不打印密钥。该文件和 `.dev.vars` 均被 gitignore 排除。

## 行为和限制

- 首版客户端仅接管一个单人角色的普通回复与自动回复，其他角色及群聊继续本地模式。后台与本地不会为同一接管角色同时自动生成。
- 普通回复在你请求回复后立即排队交给后台，不占自动回复每日次数，不需要页面持续运行。页面收到后台已接收后不会再次调用 AI；未接收成功时提示错误而不自动改走本地，避免重复扣费。返回页面后读取原始回复时间，普通回复不会标记成主动消息。
- 自动回复按设置的延迟调度；每天在每日最小/最大次数之间选固定上限，采用手机上传的时区偏移。已有当日计数会带到后台；模型决定不主动聊天也会占一次调用，避免无限请求。
- 后台使用连接时的上下文快照，随后追加自己生成的回复；手机在线时更新快照。在线操作与后台生成仍可能同时发生，新的 revision 会让进行中的旧结果丢弃，避免追加过期回复，但已发起的 AI 请求可能已计费。
- 7 天不刷新连接自动删除任务中的 API 密钥和上下文，停止生成。回来后可以重新上传快照继续；最多 40 轮未同步结果后暂停到次日，直到同步。
- 默认只发送聊天文本，剥离思考过程和设备/钱包/撤回/跨聊指令；后台不执行这些操作。天气与其他动态状态不是持续刷新，角色设定和摘要使用上传时的快照。
- 普通与主动回复都遵循原“消息通知”开关；正在对应聊天页查看时不额外推送。最多三条消息分别显示通知，超过三条显示摘要。点通知进入对应角色；回复原始时间和稳定消息 ID 在回到页面后保存到本地 IndexedDB。确认本地保存成功后才向后台确认，不重复发送本地通知。
- 未同步的后台回复先导入，防止页面旧快照覆盖新回复。断网时不会偷偷恢复本地自动回复；须成功关闭并删除后台数据才恢复本地模式。
- Web Push 接受不等于系统弹出横幅。支持 Chrome/Android 常见 FCM、Firefox、Apple 推送端点；当前网络必须能访问相应推送服务。系统省电、通知权限、浏览器限制仍可能影响到达。推送失败不丢失后台回复，回来可同步。
- 推送短暂失败最多重试三次，使用稳定通知 tag；订阅失效会停止向旧订阅推送。重新连接可生成订阅。AI 超时不自动重试本轮，避免重复付费；会在下一调度周期尝试新一轮。
- 一个后台服务是一个所有者，使用随机连接口令保护。**不要与别人共享连接口令或同一后台服务**。不支持多设备独立账号；每次订阅会替换这个后台的手机订阅。
- API 密钥、上下文与订阅在 Durable Object 中用 AES-GCM 加密，主密钥在 Worker Secret。运行时必须解密调用 AI，此实现不是端到端的本地保密。Cloudflare 和你的 AI 接口会处理必要数据。不记录消息内容、密钥、推送订阅到控制台。
- “关闭并删除后台数据”删除活动存储与调度，不声称删除 Cloudflare 平台可能保留的备份/恢复历史。API 请求会产生你原 AI 服务的费用，Cloudflare 使用量受其套餐额度约束。

## 排查

- 看 `/health` 的 `configured`；401 检查连接口令；503 检查四项 Secret。不要把实际值发到聊天里。
- Worker 名称必须匹配配置；构建根目录为 `background`，需要真实部署，版本预览不代替后台运行。
- 前台设置里看“后台状态”：下一调度、每日计数和失败信息来自服务端。每日额度用尽会等下一天，`AUTO_SKIP` 不产生通知但可以同步结果。
- 测试推送未收到但后台回复能同步：检查手机通知栏、浏览器通知权限和推送服务连通性，不能靠反复打开页面判定发送是否成功。

## 验证

`npm test`（18 项）验证普通回复优先处理、不受主动次数限制、可见聊天免推送、中断不重复调用，以及通知拆分、思考/控制指令过滤、加密及口令、时区和每日限额、任务版本变化、失败与重复调度、确认后删除等。`npx wrangler deploy --dry-run` 验证真实 Worker 打包；不连接用户 Cloudflare、不使用真实 API 密钥、不向真实手机发推送。

参考：[Workers Builds 配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)、[Durable Objects Alarm](https://developers.cloudflare.com/durable-objects/api/alarms/)、[Cloudflare SQLite Durable Objects 额度](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[Web Crypto Web Push](https://github.com/block65/webcrypto-web-push)。
