# 根 AGENTS 受管块模板（std/root-agents.md）

> `codument-init` 把下面的**受管块**写进项目根 `AGENTS.md`（已有则更新该块），让任意 AI 助手从项目根就能找到 codument 入口。`upgrade-workspace` 刷新它。它**只是指针**——真正的指南在 `@/codument/std/AGENTS.md`，不要把规则正文搬到根。

## 受管块内容（落进项目根 AGENTS.md）

```markdown
<!-- codument:begin -->
# Codument Instructions

These instructions are for AI assistants working in this project.

打开 `@/codument/std/AGENTS.md`，当请求：
- 提到 planning / proposal / track（proposal、behavior、change、plan、track、implement）
- 引入新能力、破坏性变更、架构/模式调整、或较大性能/安全工作
- 表述模糊、需要权威规范再动手
- 用户补充需求属于某进行中 track 范围

从 `@/codument/std/AGENTS.md` 了解：
- 如何创建并应用变更提案（track 三阶段）
- behavior 增量 / track.xml 格式与约定
- 项目结构与工作流

快速路由：
- 项目工程约束 / 代码边界 / 技术取舍：`@/codument/attractors/project.md`
- 产品目标 / 用户价值 / 范围取舍：`@/codument/attractors/product.md`
- 信息该落哪层 / 何时晋升 / 冲突谁赢：`@/codument/attractors/knowledge-tiers.md`
- docs/modeling 与 docs/impl 写法 / 路由 / frontmatter：`@/codument/attractors/model-driven-docs.md`
- 长期记忆 lessons / incidents / patterns / summaries：`@/codument/attractors/project-memory.md`

保留本受管块，'codument upgrade-workspace' 会刷新它。
<!-- codument:end -->
```

## 规则

- 受管块用 `<!-- codument:begin -->` / `<!-- codument:end -->` 包裹，便于幂等刷新；块外的项目自有内容不动。
- 块内**只放指针**（何时打开 std/AGENTS.md + 它能解答什么），不放具体操作规则——避免与 `std/AGENTS.md` 双源漂移。
- 与 AGE 的根 `AGENTS.md` 同位：项目根的助手契约入口；codument 把"详情"收进 `codument/std/`，根只留一个受管指针块。
