# AGENTS.md — 双扩展边界与 BOSS 工具规范

本仓库管理两个独立扩展：`apps/boss-agent/` 把 BOSS 页面能力封装成标准工具供上游 Agent 调用，`apps/application-autofill/` 保留独立网申填写产品（详见 [README](./README.md)）。两个扩展分别维护 manifest、权限、登录、存储、版本、安装包和发布，不共享运行态。网申专属规则见其目录 AGENTS.md；原 `src/` userscript 保留兼容。
本文件定义：工具是什么、怎么调、怎么新增、返回值怎么判、BOSS 页面的真实标记。
新增任何面向 agent 的页面能力都按这里做，不另起一套。分支与发布见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 0. 怎么调用（插件常驻，直接调接口）

插件在 BOSS 页面里保持启用即可，开发者和 agent 都**不需要**在页面上点任何东西。

```bash
npm run tool -- functions                               # 在线扩展的 function-call 参数定义（配套后端）
npm run tool -- list                                    # 插件当前上报的工具清单
npm run tool -- read_thread_header '{"company":"某公司"}'
```

`scripts/tool.mjs` 走的就是 agent 用的两个接口：

```
POST /api/plugin/tools/call    {name, args}  → {queued, command_id, irreversible}
GET  /api/plugin/tools/result/{command_id}   → 200 结果 / 202 阶段（见 §8）
```

- 入队前服务端按插件上报的清单校验工具名，未知工具 400。
- 结果保留 10 分钟、上限 200 条、超过 200KB 截断；`logs/plugin/YYYY-MM-DD.log` 只有摘要。
- **读页面结构也用工具，不开 DevTools**（BOSS 检测到 F12 会关页）：
  `get_page_state` `read_filters` `scan_jobs` `list_threads` `read_messages` `probe_dom` `probe_overlays` `probe_row`。
- **时延**：插件约 1 秒一次心跳。标签页在后台时，0.6.56 起由 Worker 驱动心跳避开 Chrome 的定时器节流。
- **冻结（整页暂停）**：Chrome 的「节省内存」等机制可能把后台标签页整页冻结，Worker 一起停，
  命令会一直 `queued`，页面恢复后照常执行（不丢、不重复）。插件在冻结/恢复时写
  `[REMOTE] page_lifecycle status=frozen|resumed frozen_s=N`。要长期挂后台跑 agent，
  在 `chrome://settings/performance` 把 `www.zhipin.com` 加入「始终保持这些网站的活动状态」。
  agent 侧判断：心跳 `last_seen` 停止更新 = 插件不在线或被冻结，不要把超时当成工具失败。

## 1. 什么是工具

工具 = **一件页面原子操作**（读一次消息、发一条消息、点一次筛选项……），
参数和返回值都是纯数据。agent 决定「做不做、做哪个」，插件只负责执行和记账。

分层：

```
agent（服务端决策）
  └─ POST /api/plugin/tools/call  { name, args }   → 入队 tool.call 命令
       └─ 插件心跳取走 → callTool(name, args)      → tools.ts 注册表
            └─ run(args)                          → 具体页面动作（boss-chat / search-filters）
```

## 2. 工具定义（唯一模板）

页面执行定义统一维护在 `src/tool-definitions.ts`，原 `src/tools.ts` 与 MV3 的 page-tools 通过不同运行环境适配。function-call 参数目录在 `apps/boss-agent/src/tools-contract.ts`。新增工具同步执行定义、参数 schema 与本文件，不维护两份分叉实现。字段示例：

```ts
{
  name: 'select_filters',                 // 小写蛇形，动词开头，全局唯一
  description: '一句话说清做什么、参数含义', // 给 agent 看的契约
  irreversible: true,                     // 有不可撤回副作用时必须为 true
  exampleArgs: { filters: [{ group: '工作经验', option: '3-5年' }] },
  async run(args) {
    // 1) 校验参数：缺参直接返回 { ok:false, error:'<原因码>' }，不要猜默认值
    // 2) 调具体实现（页面动作放在 platforms/ 或专题模块里，tools.ts 只做编排）
    // 3) 返回 { ok, data } 或 { ok:false, error }
    return { ok: true, data: results }
  },
}
```

硬性要求：

| 要求 | 说明 |
|---|---|
| **不套业务策略** | 回不回、发哪份简历、同意还是拒绝，由 agent 决策。工具里不得再按产品规则拦一道 |
| **不可撤回要标记** | `send_message` / `send_resume` / `delete_thread` / `click_card` / `select_filters` 都是 |
| **失败要有原因码** | `error` 用稳定短码（`text_required`/`not_chat_page`/`no_option`…），不要写长句 |
| **不猜** | 参数缺失或页面结构不匹配时停下并返回原因，不按默认值继续 |
| **日志脱敏** | 只记数量/状态/长度；**不记**消息正文、简历文件名、联系方式 |
| **幂等/防重** | 点击类动作先打 `data-aah-card-handled` 之类的标记，避免重复点击 |

## 3. 日志格式（服务端可直接读）

`callTool` 统一写一行 `[TOOL]`：

