# 开发规范与分支策略

本插件为独立 Git 仓库，有独立的分支、PR、CI、版本号和 Release。与主仓库 `agent-agent-hr` 保持一致的开发约束。

## 分支命名规范

### 主线分支
- `main` — 稳定主线，只接受经过验证的合并请求

### 开发分支
所有功能开发、问题修复必须从 `main` 最新提交拉取新分支，命名格式：

```
codex/YYYY-MM-DD-任务短名
```

- **日期**：创建分支当日的北京时间（格式 `YYYY-MM-DD`）
- **任务短名**：小写英文 + 连字符，简明描述任务

示例：
- `codex/2026-10-18-fix-chat-reconcile` — 修复会话对账逻辑
- `codex/2026-10-18-plugin-version-0.6.20` — 准备 0.6.20 版本发布
- `codex/2026-10-19-improve-boss-selector` — 改进 BOSS 选择器健壮性
- `codex/2026-10-19-scan-retry-bounded` — 添加扫描失败有界重试

**日期表示分支创建日，不随跨日开发、推送或合并改写。**

**禁止**：
- ❌ 直接在 `main` 分支开发
- ❌ 从其他 `codex/*` 分支拉取新分支（除非明确依赖未合并特性）
- ❌ 使用 `feature/`、`fix/` 或省略日期的命名

## 开发流程

### 1. 拉取新分支
```bash
# 先确保本地 main 是最新
git checkout main
git fetch origin main
git reset --hard origin/main

# 创建新分支（日期用当日北京时间）
git checkout -b codex/2026-10-18-your-task-name
```

### 2. 本地开发与测试
- 编写代码
- 运行 `npm run typecheck` 确保类型检查通过
- 运行 `npm test` 确保所有测试通过
- 本地构建验证：`npm run build:local`（连 `127.0.0.1:8010`）

**重要**：开发期间尽量做轻量级验证，避免在生产环境完整回归。可以：
- 单元测试覆盖核心逻辑
- 使用 `diagnose.html` 验证 DOM 选择器
- 使用 `tools/verify-selectors.py` 验证页面适配
- 必要时在测试账号小范围验证关键路径
- **不要**随意在生产环境全量投递验证，除非明确需要且已协调

### 3. 提交规范
**及时 commit，但不急着合并 PR**。开发过程中：

- ✅ 每完成一个小的逻辑单元就提交（修复一个 bug、完成一个函数、通过一组测试）
- ✅ commit 信息清晰说明改动内容，便于后续审查和回滚
- ✅ 在功能分支上积累多个小而可审查的 commit
- ❌ 不要积攒大量改动后才做一个大 commit
- ❌ 不要每提交一次就急着开 PR 合并到 `main`

**为什么要及时 commit？**
- 每个 commit 是一个独立的检查点，出问题时可以精确定位
- 小 commit 容易审查，容易理解改动意图
- 避免丢失工作进度（崩溃、误操作等）
- 便于 `git bisect` 二分查找问题引入点

**为什么不急着合并 PR？**
- 同一交付阶段的多个 commit 一起合并，主线历史更清晰
- 减少 CI 运行次数和主线碎片化
- 给足够时间做完整验证和文档更新
- 避免半成品代码进入主线

提交信息前缀建议：

```bash
git commit -m "fix: 修复会话对账时 key 匹配逻辑"
git commit -m "feat: 新增扫描失败有界重试"
git commit -m "refactor: 统一 boss-chat 中的字段命名"
git commit -m "test: 补充 ledger 幂等性测试"
git commit -m "docs: 更新 0.6.20 roadmap 记录"
git commit -m "chore: 更新依赖到最新稳定版"
```

前缀：
- `feat:` — 新功能
- `fix:` — 问题修复
- `refactor:` — 重构（不改变外部行为）
- `test:` — 测试相关
- `docs:` — 文档更新
- `chore:` — 构建/工具配置

### 4. 积累提交后再合并
**不要每次小改动就提 PR 合并到 main**。推荐工作流：

```bash
# 第一个改动
git add src/boss-chat.ts
git commit -m "fix: 修复聊天框选择器失效"

# 第二个改动
git add src/ledger.ts tests/ledger.test.ts
git commit -m "feat: 添加投递去重的 run_id 关联"

# 第三个改动
git add src/orchestrator.ts
git commit -m "refactor: 统一事件上报的 event_id 生成"

# ... 继续积累 commit

# 达到里程碑后一次性开 PR
git push origin codex/2026-10-18-your-task
# 在 GitHub 创建 PR，描述整批改动
```

**合并时机**：
- 达到一个完整功能里程碑（如"完成 0.6.20 所有改动"）
- 修复了一批相关问题（如"boss-chat 健壮性三处改进"）
- 同一交付阶段只开一个 PR
- 或明确需要尽快发布的紧急修复

**好处**：
- 主线历史更清晰，每个 PR 代表一个完整的交付单元
- 减少 CI 运行次数和主线碎片化
- PR review 更聚焦、更高效
- 避免频繁合并导致的版本混乱

