# BOSS 直聘 Agent 工具层（油猴插件）

**本仓库的核心目标：把 BOSS 直聘页面上能做的每一件事，封装成标准工具，供上游 agent 调用。**

agent 负责决策（投哪个岗位、回什么话、发哪份简历、删不删会话），本插件只负责在用户真实的 BOSS 页面里**执行**并**如实回报结果**。插件里不放业务策略。

工具规范、清单、调用协议和 BOSS 页面的真实标记见 **[AGENTS.md](./AGENTS.md)**（工具层的唯一规范）。

## 产品形态

```
上游 agent（服务端决策）
   │  POST /api/plugin/tools/call {name, args}      GET /api/plugin/tools/result/{id}
   ▼
agent-agent-hr 后端（命令队列 + 结果暂存，见主仓 server/routers/plugin.py）
   │  插件每秒心跳：上报工具清单 / 取走命令 / 回传结果
   ▼
本插件（运行在用户浏览器的 BOSS 页面里）── 执行页面动作 → BOSS 直聘
```

- **为什么跑在用户浏览器里**：BOSS 的风控、登录态、字体混淆都绑在真实浏览器会话上。插件复用用户自己的登录态，以人的方式点页面，不碰 BOSS 私有接口。
- **两种使用方式**：
  1. **agent 驱动（主形态）**：插件常驻在 BOSS 页面，上游 agent 通过 HTTP 调工具，无需人工操作。
  2. **面板驱动**：页面右侧「投」悬浮面板，用户登录、选简历、一键开始自动投递（内部走后端编排，同一套页面能力）。面板标题栏 🧪 是工具调试入口。

## 工具一览

20 个工具，全部在真实账号上验证过（详细参数、返回值与验证记录见 [AGENTS.md §7–§8](./AGENTS.md)）：

| 环节 | 工具 |
|---|---|
| 搜索与岗位 | `open_search` `scan_jobs` `read_job_detail` `apply_job` |
| 筛选条件 | `read_filters` `select_filters` |
| 会话与消息 | `list_threads` `read_thread_header` `open_thread` `read_messages` `send_message` |
| HR 卡片与简历 | `list_pending_cards` `click_card` `send_resume` |
| 会话管理 | `delete_thread` |
| 状态与排障 | `get_page_state` `probe_dom` `probe_overlays` `probe_row` `list_tools` |

不可撤回的工具（`apply_job` `select_filters` `click_card` `send_message` `send_resume` `delete_thread`）在清单里带 `irreversible: true`。

## 快速开始（开发 / 联调）

```bash
npm ci
npm run build:local          # 连本地后端 http://127.0.0.1:8010
# 把 dist/agent-agent-hr-tampermonkey.user.js 拖进 Tampermonkey，打开 BOSS 聊天页并登录面板
```

后端在主仓用 `./scripts/start-local-test.sh` 启动（开启账号密码登录、建本地测试账号）。

然后直接调工具，**与上游 agent 走完全相同的接口**：

```bash
npm run tool -- list                                   # 插件上报的工具清单
npm run tool -- get_page_state                         # 当前页面/会话
npm run tool -- read_thread_header '{"company":"某公司"}'
npm run tool -- send_message '{"text":"您好"}'          # 不可撤回
```

`scripts/tool.mjs` 实现了结果协议（`202 queued/delivered/acked`），超时只报告状态、**从不自动重发**。环境变量见脚本头注释。

## 安装（用户）

1. Chrome/Edge 装 [Tampermonkey](https://www.tampermonkey.net/)，在扩展详情里开启「开发者模式」与「允许用户脚本」（MV3 权限，默认关闭会让脚本静默失效）。
2. 从 [Releases](https://github.com/dayagu04/agent-agent-hr-tampermonkey/releases) 下载最新 `agent-agent-hr-tampermonkey.user.js` 拖入 Tampermonkey。脚本带 `@updateURL`，会自动提示更新。
3. 打开 BOSS 直聘，右侧出现「投」悬浮球，登录后即可。

## 项目结构

```
src/
├── tools.ts            # ★ 工具注册表：agent 可调用的全部原子操作
├── remote.ts           # 心跳 / 命令轮询 / tool.call 执行与结果回传
├── platforms/
│   ├── boss.ts         # 搜索页：扫描岗位、读 JD、立即沟通
│   ├── boss-chat.ts    # 聊天页：会话、消息、卡片、发消息/简历、投递回执
│   ├── boss-delete.ts  # 删除会话链路
│   ├── base.ts / factory.ts
│   └── zhaopin.ts / liepin.ts / qiancheng.ts   # 其他平台适配（未开放 agent 工具）
├── search-filters.ts   # 搜索页筛选区读取与点选
├── nav-unread.ts       # 导航未读角标
├── orchestrator.ts / engine.ts   # 面板「自动投递」：执行后端编排指令
├── api.ts / platform-bridge.ts   # 后端通信 / GM API 隔离层
├── dom-events.ts / domprobe.ts   # 合成点击（含遮挡处理）/ 通用 DOM 定位
├── logger.ts           # 脱敏诊断日志，批量上报后端（落盘 logs/plugin/）
├── App.vue / TestTools.vue        # 悬浮面板 / 🧪 工具调试区
└── ledger.ts / chat-*.ts / contact-policy.ts / config.ts / types.ts
scripts/
├── tool.mjs            # 命令行调用工具（开发联调 / 验收）
└── build-local.mjs     # 本地构建（连 127.0.0.1:8010）
```

## 开发约束

- **读页面结构用工具，不开 DevTools**：BOSS 检测到 F12 会关页。用 `probe_dom` / `probe_overlays` / `probe_row` 拿真实结构。
- **页面判断以 BOSS 自己的标记为准**（按钮禁用态、投递回执、系统卡片），不靠文本猜。已确认的标记记在 AGENTS.md §9。
- **日志脱敏**：只记数量、状态、长度，不记消息正文、简历文件名、联系方式。
- 开发规范、版本与发布流程见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

技术栈：Vue 3 + TypeScript + Vite + vite-plugin-monkey，测试用 Vitest（jsdom）。
