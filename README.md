# 谷谷浏览器扩展

`agent-agent-hr-extension` 是独立 Git 仓库，主项目以子模块引用。这里管理两个独立安装、独立运行和独立发布的 Chrome/Edge Manifest V3 扩展。

| 产品 | 源码 | 安装目录 | 责任 |
|---|---|---|---|
| 谷谷求职 Agent | `apps/boss-agent/` | `dist/boss-agent/` | 将真实 BOSS 页面能力提供给上游 Agent：搜索、岗位信息、投递、会话、消息、简历和卡片 |
| 谷谷网申助手 | `apps/application-autofill/` | `dist/application-autofill/` | 用户主动扫描、填写和核对网申资料；最终提交由用户完成 |

两个扩展各自拥有 manifest、后台、UI、权限、登录、存储、版本号和 ZIP，不要求同时安装，不同步 token 或运行状态。共享的是源码仓库。网申代码来源为原独立仓 main `1de4f48`，以 subtree 保留来源历史，没有导入旧功能分支或被放弃的未提交内容。

## 构建与安装

Node.js 22.15 或以上：

```bash
npm ci
npm --prefix apps/application-autofill ci
npm run build
npm run package
```

分别在 Chrome/Edge 扩展管理页开启开发者模式，加载对应 `dist/<产品>/` 目录。构建各自只清理本产品目录，不删除旧的根目录 userscript 或另一扩展产物。ZIP 位于 `dist/packages/`；下载后分别解压到各产品固定的安装目录，再加载其中直接包含 `manifest.json` 的目录。不能加载公共 `dist/` 或 `dist/packages/`，也不能把 ZIP 当作油猴更新脚本直接安装。后续升级覆盖同一目录，重新加载该扩展并刷新对应招聘页；不要每个版本更换安装路径。

BOSS 扩展首次使用：先暂停上游 Agent，等待已领取的投递/发送等动作完成；结果不确定时先只读核查。停用同一账号旧油猴脚本并刷新所有 BOSS 页面；在扩展 popup 中设置 API、登录或粘贴网站 Token、选择简历和执行标签页，再启用连接。页面使用 BOSS 原有登录态，插件的 API 登录与 BOSS 登录分别处理。未连接/冻结的执行页不应被当成已完成动作。

切换前还需用旧客户端停止仍在运行的批量/会话任务，确认停止命令已 ACK。新客户端不接管旧编排；若出现 `unsupported_command`，应停用新连接，回到旧客户端完成停止及命令交接。不要手工删除待确认命令，也不要让新客户端跳过未知命令的 ACK。

从原 `browser-extension/dist/` 迁移网申扩展时，先停用原“谷谷网申助手”并刷新已打开的 ATS 页面，再加载新的 `dist/application-autofill/`，按新安装重新登录。换目录加载会产生新的扩展 ID，旧扩展的登录、缓存和本页临时修改不会自动迁移；不要同时启用新旧两个网申扩展。保留原安装目录便于回滚。网申保持独立登录、主动填写及不自动提交规则，见 [网申说明](apps/application-autofill/README.md)。

回滚 BOSS 时先暂停 Agent、停用新扩展，核查未确认动作和待回报队列，刷新所有 BOSS 页面终止新实例，再启用旧油猴。回滚网申时先停用新网申扩展、刷新 ATS 页面，再启用原目录的旧扩展并检查登录与资料；已填写的网页内容需要用户核对，不自动撤销。两个产品各自回滚，互不切换执行端。

## Agent 调用原子工具

服务端负责决策，扩展负责在真实页面执行并返回事实。工具规范与平台回执见 [AGENTS.md](AGENTS.md)，运行边界见 [扩展架构](docs/extension-architecture.md)。

```text
Agent function call {name, arguments, id}
  -> POST /api/plugin/tools/call {name, args, request_id: id}
  -> 持久命令队列 -> BOSS 扩展 -> 页面原子操作
  -> POST /api/plugin/tools/result
  -> GET /api/plugin/tools/result/{command_id}
```

配套服务端 `GET /api/plugin/tools` 提供当前在线客户端声明的 function-call JSON Schema；旧客户端未声明参数时不伪造 schema。原有 `list_tools` 也返回扩展自己的参数目录。

```bash
npm run tool -- status
npm run tool -- functions
npm run tool -- list
npm run tool -- open_search '{"keyword":"客服","cityCode":"101010100"}'
npm run tool -- scan_jobs '{"withDetail":true,"offset":0,"limit":10}'
npm run tool -- read_job_detail '{"jobId":"<实际扫描得到的岗位ID>"}'
# 查询已有调用，command_id 使用入队时输出的实际值：
npm run tool -- result <command_id>
npm run tool -- wait <command_id>
# 投递、发消息、发简历、删会话均有真实副作用；按上游授权调用。
```

