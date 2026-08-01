# 变更：迁移 unified data-graph observability computed callbacks

## 背景和动机 (Context And Why)

`depa-data-graph-core@1.0.1` 将 computed callback 的读取入口迁移为 runtime 的
`graph`。当前 Cell 与 terminal organ 的诊断摘要仍调用 `ctx.get(...)`；terminal
focused observability suite 因此有 4 个失败。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**
- 迁移 Cell 与 terminal organ DiagnosticSubgraph 的 computed summary。
- 迁移 terminal observability 测试中的旧 callback 用法。
- 用 focused tests 证明 summary、middleware、trace 和 disposal 行为保持可用。

**非目标:**
- 不在本 track 改 terminal TUI 的 projection graph；它保留给 mission G7。
- 不改变 diagnostic event schema、统计口径或 persist 格式。
- 不重构与 unified runtime contract 无关的 observability 组件。

## 变更内容（What Changes）

- **BREAKING compatibility repair:** 将 `ctx.get(...)` 迁移为
  `runtime.graph.get(...)`，适配 unified computed-node callback contract。
- 增加 source-level boundary regression，防止旧 callback API 回归。
- 修复现有 terminal observability 测试自身的旧 API 用法，并验证全套受影响
  Cell/terminal observability tests。

## 影响范围（Impact）

- 受影响的能力（behaviors）：`vendor-data-graph-observability`
- 受影响的代码：Cell 与 terminal organ 的 `DiagnosticSubgraph`，terminal
  observability computed-node tests。