**默认使用 Squash and merge** 压成一个主线提交；确需保留多提交历史时（如迁移、审计、独立回滚），在 PR 中说明原因。

### 5. 合并前检查清单
- [ ] `npm run typecheck` 通过
- [ ] `npm test` 全部通过
- [ ] 版本号已更新（如需发布）
- [ ] [roadmap](docs/tampermonkey-plugin-roadmap.md) 已记录改动内容和验证状态
- [ ] 关键改动有测试覆盖（遵循零净增预算原则）
- [ ] 无调试代码（`console.log` 等）、凭据、敏感数据遗留
- [ ] `dist/` 产物与生产环境配置一致（`apiBase` 指向 `gudaya.chat`）

### 6. 提交 Pull Request
```bash
git push origin codex/2026-10-18-your-task-name
```

然后在 GitHub 创建 PR：
- 标题简明扼要
- 描述包含：改动内容、测试方式、影响范围、未覆盖项
- 关联相关 issue（如有）
- 说明是否需要保留多提交历史

## 版本发布流程

### 版本号规则
采用语义化版本 `0.MINOR.PATCH`：
- `PATCH` +1：问题修复、小改进、不影响 API 契约
- `MINOR` +1：新增功能、API 变更、较大重构

当前处于 0.x 阶段。版本号维护在 `package.json`。

### 独立发布节奏
插件可以在自己的仓库独立做小版本和 Release，便于快速修复浏览器端问题。

主仓库不要为了更新一个子模块指针单独创建发布 PR。插件指针与后端协议、数据库或前端有实际兼容变更时，再随下一批应用发布一起更新，并在发布说明中写明插件版本窗口。

### 发布检查清单
1. [ ] 所有改动已合并到 `main`
2. [ ] `package.json` 版本号已更新
3. [ ] `dist/` 已用**生产配置**重新构建（`npm run build`，`apiBase` 指向 `gudaya.chat`）
4. [ ] [roadmap](docs/tampermonkey-plugin-roadmap.md) 该版本段落已完成，记录了验证状态和未覆盖项
5. [ ] 已在测试环境验证关键路径（选择器、投递、会话托管）
6. [ ] 提交 tag 并推送：
   ```bash
   git tag v0.6.20
   git push origin v0.6.20
   ```
7. [ ] GitHub Actions 自动构建并发布到 Release
8. [ ] 验证 Release 资产完整（`.user.js` 文件存在且可下载）

### 自动更新说明
用户的 Tampermonkey 会根据 `@updateURL` 和 `@version` 自动更新。确保：
- `dist/*.user.js` 中的 `@version` 与 `package.json` 一致
- `@updateURL` 和 `@downloadURL` 指向正确的 Release 地址
- **本地调试时关闭该脚本的自动更新**，避免生产版本覆盖本地构建

## 紧急修复流程

遇到浏览器端严重问题需要紧急修复时：
1. 从 `main` 当前 HEAD 拉取 `codex/YYYY-MM-DD-hotfix-问题描述`
2. 最小化改动，只修复该问题
3. 快速验证后直接提 PR 合并
4. 发布 PATCH 版本
5. roadmap 记录紧急修复原因和影响范围
6. 事后补充测试覆盖（如缺失）

## 测试约束

**零净增预算原则**：不以"顺手补覆盖"或"提高覆盖率"为由新增测试。只有以下情况允许净增：
- 新增或修复了可观察的生产行为
- 现有契约无法覆盖其独立失败模式
- 直接触及安全拒绝、幂等、协议兼容等高风险边界

新增测试前必须先写清：
1. 对应的生产入口
2. 过去或本次可能出现的具体失败模式
3. 已检索过的现有测试及其不足

重构、重命名、注释、类型标注、日志措辞，默认只复用现有测试。

## 工作区清理

如果工作区有未提交改动且不确定要不要保留：
```bash
# 暂存改动
git stash push -m "描述这批改动"

# 查看暂存列表
git stash list

# 需要时恢复
git stash pop
```

不要把未验证的版本号变更、调试构建、临时文件提交到 `main`。

## 分支清理

开发完成且 PR 已合入 `main` 后，应在该阶段收尾时及时删除本地功能分支：
```bash
# 确认 PR 已合并（查看 GitHub PR 状态）
# 删除本地分支
git branch -d codex/2026-10-18-your-task

# 删除远端分支
git push origin --delete codex/2026-10-18-your-task
```

**注意**：
- Squash 合并后 `git branch --merged` **不可靠**，必须核对 PR 实际合并状态
- 清理前确认没有运行中任务依赖该分支
- 记录清理前 SHA 和合并证据以便恢复
- 未合并、证据不足、有本地改动的分支保留并说明原因

下一项开发仍从最新 `main` 新建带日期的分支，不复用已合并分支。

## 常见问题

### Q: 我应该多久 commit 一次？多久合并一次？
**Commit 频率**：每完成一个小的逻辑单元就提交
- 修复一个 bug → commit
- 完成一个函数 → commit
- 通过一组测试 → commit
- 更新一段文档 → commit

**不要**积攒几十个文件、几百行改动后才做一个大 commit。

