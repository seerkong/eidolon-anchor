# 变更：Add Eidolon Workflow CLI Authoring Commands

## 背景和动机 (Context And Why)

Eidolon 已有 workflow native component 和对话 tools。下一步需要把同一能力投影到 human-facing CLI，让用户可以直接运行 `eidolon workflow ...` 创建、检查、校验 workflow bundle。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**

- 增加 `eidolon workflow` 命令族的第一阶段实现：`init`、`inspect`、`validate`。
- CLI 复用 `@cell/ai-organ-logic/workflow` 的 workflow component/service。
- `workflow init` 将 component 返回的 bundle draft 写入 `.eidolon` target root。
- headless exec runtime metadata 注入 `aiWorkflow.roots`。

**非目标:**

- 不实现 MCP。
- 不实现 runtime `run/status/events/result/resume`。
- 不实现 actor-backed `workflow create/edit` repair loop；后续 track 继续。

## 变更内容（What Changes）

- 新增 `terminal/packages/cli/src/commands/workflow.ts`。
- 在 terminal CLI 与 headless CLI 入口注册 `workflow` 命令。
- 更新 terminal runtime metadata builder 注入 workflow roots。
- 增加 CLI command unit/smoke 测试。

## 影响范围（Impact）

- 受影响的能力（behaviors）：`eidolon.workflow-cli`
- 受影响的代码：
  - `terminal/packages/cli/src/commands/workflow.ts`
  - `terminal/packages/cli/src/headless-main.ts`
  - `terminal/packages/cli/src/index.ts`
  - `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts`
