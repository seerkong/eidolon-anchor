# 变更：AIAgent TaskTree 工具链重命名与规范化补建

## 背景和动机 (Context And Why)
本次 TaskTree 相关能力已经在代码中完成了关键改动，但尚未在 Codument 中形成完整的变更追踪。为保证后续可审计、可验证、可归档，需要将这批改动补建为标准 track，并明确命名迁移、工具契约与验证边界。

## “要做”和“不做” (Goals / Non-Goals)
**目标:**
- 将 TaskTree 相关既有改动补建为完整 Codument track（spec/proposal/design/plan）。
- 明确工具命名迁移策略：`TodoWrite` → `TaskTreeWrite`、`RunSubTask` → `RunSubAgent`。
- 明确 `TaskTreeRead` 的输出契约为完整 TaskTree JSON（含 `root` 与 `nextId`）。
- 固化 `ToolDefinitions` 去重策略，确保工具 schema 以 tool-dir 定义为单一来源。
- 在 terminal 侧完成 minimal 可用对齐（不扩展到完整 TUI 体验重构）。

**非目标:**
- 不新增 TaskTree 之外的业务能力或新工具族。
- 不改造 vfs 示例模板与脚本。
- 不进行完整 TUI 体验重构（仅保证 minimal 与基础映射可用）。

## 变更内容（What Changes）
- 将 TaskTree 工具链相关改动以 Codument 标准文件落地，形成可追踪变更。
- 统一子代理工具命名为 `RunSubAgent`，并以新名作为标准入口。
- 增加并固化 `TaskTreeRead` 工具，用于返回完整任务树结构 JSON。
- 将 `ToolDefinitions` 改为基于 builtin tool defs 组装，移除重复手写 schema。
- 对 terminal minimal 提示词和工具映射进行命名对齐（`TaskTreeWrite`、`TaskTreeRead`、`RunSubAgent`）。

## 影响范围（Impact）
- 受影响的功能规范：
  - AIAgent 任务树写入工具规范（TaskTreeWrite）
  - AIAgent 任务树读取工具规范（TaskTreeRead）
  - 子代理工具命名规范（RunSubAgent）
  - 工具 schema 来源规范（ToolDefinitions 去重）
  - terminal minimal 工具提示与映射规范