```
tool name=read_messages status=ok ms=42 messages=6 hr=4 me=1 system=1
tool name=select_filters status=ok ms=812 filters=1
tool name=delete_thread status=error ms=120 error=not-found
```

具体实现内部另有自己的日志（`[CHAT]` / `[FILTER]` / `[BOSS]`），同样只记结构化事实。

## 4. 工具清单的对外暴露

- 心跳（`remote.ts`）上报 `capabilities: ['command_ack_v2','tools_v1']` 与 `tools: toolCatalog()`；
- 服务端 `HeartbeatRequest.tools` 保存清单，`POST /api/plugin/tools/call` 入队前校验工具名；
- 命令通道：`tool.call`，payload `{ name, args }`。**执行失败也 ACK**，避免不可撤回动作重试两次。

## 5. 新增工具的做法（照抄即可）

1. 页面动作写到 `src/platforms/<平台>.ts` 或专题模块（如 `search-filters.ts`），导出纯函数；
2. 在共享工具工厂及 MV3 参数目录加一项，按第 2 节模板填全字段；
3. 在 `src/tools.test.ts` 补两条：目录里出现、关键失败分支返回正确原因码；
4. `npm run typecheck && npm test`；`npm run dev:serve` 自动重建，`npm run tool -- reload_page` 让页面换上新版本；
5. `npm run tool -- <新工具> '<args>'` 在真实页面跑通，再在 §7/§8 补上验证记录，才算完成。

## 6. 面板内调试区（辅助）

- 入口：投递面板标题栏的 🧪 按钮（`src/TestTools.vue`，在面板内展开，不另开窗口）。
- 打开后面板主体只显示测试工具，业务步骤暂时隐藏；点「关闭测试」回到正常投递流程。
- 工具以两列卡片列出，选中后填 JSON 参数执行，结果就地显示。
- 不可撤回工具需要点两次（第一次上膛，第二次执行）。
- 结果同时写入 `logs/plugin/` 的 `[TOOL]` 行。
- 只用于人工点按排查；验收以 §0 的命令行调用为准。不承载业务逻辑。

## 7. 现有工具（以此为准）

| 工具 | 参数 | 不可撤回 | 说明 |
|---|---|---|---|
| `get_page_state` | — | | 当前网址、是否聊天页、当前打开会话 |
| `open_search` | `keyword`, `cityCode?`, `page?` | | 打开职位搜索页（保留当前筛选） |
| `scan_jobs` | `withDetail?` | | 扫描岗位；`withDetail=true` 连 JD 一起读 |
| `read_job_detail` | `jobId` | | 读指定岗位 JD 全文（只切详情，不投递） |
| `apply_job` | `jobId` | ✓ | 对指定岗位点「立即沟通」并记账 |
| `read_filters` | — | | 读筛选分组/选项/当前选中 |
| `select_filters` | `filters: [{group, option}]` | ✓ | 点选筛选项 |
| `list_threads` | — | | 列出会话（HR 名/公司/未读；岗位与薪资列表行没有） |
| `read_thread_header` | `company`, `jobTitle?` | | 打开会话并读头部：HR 名/公司/岗位名/薪资/城市 |
| `read_messages` | — | | 读当前会话消息（含卡片类型） |
| `list_pending_cards` | — | | 列出待处理卡片 |
| `open_thread` | `company`, `jobTitle?` | | 打开指定会话 |
| `click_card` | `kind`, `accept`, `resumeName?`, `resumeIndex?` | ✓ | 点卡片同意/拒绝；同意索要简历时走完发送 |
| `send_message` | `text` | ✓ | 给当前会话发文本；返回 `data.delivery` = delivered/read/sending/failed/none；未打开会话返回 `no_open_thread` |
| `send_resume` | `resumeName?`, `resumeIndex?` | ✓ | 发附件简历；失败返回具体原因码 |
| `delete_thread` | `company`, `jobTitle?` | ✓ | 删除会话 |
| `reload_page` | `force?` | | 刷新页面以加载最新插件构建；自动投递运行中拒绝（`orchestrator_running`），除非 `force=true` |
| `probe_overlays` | — | | 读可见浮层结构（排障用） |
| `probe_dom` | `selector`, `depth?` | | 读指定选择器的 DOM 结构（排障用） |
| `probe_row` | `company?` | | 读会话行组件字段（排障用） |
| `list_tools` | — | | 列出工具清单 |

## 8. 完整链路的工具覆盖

