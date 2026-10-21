# 开发规范

本插件是独立 Git 仓库（主仓 `agent-agent-hr` 以子模块引用），有自己的分支、CI、版本号和 Release。
工具层规范见 [AGENTS.md](./AGENTS.md)，产品形态见 [README](./README.md)。

## 分支

- `main`：稳定主线，只接受验证过的合并。
- 开发分支：从最新 `main` 拉 `codex/YYYY-MM-DD-任务短名`（日期 = 创建当日北京时间，之后不改）。
- 不直接在 `main` 上开发，不从别的 `codex/*` 分支拉新分支（除非依赖其未合并改动）。

## 开发闭环

```bash
npm ci
npm run typecheck && npm test        # 每次改动后
npm run build:local                  # 连本地后端 http://127.0.0.1:8010
```

1. 改代码 → 本地检查通过。
2. 装 `dist/agent-agent-hr-tampermonkey.user.js`，**刷新 BOSS 页面**（已打开的页面不会自动换新脚本）。
3. 用 `npm run tool -- <工具> '<args>'` 在真实页面验证，以 `logs/plugin/` 日志和工具返回值为证据。
4. 页面结构不确定时先用 `probe_dom` / `probe_overlays` / `probe_row` 读真实结构，再改选择器，不要猜。

本地调试时关闭该脚本在 Tampermonkey 里的自动更新，避免生产版本覆盖本地构建。

## 提交

- 一次提交只做一件事，信息写清「改了什么 / 为什么」，修 bug 时写上触发它的实测现象。
- 涉及页面行为的改动，提交前 `package.json` 版本号 +1（`@version` 由构建从这里取）。
- 不提交 `dist/`、`node_modules/`。

## 测试

只为可观察的生产行为加测试：新增/修复的行为、现有用例覆盖不到的失败模式、安全拒绝 / 幂等 / 协议兼容等高风险边界。
不为提高覆盖率而加测试；重构、改名、改日志措辞默认复用现有测试。

页面结构以实测为准：测试里的 DOM fixture 应照 `probe_dom` 读到的真实结构写，并在用例名或注释里注明来源。

## 版本与发布

- 版本号 `0.MINOR.PATCH`：修复 / 小改进 PATCH+1，新增工具 / 协议变化 MINOR+1。
- 发布：合并到 `main` → 打 tag → GitHub Actions（`.github/workflows/build-release.yml`）执行 typecheck、test、生产构建并发布 Release。

```bash
git tag v0.6.56 && git push origin v0.6.56
```

- 生产构建用 `npm run build`（默认后端 `gudaya.chat`）；`build:local` 产物只装在开发浏览器里。
- 用户的 Tampermonkey 按 `@updateURL` + `@version` 自动更新，发布前确认 Release 里有 `.user.js`。
- 插件与后端协议有兼容变化时，在主仓 roadmap（`docs/tampermonkey-plugin-roadmap.md`）记录插件版本窗口。

## 紧急修复

从 `main` 拉 `codex/YYYY-MM-DD-hotfix-问题`，只改该问题，验证后合并并发 PATCH 版本，事后补测试。
