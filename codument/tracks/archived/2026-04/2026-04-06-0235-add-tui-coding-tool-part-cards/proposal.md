# 变更：接入 TUI coding 工具专用消息卡片

## 背景和动机

当前 prototype TUI 已经沉淀出一批旧 shell 迁出的结构化工具卡片，但新的消息主链仍停留在“assistant 文本卡 + 简化 tool 摘要卡”的层级。结果是：

- runtime 已经提供的 `ToolPart` 结构化信息没有被保留下来
- `edit`/`write`/`bash` 等卡片已经存在，却没有接到 prototype 的真实渲染路径
- 用户在新 TUI 中看不到 diff、diagnostics、命令输出折叠、路径语义等高价值信息

这个 track 的目标不是继续维护旧 shell，而是把已经沉淀下来的 coding 工具卡片真正接入新的 prototype-first TUI。

## “要做”和“不做”

**目标:**

- 打通 runtime `message.part.updated` 到 prototype 消息区的 structured tool part 渲染链路
- 在新的 TUI 中优先启用 coding 工具专用卡片：`bash`、`edit`、`write`、`read`、`grep`、`glob`、`list`、`patch`
- 保留 generic fallback card，确保未覆盖工具仍然可见
- 让这个 track 的文档足够自包含，新的 session 可以直接按 `plan.xml` 执行

**非目标:**

- 本 track 不负责把所有旧 TUI 消息卡片一次性全部接入 prototype
- 本 track 不重建旧的 route/session shell
- 本 track 不处理 theme、provider、agent、MCP、status 等系统素材的接入
- 本 track 不在第一阶段处理 `task`、`question`、`websearch`、`webfetch` 等非 coding 工具卡片

## 变更内容

- 定义 prototype 渲染链路中的 structured coding tool part 视图模型
- 重构 graph/projection，使 runtime `ToolPart` 不再在投影过程中丢失
- 将消息区渲染主链接到 `TOOL_CARD_REGISTRY`
- 对非首批工具保留 generic fallback
- 为 projection、renderer 选择和 fallback 行为补齐测试

## 影响范围

- 受影响的功能规范：`terminal-tui-shell`
- 受影响的代码：
  - `terminal/packages/tui/src/cli/cmd/tui/prototype/data.ts`
  - `terminal/packages/tui/src/cli/cmd/tui/prototype/graph.ts`
  - `terminal/packages/tui/src/cli/cmd/tui/prototype/features/message/cards.tsx`
  - `terminal/packages/tui/src/cli/cmd/tui/prototype/features/message/materials/tool-cards.tsx`
  - `terminal/packages/tui/tests/message-card-compatibility.test.ts`

## 顺序依赖关系

- 建议序号：`1`
- 建议前置：无，这是当前这批 TUI tracks 的基础消息主链工作
- 建议后续：
  - `add-tui-input-and-material-state-foundations`
  - `enhance-tui-approval-and-delegation-history`
  - `add-tui-system-management-surfaces`
  - `add-tui-research-tool-cards`
- 说明：后续凡是要复用结构化消息区素材的 track，都应默认建立在本 track 完成之后
