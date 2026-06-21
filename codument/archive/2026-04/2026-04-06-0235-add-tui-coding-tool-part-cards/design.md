# Design: add-tui-coding-tool-part-cards

## 目标

让新的 prototype-first TUI 直接消费 runtime `ToolPart`，优先启用 coding 工具专用卡片，并保持对未知工具的可见 fallback。

## 当前现状

### 1. runtime part 已被 graph 保存，但没有进入最终渲染链

- `terminal/packages/tui/src/cli/cmd/tui/prototype/graph.ts`
  - `runtime-part-updated` 会把 `Part[]` 写入 `runtimeParts`
  - `applyRuntimeProjection()` 最终调用 `runtimeMessagesToPrototypeMessages(...)`
- `terminal/packages/tui/src/cli/cmd/tui/prototype/data.ts`
  - `runtimeMessagesToPrototypeMessages(...)` 目前只输出 user / assistant 文本消息
  - `PrototypeMessage.kind = "tool"` 仅是原型示例里的摘要卡形态，不承载真实 runtime `ToolPart`

结论：graph 层保存了 runtime part，但投影层把结构化工具语义丢掉了。

### 2. 结构化工具卡片库存已经存在，但主消息区没有使用

- `terminal/packages/tui/src/cli/cmd/tui/prototype/features/message/materials/tool-cards.tsx`
  - 已存在 `bash`、`edit`、`write`、`read`、`grep`、`glob`、`list`、`patch` 等卡片
  - registry 还包含 `task`、`question`、`websearch`、`webfetch` 等非首批能力
- `terminal/packages/tui/src/cli/cmd/tui/prototype/features/message/materials/tool-chrome.tsx`
  - `ToolCardProps` 已经与 runtime `ToolPart` 足够接近：`tool`、`input`、`metadata`、`output`、`part`
- `terminal/packages/tui/src/cli/cmd/tui/prototype/features/message/cards.tsx`
  - 当前仍渲染一个本地 `ToolCard` 摘要组件
  - 没有接入 `TOOL_CARD_REGISTRY`

结论：卡片资产已经具备，缺口在投影和渲染路由。

### 3. 已有测试只证明“卡片库存存在”，没有证明“新 TUI 正在使用它们”

- `terminal/packages/tui/tests/message-card-compatibility.test.ts`
  - 当前校验 registry 里有 dedicated card
  - 但没有覆盖 runtime part 投影、首批工具 allowlist、fallback 路由

## 约束

- 旧 shell 已经退出长期维护范围，本 track 只服务新的 prototype 入口
- 当前项目已采用 `depa-data-graph` 作为 prototype 状态组织方式，本 track 必须沿用现有 graph 投影主链
- 第一阶段只接 coding 工具卡片：
  - `bash`
  - `edit`
  - `write`
  - `read`
  - `grep`
  - `glob`
  - `list`
  - `patch`
- `task`、`question`、`websearch`、`webfetch` 等卡片虽然已沉淀，但不属于本 track 的首批交付范围

## 目标方案

### 1. 把 prototype 的渲染输入从“按 message 聚合”调整为“按 timeline item 投影”

当前 `PrototypeMessage[]` 的问题是：一个 runtime message 最终只能生成一张卡，无法表达 assistant 文本与多个 tool parts 共存的情况。

建议在本 track 中引入一个更准确的扁平渲染模型，例如：

- user item
- assistant text item
- tool part item

关键要求：

- 保留每个 `ToolPart` 的稳定 `part.id`
- 在同一条 assistant message 内按 part 顺序投影
- 相邻 displayable text part 可以合并成一条 assistant 文本 item
- tool part 则一律单独成为 timeline item

这样后续 renderer 不需要再猜测 message 内部结构。

### 2. tool item 尽量直接复用 runtime `ToolPart` 数据形状

现有 `ToolCardProps` 已基本匹配 runtime 数据：

