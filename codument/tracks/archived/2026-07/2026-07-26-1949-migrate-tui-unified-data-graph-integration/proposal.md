# 变更：迁移 TUI unified data-graph projection runtime

## 背景和动机 (Context And Why)

TuiA1StateGraph retains 16 obsolete `ctx.get` computed callbacks after the
1.0.1 upgrade. Its graph projections must use the same runtime contract as
Cell and terminal organ.

## "要做"和"不做" (Goals / Non-Goals)

**目标:** 迁移 TuiA1StateGraph callbacks，并验证 focused TUI graph/integration 行为。

**非目标:** 不改变 TUI reducer、projection dependency arrays、UI layout 或其它 graph owners。

## 变更内容（What Changes）

- 将 TUI computed callbacks 改为 `runtime.graph.get`。
- 增加 source boundary，复跑 TUI projection and integration tests。

## 影响范围（Impact）

- 受影响的能力：`vendor-data-graph-tui-projection`
- 受影响的代码：`terminal/packages/tui/src/app/tui_a1/graph.ts` 及 focused tests。
