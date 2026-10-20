# AGENTS.md — 插件工具（原子操作）标准模板

本文件是插件「工具层」的规范。新增任何面向 agent 的页面能力，都必须按这里的模板做，
不要另起一套。分支与提交规范见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

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

在 `src/tools.ts` 的 `TOOLS` 数组里新增一项，字段固定如下：

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
2. 在 `src/tools.ts` 的 `TOOLS` 加一项，按第 2 节模板填全字段；
3. 在 `src/tools.test.ts` 补两条：目录里出现、关键失败分支返回正确原因码；
4. `npm run typecheck && npm test && npm run build:local`；
5. 在测试面板里手动跑一次（见第 6 节），确认真实页面可用再算完成。

## 6. 测试面板（内嵌在投递面板里）

- 入口：投递面板标题栏的 🧪 按钮（`src/TestTools.vue`，在面板内展开，不另开窗口）。
- 打开后面板主体只显示测试工具，业务步骤暂时隐藏；点「关闭测试」回到正常投递流程。
- 工具以两列卡片列出，选中后填 JSON 参数执行，结果就地显示。
- 不可撤回工具需要点两次（第一次上膛，第二次执行）。
- 结果同时写入 `logs/plugin/` 的 `[TOOL]` 行。
- 这个区域只用于开发/验收，不承载业务逻辑。

## 7. 现有工具（以此为准）

| 工具 | 参数 | 不可撤回 |
|---|---|---|
| `list_threads` | — | |
| `read_messages` | — | |
| `list_pending_cards` | — | |
| `open_thread` | `company`, `jobTitle?` | |
| `click_card` | `kind`, `accept` | ✓ |
| `send_message` | `text` | ✓ |
| `send_resume` | `resumeName?` | ✓ |
| `delete_thread` | `company`, `jobTitle?` | ✓ |
| `scan_jobs` | `withDetail?` | |
| `read_filters` | — | |
| `select_filters` | `filters: [{group, option}]` | ✓ |
| `list_tools` | — | |

## 8. 筛选点击参考实现（按实测定，不靠猜）

实测（2026-10-20）：筛选区各选项**没有 href**，只能点。交互是「点分组 → 弹面板 → 点具体项」。

`selectSearchFilter(group, option)` 的步骤与失败状态：

1. 找分组标签（自身文本完全等于分组名）→ 找不到 `no_trigger`
2. `realClick` 分组标签，轮询等面板（≤2.4s）
3. 在面板里找**文本完全一致**的选项 → 面板没出来 `no_panel`；面板有但没有该项 `no_option`
4. 点选项；若面板里有「确定/确认/完成」再点一次
5. 记录 `urlChanged` 与当前筛选参数

失败时日志带 `panels=` 与标签链（`chain=a.b < c.d`），据此适配，不要凭猜改选择器。
