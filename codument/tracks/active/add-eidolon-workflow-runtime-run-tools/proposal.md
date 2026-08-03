# 变更：Add Eidolon Workflow Runtime Run Tools

## 背景和动机 (Context And Why)

Workflow authoring 已经进入 native component/tool 和 CLI surface。下一步需要让对话内 AI 能通过 workflow tools 发起 run 并观察 status/events/result/resume。该运行能力必须复用 Eidolon 已有 actor/session/runtime-control facts，而不是新建 workflow runtime store。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**

- 增加 `WorkflowRun`、`WorkflowStatus`、`WorkflowEvents`、`WorkflowResult`、`WorkflowResume` native tools。
- `WorkflowRun` 使用现有 delegate/detached actor infrastructure 发起 AI agent task。
- status/events/result/resume 读取现有 detached actor registry / observability facts。

**非目标:**

- 不实现 CLI run/status/events/result/resume。
- 不实现 full DAG scheduler。
- 不创建 workflow-specific session/effect persistence。

## 变更内容（What Changes）

- 扩展 `cell/packages/ai-organ-logic/src/workflow/tools/`。
- 扩展 workflow native tool tests。

## 影响范围（Impact）

- `cell/packages/ai-organ-logic/src/workflow/tools/`
- `cell/packages/ai-organ-logic/tests/workflow/native_workflow_tools.test.ts`
