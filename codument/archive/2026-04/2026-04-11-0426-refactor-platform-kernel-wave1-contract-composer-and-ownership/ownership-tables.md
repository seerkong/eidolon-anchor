# Ownership Tables

本文件是 `refactor-platform-kernel-wave1-contract-composer-and-ownership` 的正式 ownership 基线。

## 1. Contract Ownership Table

| Surface | Current Location | Target Ownership | Notes |
|---------|------------------|------------------|-------|
| actor / fiber / mailbox orchestration contract | `vendor/depa-actor` + `core-logic/runtime` | platform | 平台执行原语，继续建立在 vendor 上 |
| profile / bootstrap / composition contract | `@cell/composer` | platform | `@cell/composer/contract` 收口为平台级 contract |
| runtime policy / capability ownership metadata | `@cell/composer` | platform | 作为平台组合结果一部分继续保留 |
| `AgentConfig` | `@cell/core-contract/runtime/AgentConfig` | AI domain | 明确属于 AI 领域，不应继续进入 platform composer contract |
| `ToolSchema` | `@cell/core-contract/types` | AI domain | 当前默认 tool surface 仍属 AI runtime |
| slash namespace `actor/member/holon` | `@cell/composer` / `mod-sys-kernel` | AI domain | 属于 AI 领域 action surface |
| questionnaire / approval / HITL contract | `@cell/core-contract/runtime/Questionnaire*` | AI domain | 明确不纳入平台 contract |
| AI semantic stream taxonomy | `@cell/core-contract/stream/*` | AI domain | 未来可演化，但本波次不提升到平台 |
| AI runtime snapshot / transcript / history contract | `@cell/core-contract/runtime/*` | AI domain | 持久化与领域状态绑定，留在 AI 领域 |

## 2. Runtime Facet Table

| Runtime Surface | Current Location | Target Facet | Notes |
|----------------|------------------|--------------|-------|
| actor runtime handle | `AiAgentVm.actorRuntime` | platform facet | 通用执行底座 |
| generic orchestrator context | `AiAgentVm.runtimeContext.currentOrchestrator` | platform facet | 代表通用调度上下文 |
| deferred resume queue | `AiAgentVm.runtimeContext.deferredMemberResumes` | AI domain facet | 当前语义仍与 AI 成员恢复相关 |
| interactive turn marker | `AiAgentVm.runtimeContext.interactiveTurnActive` | AI domain facet | 当前以 AI turn 语义命名 |
| actor/member/holon roster state | `AiAgentVm.sessionState.*` | AI domain facet | 明显 AI 协作语义 |
| detached actor records | `AiAgentVm.sessionState.detachedActors` | AI domain facet | 当前是 AI tool/delegate 语义 |
| runtime callbacks such as tool/todo hooks | `AiAgentVm.callbacks` | AI domain facet | 当前 callback surface 明显面向 AI 产品 |
| runtime effects such as message/orchestration history | `AiAgentVm.effects` | AI domain facet | 当前和 AI runtime 历史模型绑定 |
| outer runtime context `workDir` | `AiAgentVm.outerCtx` | shared bridge facet | 平台可复用，但当前仍通过 AI runtime 宿主暴露 |

## 3. Package Mapping Table

| Current Package | Wave 1 Target Role | Later Direction |
|----------------|--------------------|-----------------|
| `vendor/depa-actor` | platform primitive | 持续作为 actor/fiber/mailbox 原语 |
| `vendor/depa-processor` | platform primitive | 持续作为 manifest/bundle/dispatch 原语 |
| `vendor/depa-data-graph` | platform primitive | 持续作为 event log/projection/state graph 原语 |
| `@cell/platform-contract` | new platform contract host | 承接平台级 execution/composition contract |
| `@cell/composer/contract` | platform contract re-export | 对外维持正式 contract 入口 |
| `@cell/composer/ai-contract` | AI domain assembly facet | 作为当前 AI runtime 的兼容过渡层 |
| `@cell/core-contract` | AI domain contract host | 后续继续清理 AI/platform 混排 |
| `@cell/core-logic` | mixed, but moving toward platform + AI split | 后续拆出 platform facet 与 AI facet |
| `@cell/organ-contract` | AI domain contract host | 继续保持 AI 领域 ownership |
| `@cell/organ-logic` | AI domain logic host | 继续保持 AI 领域 orchestration |
| `@cell/organ-support` | AI domain support host | 继续承接 AI 领域环境实现 |
| `@cell/mod-sys-kernel` | AI domain baseline | 后续不应再被误认成 platform baseline |
| `@cell/mod-sys-coding` | AI app overlay | 后续作为 `ai-coding` profile overlay |
