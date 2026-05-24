# Design: add-tui-research-tool-cards

## 目标

让新的 prototype-first TUI 在不破坏 coding 主链的前提下，正式启用 `webfetch`、`codesearch`、`websearch` 三类 research tool cards。

## 当前现状

### 1. research cards 已存在，但路由没有启用它们

- `terminal/packages/tui/src/cli/cmd/tui/prototype/features/message/materials/tool-cards.tsx`
  - 已存在 `WebFetchCard`、`CodeSearchCard`、`WebSearchCard`
  - registry 也已经注册了 `webfetch`、`codesearch`、`websearch`
- `terminal/packages/tui/src/cli/cmd/tui/prototype/features/message/cards.tsx`
  - runtime `ToolPart` 已经通过 `RuntimeToolCard` 走 `resolvePrototypeToolCard(...)`
- `terminal/packages/tui/src/cli/cmd/tui/prototype/features/message/materials/tool-registry.ts`
  - 当前 `resolvePrototypeToolCard(...)` 只放行 `CODING_TOOL_CARD_ALLOWLIST`
  - `webfetch`、`codesearch`、`websearch` 会被直接降级为 `GenericTool`

结论：research cards 的缺口不在卡片实现，而在渲染路由策略。

### 2. structured tool part 主链已经存在

- `terminal/packages/tui/src/cli/cmd/tui/prototype/data.ts`
  - assistant text 与 runtime `ToolPart` 已能共同投影到平铺 timeline
- `terminal/packages/tui/src/cli/cmd/tui/prototype/features/message/cards.tsx`
  - `source = "runtime-part"` 的工具项已走动态组件渲染

结论：本 track 不需要重做 projection，应该严格复用现有 structured tool part 主链。

### 3. 现有测试仍把 research cards 视为 fallback

- `terminal/packages/tui/tests/message-card-compatibility.test.ts`
  - 当前断言 `resolvePrototypeToolCard("webfetch") === GenericTool`

结论：实现本 track 时，测试也需要同步从“research 走 fallback”切换为“research 走 dedicated card”。

## 约束

- 本 track 默认建立在 `add-tui-coding-tool-part-cards` 已完成的前提上
- 本 track 不能回退或重做 coding tool card 主链
- research cards 的优先级次于 coding 主链，不应让消息区路由重新走向“大杂烩 allowlist”
- unsupported tools 仍需保留 generic fallback

## 目标方案

### 1. 在路由层明确 research allowlist

建议不要把 research tools 混写进 `CODING_TOOL_CARD_ALLOWLIST`，而是改成更清晰的路由结构，例如：

- `CODING_TOOL_CARD_ALLOWLIST`
- `RESEARCH_TOOL_CARD_ALLOWLIST`
- 或统一的 `DEDICATED_TOOL_CARD_ALLOWLIST`

关键要求：

- coding 与 research 的边界在命名上清晰可见
- research tools 启用 dedicated card 时，不会模糊“coding 主链优先”的设计意图

### 2. research cards 继续复用 GenericTool 的 fallback 语义

行为规则应为：

- 命中 coding allowlist -> dedicated coding card
- 命中 research allowlist -> dedicated research card
- 其他工具 -> `GenericTool`

这样后续若继续接 `task`、`question` 等卡片，也能按类别增量扩展，而不是反复重写判断逻辑。

### 3. 不额外发明 research 专用投影 schema

当前 research cards 已可直接从 runtime `ToolPart` 读取：

- `webfetch` 读取 `input.url`
- `codesearch` 读取 `input.query` 和 `metadata.results`
- `websearch` 读取 `input.query` 和 `metadata.numResults`

因此本 track 应尽量只调整路由与测试，不应平白引入新的中间 view model。

## 实施分解

### Phase 1: 冻结 research 路由边界

- 明确 research tools 的范围
- 明确与 coding allowlist、generic fallback 的关系
- 明确当前测试中哪些断言需要反转

### Phase 2: 接入 research dedicated cards

- 修改 tool registry 路由逻辑
- 确保 `webfetch`、`codesearch`、`websearch` 命中各自专用卡片
- 不改变 runtime projection 主链

### Phase 3: 验证

- 更新兼容性测试
- 验证 unsupported tools 仍走 `GenericTool`
- 验证 coding cards 未被回归破坏

## 测试策略

至少覆盖以下场景：

1. `resolvePrototypeToolCard("webfetch")`、`resolvePrototypeToolCard("codesearch")`、`resolvePrototypeToolCard("websearch")` 命中专用卡片
2. `edit`、`write`、`patch` 等 coding cards 仍命中原 dedicated card
3. 未覆盖工具仍命中 `GenericTool`
4. runtime `ToolPart` 投影链不需要为 research cards 引入额外 schema 才能工作

详细的自动化与手工功能验收步骤见 `acceptance.md`。

## 风险与取舍

### 风险 1: 路由命名不清，后续继续扩卡时又混在一起

应对方式：

- 在 registry 中明确分类命名
- 在测试里显式覆盖 coding / research / fallback 三类分支

### 风险 2: 研究型卡片接入后破坏 coding cards 的既有断言

应对方式：

- 保留 coding card 的既有测试
- 将 research card 的新增测试与 coding card 的旧断言并列校验

## 交付结果

本 track 完成后，新的 prototype TUI 应具备以下能力：

- `webfetch`、`codesearch`、`websearch` 在真实 session 中显示为专用 research cards
- research cards 与 coding cards 共用同一条 runtime `ToolPart` 主链
- unsupported tools 继续走 generic fallback