| 链路环节 | 工具 | 状态 |
|---|---|---|
| 搜岗位（关键词/城市/翻页） | `open_search` + `scan_jobs` | 已验证（scan 300 条上限） |
| 选筛选条件（城市/类型/薪资/经验…） | `read_filters` + `select_filters` | 已验证（工作经验=3-5年 → URL 出现 experience） |
| 取岗位数据（公司/岗位/JD/薪资/地点） | `scan_jobs`（`withDetail`）、`read_job_detail` | 已验证（2026-10-21：「客服」搜索 240 个岗位；JD 627 字，已剔除反爬水印） |
| 投递（点立即沟通 + 打招呼 + 记账） | `apply_job` | 已验证（非计算机岗位真实投递并记账） |
| 读会话与消息分类 | `list_threads`、`read_messages` | 已验证（含系统消息全文） |
| 会话的岗位名/薪资/城市 | `read_thread_header` | 已验证（6 个会话实测，与页面头部一致） |
| 处理 HR 卡片（要简历/地点/联系方式） | `list_pending_cards` + `click_card` | 已验证（索要简历卡片 → 真实发出简历） |
| 发消息 | `send_message` | 已验证（2026-10-21：返回 `delivery=delivered`，读回确认最后一条是我方刚发的） |
| 发简历 | `send_resume`、`click_card` | 已验证（BOSS 出现「点击查看附件」系统卡片）；失败原因码已细分 |
| 删会话 | `delete_thread` | 已验证（京北方会话删除成功，重新打开返回 not-found） |

判定「封装完成」的标准：agent 只靠工具 + `/tools/result` 就能完成该环节，不依赖页面手动操作。

**不可撤回工具超时后一律不自动重发**：先看 `state`，`delivered`/`acked` 时用只读工具（`read_messages` / `list_pending_cards` / `list_threads`）核实页面结果。

### 结果判定协议（agent 必读）

`GET /api/plugin/tools/result/{id}`：

| HTTP | `state` | 含义 | agent 该做什么 |
|---|---|---|---|
| 200 | `done` | 结果已回传，看 `ok` / `data` | 按结果处理 |
| 202 | `queued` | 插件还没取走 | 继续等；可安全撤销重发 |
| 202 | `delivered` | 插件已取走、正在执行 | **继续等，绝不重发** |
| 202 | `acked` | 插件执行完但结果没传回 | **不重发**，用 `read_messages` 核实 |
| 404 | — | 命令不存在（或不属于当前用户） | 重新下发 |

`send_message` 的 `data.delivery`：

| 值 | 页面证据 | 是否已发出 |
|---|---|---|
| `delivered` | 新气泡上 `i.message-status.status-delivery`「送达」 | 是 |
| `read` | `i.message-status.status-read`「已读」 | 是 |
| `sending` | 新气泡已出现，回执 8 秒内未到 | 是（视为已发出，**不重发**） |
| `failed` | BOSS 标了失败/重发 | 否 |
| `none` | 没出现新气泡 | 否 |

判定只看「发送前后我方气泡数 + BOSS 回执标记」，不靠文本匹配（历史同文消息、输入框残留都会误判）。

## 9. BOSS 页面的真实标记（2026-10-20 实测，别再猜）

| 状态 | 页面特征 |
|---|---|
| 卡片已处理 | 卡片按钮被禁用：`span.card-btn.disabled` / `span.btn-v2.disabled`（不是靠消息文字判断） |
| 简历已发出 | 系统消息全文「您的附件简历 xxx 已发送给Boss点击查看附件」；或系统卡片链接「点击查看附件」；或「对方已查看了您的附件简历」 |
| 简历选择框 | `.boss-popup__content > .boss-dialog__body > .choose-resume-dialog`；选项 `ul.resume-list > li.list-item[.selected]`；发送 `button.btn-v2.btn-sure-v2` |
| 工具栏发简历不可用 | `.toolbar-btn.tooltip.unable`（BOSS 未允许时），此时必须走 HR 卡片的「同意」 |
| 离屏副本 | BOSS 保留一份视口外的 `.choose-resume-dialog`，宽高正常、位置在外，必须用 `inViewport` 过滤 |
| JD 反爬水印 | `p.desc` 里夹着随机 class 的 `<span>`，文本「kanzhun」「boss」「来自BOSS直聘」「直聘」，用 `width:0.1px`/0 宽等隐藏（**不等于 0**，不能用 `=== 0` 判断）；在活 DOM 上按「宽或高 <1px / display / visibility / opacity / font-size:0」剔除（克隆后没有布局） |
| JD 正文范围 | `.job-detail-box > .job-detail-body > h3.title「职位描述」+ p.desc`；同面板还有 `.job-boss-info`（HR 名片）、`.job-address`（地址），页面底部有 SEO 链接墙，**只取 `p.desc`** |
| 标题里的薪资残渣 | 薪资数字被字体混淆成私有区字符，标题末尾只剩「-K」「-K·薪」，需剥掉 |

判定卡片状态一律看按钮禁用态；判定发送成功一律看上述系统痕迹，并与发送前基线比较。

## 10. 筛选点击参考实现（按实测定，不靠猜）

实测（2026-10-20）：筛选区各选项**没有 href**，只能点。交互是「点分组 → 弹面板 → 点具体项」。

`selectSearchFilter(group, option)` 的步骤与失败状态：

1. 找分组标签（自身文本完全等于分组名）→ 找不到 `no_trigger`
2. `realClick` 分组标签，轮询等面板（≤2.4s）
3. 在面板里找**文本完全一致**的选项 → 面板没出来 `no_panel`；面板有但没有该项 `no_option`
4. 点选项；若面板里有「确定/确认/完成」再点一次
5. 记录 `urlChanged` 与当前筛选参数

失败时日志带 `panels=` 与标签链（`chain=a.b < c.d`），据此适配，不要凭猜改选择器。
