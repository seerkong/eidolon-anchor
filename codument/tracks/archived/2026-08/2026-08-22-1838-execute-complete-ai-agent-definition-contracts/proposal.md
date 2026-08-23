# Proposal：在 Eidolon 通用 actor runtime 中完整执行 AIAgentDefinition

## 背景

`execute-ai-agent-resources-through-eidolon-runtime` 已完成第一版 bridge：Eidolon 从同一 Halfcode effective registry 取得 depa `AIAgentDefinition` projection，解析 Prompt 与 exact Tool refs，冻结 run-resource receipt，并通过已有 `spawnChildExecutionActor` 执行。该 track 刻意拒绝 schema 与 effect policy，Material 只冻结 identity，因而是 fail-closed 的第一可执行 profile，不是完整产品能力。

depa-flows 的后继 `complete-ai-agent-definition-executable-contracts` 已把 `MessageSchema.schema`、`EffectPolicy.toolMode` 与 `Material.value` 投影成 closed、deeply immutable domain facts，并让同一 task tuple 覆盖 `AICtrlWorkflow` 与 `AIDataWorkflow`。本 track 负责在 host 中执行这些语义。

## 目标

- 精确消费已发布的 `ai-workflow-contract@0.1.3`、`ai-workflow-logic@0.1.3` 与 `ai-workflow-flow-dsl-reference@0.1.1`，不使用 source/file substitute。
- 把 schema、effect policy、payload 与 ordered Material values 投影为通用、可持久化的 `AgentExecutionContract`，由现有 actor、Conversation Domain、tool registry 与 snapshot 机制执行。
- provider call 前验证资源消息、workflow payload 与每个 Material value；child result写入父actor/result fact前验证output schema。
- `declared-only` 只暴露 exact `ToolRefs[]`；`none` 不暴露工具，且与非空 ToolRefs 冲突时 fail closed。
- Ctrl 的普通 `Run` node 与 Data 的普通 `TransformNode` 通过同一个 `ai.agent` effect 使用同一 Agent definition，不新增 substrate `AIAgentTask` node。
- frozen execution fact/restart/retry 复用已持久化 schema、policy、payload、Material values 与 receipt，不重读 mutable live package。

## 非目标

- 不在 Eidolon 重写 ResourcePackage、Catalog、KindDefinition、layer、dependency closure 或 AI resource projector；这些分别由 Halfcode 与 depa-flows拥有。
- 不创建 workflow-specific actor、session、history、compactor、provider loop 或 JSON Schema dialect。
- 不根据 Agent/Tool/Port/Material 名称、description、自然语言、正则、substring、alias 或有序规则选择语义。
- 不新增 `AIAgentTask` DSL node；task 仍是 workflowKind/workflowRef/nodeId/agentDefinitionRef 四元组。
- 不自动发布/编辑 ResourcePackage；只执行已被 registry admission 的 exact resources。

## 兼容与影响

没有 schema、policy 或 Material port 的旧 Agent 继续按 existing exact-tool profile执行。legacy `vfs://` workflow 的 `agentType`路径保持；resource workflow不回退到legacy agentType或code Agent。

变更覆盖 `@cell/ai-core-contract` 的 generic contract/actor state、`@cell/ai-organ-logic` 的 validator/resource plan/delegate completion、workflow effect/fact store、system Skills 1.0.x 内容与 Ctrl/Data E2E。npm发布、npmrc与registry选择不属于本 track。