CLI 默认连接本地 `127.0.0.1:8010`；用 `AAH_API`、`AAH_TOKEN` 或测试账号环境变量指定连接。远端必须使用 HTTPS 并显式提供凭据，不会发送本地默认账号。CLI 自动为新调用生成 `request_id`，入队前输出该 ID，入队后立即输出 `command_id`；上游可用 `AAH_REQUEST_ID` 传入同一次 function call 的稳定 ID。POST 响应丢失时复用原 ID 和原参数，结果等待超时则用 `result` / `wait` 查询原 command_id，不创建新调用。`AAH_HTTP_TIMEOUT` 控制单次 HTTP 超时（默认15秒），`AAH_WAIT` 控制结果等待（默认90秒）。查询尚未完成的结果退出码为2，失败/超时为1，成功为0。

`status` 和 `functions` 都只读后端状态，不入队；`connected=false` 或目录为空表示没有已确认的执行端，后端登录成功不等于扩展已登录/连接。旧后端没有发现接口时 `functions` 明确返回 HTTP 404。首次安装和扩展登录仍在 popup 完成，之后用 CLI 调用工具，不需要操作 BOSS 页面。

`scan_jobs` 返回 `count/total/offset/limit/hasMore/nextOffset`；`withDetail=true` 默认且最多每批10个岗位，继续使用返回的 `nextOffset`。不带明细且未指定 limit 时保留整页列表。offset 基于本次页面列表顺序，翻页、筛选或列表变化后应重新扫描，不能将它当作稳定快照游标。

`open_thread` 指定岗位未匹配时返回 `not-found`，同公司多条匹配返回 `ambiguous`，不会退回首条；只有页面头部的公司、HR和岗位与目标一致才返回 `ok`。跨页调用首先回报 `navigating`，扩展最多尝试5次定位；完成后在同一个 command_id 上回报实际结果。CLI 的 `wait` 会等待过渡结束，`result` 对过渡状态返回 pending/退出码2。歧义立即终止。定位失败后仍可读状态/会话，发送等动作返回 `navigation_recovery_required`；用明确目标再次 `open_thread` 成功后恢复。旧油猴没有最终定位回报时，等待会超时，需通过 `read_thread_header` 另行确认。

搜索/岗位工具返回岗位 ID、公司、名称、地点、薪资、JD 和来源 URL；详情和会话工具使用页面实际值。`send_message` 保留 `delivered/read/sending/failed/none` 回执；`sending` 已上屏，不能因尚无送达回执而重发。

结果查询 `200 done` 表示结果已回传；`202 queued/delivered/acked` 表示队列阶段。不可撤回动作在 delivered/acked 或客户端返回 `reconciliation_required` 时，先只读核查，不自动重新入队。扩展重启后对执行中断的动作保留核查状态，页面动作和数据库上报分别处理，不以接口成功伪造平台成功。

## 开发与发布

```bash
npm run typecheck
npm run test:userscript       # 共享页面能力及油猴兼容契约
npm run test:autofill         # 网申自己的既有契约
npm run build:boss
npm run build:autofill
npm run check:artifacts
```

BOSS MV3 的运行时测试由其专用配置执行，CI 与共享页面契约分开选择；不要为小改动反复跑全部矩阵。页面真实回归不由 mock/jsdom 或构建检查代替。

- BOSS：`apps/boss-agent/package.json` / manifest，发布标签 `boss-vX.Y.Z`。
- 网申：`apps/application-autofill/package.json` / manifest，发布标签 `autofill-vX.Y.Z`。
- 两产品各自发布，不互相 bump；CI 生成分别可安装的 ZIP。
- 新扩展 Release 不占用通用 latest；旧油猴 `v*` 通道继续保留自己的更新资产。
- 不提交 dist、凭据、简历、完整 DOM 或会话正文。

## 油猴兼容入口

原 `src/`、Vue 面板、编排器与 userscript 仍用于兼容现有安装和回滚。用户已明确 BOSS 产品只保留 Agent 原子工具；旧批量投递和会话托管面板退役，不进入新扩展，业务编排由上游 Agent 完成。旧源码/产物仅作为迁移兼容与临时回滚保留，不是新扩展后续开发目标。新扩展遇到不支持的编排命令拒绝执行且不越过 ACK。

```bash
npm run build:userscript      # dist/agent-agent-hr-tampermonkey.user.js
npm run build:local           # 旧油猴本地联调包
npm run dev:serve             # 仅油猴开发加载器
```

油猴专用的 CDN/动态开发加载器不会进入 MV3 包；MV3 开发采用本地构建、扩展重载与页面重载。新扩展运行时不用 Tampermonkey。
