# 变更：接入 TUI research 工具卡片

## 背景和动机

prototype TUI 已经打通了 runtime `ToolPart` 到结构化卡片的主链，但当前只对 coding 工具开放 dedicated rendering。`webfetch`、`codesearch`、`websearch` 这些 research 卡片虽然已经在 registry 中存在，实现也基本可用，但路由层仍把它们降级为 `GenericTool`。

这会带来两个直接问题：

- 研究型会话里，用户看不到 URL、query、结果数量等 research 语义
- research 工具虽然已有素材，但没有真正进入新的 prototype-first TUI 能力面

本 track 的目标是复用已经建立好的 structured tool part 主链，把 research 类卡片正式接入新的消息区。

## “要做”和“不做”

**目标:**

- 将 `webfetch`、`codesearch`、`websearch` 纳入 prototype 的 dedicated tool card 路由
- 让 research 工具调用在新 TUI 中展示 URL、query、结果计数等关键语义
- 保持与 coding 主链共用同一条 runtime `ToolPart` 投影链
- 保证 coding 工具卡片的优先级和表现不被 research 卡片接入破坏

**非目标:**

- 本 track 不重做 runtime `ToolPart` 投影主链
- 本 track 不一次性接入 `task`、`question`、`tasktreewrite`、`tasktreeread`
- 本 track 不处理 provider/model、agent/MCP、session switcher、command palette 等 system surface
- 本 track 不以 research 卡片为由修改 coding tool card 的视觉语言

## 变更内容

- 将 `webfetch`、`codesearch`、`websearch` 从 generic fallback 提升为 dedicated card
- 为 research tools 定义独立 allowlist 或等价路由规则
- 更新消息区工具路由测试，确保 research cards 被真正启用
- 保持 unsupported tools 继续走 generic fallback

## 影响范围

- 受影响的规范：`terminal-tui-shell`
- 受影响的代码：
  - `terminal/packages/tui/src/cli/cmd/tui/prototype/features/message/materials/tool-registry.ts`
  - `terminal/packages/tui/src/cli/cmd/tui/prototype/features/message/materials/tool-cards.tsx`
  - `terminal/packages/tui/src/cli/cmd/tui/prototype/features/message/cards.tsx`
  - `terminal/packages/tui/tests/message-card-compatibility.test.ts`

## 顺序依赖关系

- 建议序号：`10`
- 建议前置：
  - `add-tui-coding-tool-part-cards`
  - `add-tui-input-and-material-state-foundations`
- 建议后续：
  - `polish-tui-status-and-guidance-surface`
- 说明：research cards 最好复用 coding tool cards 已经打通的消息投影主链，而不是另起一套特殊逻辑