- `tool` <- `part.tool`
- `input` <- `part.state.input ?? {}`
- `output` <- `part.state.output`
- `metadata` <- `part.state.metadata ?? {}`
- `part` <- 原始 `ToolPart`

因此不建议为本 track 再发明一套重型中间 schema。更合适的做法是：

- 在投影层构造轻量 tool item
- renderer 中把该 item 直接适配到 `ToolCardProps`

这样可以减少重复转换，并保留 `pending/completed/error` 的原始状态信息。

### 3. 采用 coding allowlist，而不是一次性开放全部 registry

虽然 `TOOL_CARD_REGISTRY` 已含更多工具卡片，但本 track 只对 coding 工具开放 dedicated path。

建议在渲染路由里显式维护首批 allowlist：

- `bash`
- `edit`
- `write`
- `read`
- `grep`
- `glob`
- `list`
- `patch`

行为约束：

- 命中 allowlist 且 registry 中存在实现 -> 使用 dedicated card
- 未命中 allowlist 或未注册 -> 使用 `GenericTool`

这样可以把风险收敛在 coding 主链，避免把 `task` / `question` 之类更依赖上下文的卡片提前带入。

### 4. 保留 generic fallback，作为新旧能力边界的安全阀

本 track 的成功标准不是“所有工具都有专用卡片”，而是：

- 已选 coding 工具升级为结构化专用卡片
- 未覆盖工具仍然可见
- 不因为接入 registry 而让未知工具消失

因此 fallback 不是过渡垃圾，而是正式边界的一部分。

## 实施分解

### Phase 1: 冻结投影边界

- 明确从 runtime message + part 到 render item 的映射规则
- 明确首批工具 allowlist
- 明确 assistant 文本与 tool part 的顺序规则

### Phase 2: 实现 graph / projection 改造

- 保持 `runtimeMessages` / `runtimeParts` 作为 graph 内真相来源
- 将 `runtimeMessagesToPrototypeMessages(...)` 演进为“生成 timeline items”的投影函数
- 让同一个 tool call 在多次 part update 下保持稳定 item identity

### Phase 3: 接入 renderer

- 将消息区从摘要 `ToolCard` 改为 registry 路由
- 对首批工具调用 dedicated card
- 对其他工具继续 fallback 到 `GenericTool`

### Phase 4: 验证

- 为投影层补测试
- 为 renderer 选择 dedicated/fallback 的路由补测试
- 运行 terminal TUI 相关测试

## 测试策略

至少覆盖以下场景：

1. assistant message 同时包含文本和多个 coding tool parts 时，timeline item 顺序正确
2. `edit` / `write` / `bash` 等首批工具命中 dedicated card
3. 未覆盖工具仍走 `GenericTool`
4. 同一 `ToolPart` 多次更新时，卡片 identity 不漂移，状态可从 pending 变为 completed 或 error

详细的自动化与手工功能验收步骤见 `acceptance.md`。

## 风险与取舍

### 风险 1: 某些卡片仍依赖 prototype 上下文

例如 `tool-chrome.tsx` 和部分 card 会读取 `useSync()`、`useSessionContext()`、`useRoute()`、`useLocal()`。

应对方式：

- 本 track 只启用 coding 工具卡片
- 若某张卡片仍依赖旧上下文能力，应在 prototype 内补最小兼容层，而不是回退到旧 shell

### 风险 2: part 顺序和文本合并策略处理不当，会影响消息阅读体验

应对方式：

- 先在测试中固定“文本合并 + tool 独立 item + 原始 part 顺序”的规则
- 先保证可解释性，再考虑更激进的视觉压缩

## 交付结果

本 track 完成后，新的 prototype TUI 应具备以下能力：

- 真实 runtime coding 工具调用不再退化为摘要卡
- 首批 coding 工具卡片可直接用于新的 session
- 未来新增其他类型 tool cards 时，只需扩 allowlist 与对应测试，而不需要再次重做投影主链
