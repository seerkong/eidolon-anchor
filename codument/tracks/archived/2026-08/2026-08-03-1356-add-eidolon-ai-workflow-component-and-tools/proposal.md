# 变更：Add Eidolon AI Workflow Component And Tools

## 背景和动机 (Context And Why)

Eidolon 已有 AI workflow contract 和两个基础 native tools，但工具逻辑仍直接调用 contract helper，没有统一的 workflow component/service 承载 command/query。接下来 CLI 和对话 tools 都要复用同一能力；如果先不建立 component，后续 CLI 很容易成为第二套 workflow core。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**

- 新增 workflow component/service 层，提供 inspect、validate resource ref、create bundle draft、patch bundle draft 等 command/query。
- 将现有 `WorkflowInspectCapability`、`WorkflowValidateResourceRef` 改为调用共享 service。
- 新增对话内 authoring tools：`WorkflowCreateBundle`、`WorkflowPatchBundle`。
- 增加测试，证明 native tools 与 service 共用同一边界，并验证 unsafe resource ref 被拒绝。

**非目标:**

- 不实现 `eidolon workflow` CLI；CLI 留给后续 mission track。
- 不实现 workflow run/status/events/result/resume；运行接入留给后续 mission track。
- 不新增 MCP surface。
- 不引入第二套 workflow workspace 设计。

## 变更内容（What Changes）

- 在 `cell/packages/ai-organ-logic/src/workflow/component/` 下建立 component/service。
- 扩展 `cell/packages/ai-organ-logic/src/workflow/tools/` 下的 native workflow tools。
- 保持 `cell/packages/ai-organ-logic/src/composer/AIAgent/ToolFuncBuiltin.ts` 仍通过 workflow tools index 注册工具。
- 增加或更新 workflow tool/contract tests。

## 影响范围（Impact）

- 受影响的能力（behaviors）：`eidolon.ai-workflow-native-component`
- 受影响的代码：
  - `cell/packages/ai-organ-logic/src/workflow/`
  - `cell/packages/ai-workflow-contract/`
  - `cell/packages/mod-ai-kernel/tests/`
