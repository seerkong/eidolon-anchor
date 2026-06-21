# 设计：runtime manager/event 收口

## 范围

本轮只处理两个还在承担真实行为的旧名面：

1. `OrganizationManager` 旧 helper 仍承载真实实现
2. autonomous holon claim / idle-exit event 仍使用 `Collective*` 命名和文案

## 方案

### 1. OrganizationManager

- 引入 private holon-first helper
- `createHolon/addHolonMember/setHolonWatchState/appointHolonLeader` 直接调用这些 helper
- `createCollective/createFormation/...` 继续存在，但只做窄包装

### 2. Runtime Event

- 新增 autonomous holon event payload type
- `AgentEventGraph` 增加 holon-first event API
- `emitCollectiveClaim` / `emitCollectiveIdleExit` 保留为 alias
- `AutonomousHolonTaskRunner` 与 `AiAgentExecutor` 切到新 API
- orchestration history 的 `stream/kind` 一并切到 autonomous-holon wording

## 风险

- runtime event 文案和 payload kind 变更会影响 focused tests
- manager helper 重构如果回写 index 的分支有遗漏，会影响 holon/member 管理路径

## 验证

- `organization_tools.test.ts`
- `collective_runner_claim_idle_work.test.ts`
- `orchestration_history_integration.test.ts`
- `stream/agent_event_graph.test.ts`
- `codument validate refactor-aiagent-holon-runtime-event-and-manager-aliases --strict`