**PR 合并频率**：达到交付里程碑时合并，不是每个 commit 都合并
- 典型场景：一个功能分支积累 5-15 个 commit，开发 1-3 天后开 PR
- 紧急修复：可以 1-2 个 commit 就开 PR
- 大型重构：可能积累 20+ 个 commit

**实际例子**：
```bash
# 第1天
git commit -m "feat: 添加 nav-unread 模块骨架"
git commit -m "test: 添加 nav-unread 基础测试"
git commit -m "fix: 修复 boss-chat 会话 key 匹配"

# 第2天
git commit -m "feat: 实现 nav-unread 的计数逻辑"
git commit -m "refactor: 抽取 boss-chat 公共方法"
git commit -m "test: 补充边界情况测试"

# 第3天
git commit -m "docs: 更新 roadmap 记录验证状态"
git commit -m "chore: 删除废弃的 probe 文件"

# 现在开 PR，一次性合并这 8 个 commit
git push origin codex/2026-10-18-improve-chat-nav
```

### Q: 如果我已经积攒了很多改动还没 commit，现在怎么办？
先把改动拆分成多个逻辑 commit：

```bash
# 方法1：交互式暂存（推荐）
git add -p  # 逐段选择要提交的改动
git commit -m "fix: 修复选择器失效"

git add -p  # 继续选择下一批改动
git commit -m "feat: 添加去重逻辑"

# 方法2：按文件分批提交
git add src/boss-chat.ts
git commit -m "fix: 修复聊天框选择器"

git add src/ledger.ts tests/ledger.test.ts
git commit -m "feat: 添加投递去重"

git add docs/roadmap.md
git commit -m "docs: 更新验证记录"
```

即使当前已经积攒了改动，也要尽快拆分提交。从下一次开发开始，就按"小步快提交"的节奏。

### Q: 我的分支落后 main 很多提交，怎么办？
```bash
git checkout codex/2026-10-18-your-branch
git fetch origin
git rebase origin/main
# 解决冲突后
git push --force-with-lease origin codex/2026-10-18-your-branch
```

### Q: 多个功能同时开发怎么管理？
每个功能独立分支，不要混在一起：
- 功能 A：`codex/2026-10-18-feature-a`
- 功能 B：`codex/2026-10-19-feature-b`

完成一个合并一个，保持分支简洁。确需依赖未合并分支时，先明确依赖关系和后续集成顺序。

### Q: 我不小心在 main 上改了代码？
```bash
# 如果还没提交
git stash
git checkout -b codex/2026-10-18-fix-xxx
git stash pop

# 如果已经提交但未推送
git reset HEAD~1  # 撤销最后一次提交但保留改动
git checkout -b codex/2026-10-18-fix-xxx
git add .
git commit -m "..."
```

### Q: 本地构建的脚本被生产版本自动更新覆盖了？
这是因为本地构建版本号（如 0.6.20）领先已发布版本（如 0.6.11），Tampermonkey 检测到更高版本号就会自动更新。

**解决方法**：
1. 在 Tampermonkey 管理面板中，找到该脚本
2. 点击"编辑" → "设置"标签
3. 关闭"检查更新"
4. 本地调试期间保持关闭状态
5. 正式发布后再开启

### Q: 版本号已经改到 0.6.19/0.6.20 但还没发布，现在怎么办？
这是工作区积累了未提交改动的情况。建议：
1. 确认这些改动是否已经过验证
2. 如果是调试/实验性改动，用 `git stash` 暂存
3. 回到 `main` 最新状态
4. 从 `main` 拉取新的 `codex/YYYY-MM-DD-*` 分支
5. 将暂存的改动恢复并继续开发

### Q: dist/ 产物指向了 127.0.0.1，能直接提交吗？
**不能**。`dist/` 产物必须用生产配置构建（`npm run build`，`apiBase` 指向 `gudaya.chat`）。

本地调试用 `npm run build:local`，但这个产物**不能提交**到 `main` 或发布到 Release。

### Q: roadmap 文档在哪里？
[docs/tampermonkey-plugin-roadmap.md](docs/tampermonkey-plugin-roadmap.md)

每个阶段完成后必须更新该文档，记录：
- 开始/完成时间
- 负责人
- 状态（完成 / 部分完成 / 阻塞）
- 代码和验证证据
- 未覆盖范围
- 下一阶段入口

"单测通过"不能替代真实页面验证；未验证的部分必须写明。

---

遵循这些规范可以让插件代码库与主仓库保持一致的管理水平，减少合并冲突和版本混乱。

## 与主仓库的协同

- 插件是独立 Git 仓库，主仓库中的 `tampermonkey-plugin/` 是 Git 子模块
- 子模块指针（gitlink）只表示兼容的源码版本，不代表用户已安装该版本
- 插件改动必须在插件仓库完成并通过其 CI
- 不要在主仓库提交子模块内部文件
- 插件指针与后端协议有实际兼容变更时，随主仓库应用发布一起更新 gitlink
- 插件可以独立小版本快速发布，不必等主仓库发布窗口
