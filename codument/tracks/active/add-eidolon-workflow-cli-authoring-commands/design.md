## 上下文

本 track 是 mission G3：CLI 是 workflow component 的 human-facing surface，不拥有 workflow core logic。

## 方案概览

1. CLI command module
   - `workflow init <form> <name>`：调用 component create bundle draft，并写入 target root。
   - `workflow inspect`：输出 component capability inspection。
   - `workflow validate <ref>`：输出 component resource-ref validation。
2. Runtime metadata root injection
   - 在 terminal runtime metadata normalization 中加入 `aiWorkflow.roots`。
   - 默认 workspace root 为当前工作区 `.eidolon/workflows`。
   - 默认 global root 为 runtime authority root 下的 `workflows`。
3. 测试
   - command handler dependency injection 单测。
   - metadata builder 单测或现有 workflow bootstrap smoke。

## 影响范围与修改点（Impact）

- `terminal/packages/cli/src/commands/workflow.ts`
- `terminal/packages/cli/src/headless-main.ts`
- `terminal/packages/cli/src/index.ts`
- `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts`

## 决策摘要

- CLI write adapter 可以物理写入文件，但必须写入 component 返回的 controlled draft。
- `create/edit` 的 AI actor-backed repair loop 不在本 track 实现。

## 风险 / 权衡

- 风险：`validate <path>` 被误解为允许 host path resource ref。
  - 缓解：第一阶段 validate 主要验证 resource refs；host absolute path 返回拒绝。
