# 变更：沉淀 vendor data-graph stream foundations

## 背景

当前项目已经完成了 actorization 主路径与 `symbiont-*` 的低层分层，但数据面仍存在明显的“双轨通用基座”问题：

- `vendor/depa-data-graph` 已提供 `StreamGraph`、`GraphBridge`、`signalToStream`、`subscribeStreamToSignal` 等能力
- 项目内仍长期维护 `OutputStream`、`TeeOutputStream`、`IngressStreams`、`IngressStreamRuntime`
- `AgentEventGraph` 仍通过 `latest_event + event_seq + consumer` 手工模拟 append-only event log 与 projection dispatch
- terminal projection 仍部分依赖项目层自定义 runtime helper，而不是统一建立在 vendor data-plane primitive 之上

这会导致：

- vendor 不是数据面的唯一正式来源
- AI runtime 继续维护一套与 vendor 平行生长的 stream/timeline helper
- 后续微内核改造时，通用 data-plane 机制与 AI-specific stage 语义难以稳定分层

本 track 的目标是先把真正通用、可跨 AI 与前后端场景复用的 stream/timeline/projection 基元沉淀到 `vendor/depa-data-graph`，再让项目侧低层 stream runtime 收口到这些 vendor foundations。

## 变更内容

- 在 `vendor/depa-data-graph` 中补齐 ordered timeline、tee/fanout、append-only event log、reducer/projection primitive 等正式通用机制
- 明确区分：
  - 通用 data-plane 机制进入 `vendor/depa-data-graph`
  - AI-specific 的 stage contract、LLM delta 语义、transcript 语义继续留在 `symbiont-*`、`core-contract` 与上层
- 将 `cell/packages/symbiont-contract/src/stream/stream.ts` 与 `cell/packages/symbiont-logic/src/stream/*` 收口到 vendor foundations
- 将 `cell/packages/core-logic/src/stream/AgentEventGraph.ts` 与 terminal projection 侧的通用 append-only/projection 模式迁移到 vendor foundations
- 补齐 vendor、symbiont、core/terminal 三层 focused tests，确保 cutover 不是新的双轨长期共存

## 本 track 不做什么

- 不在本 track 中处理 `depa-actor` 的调度、恢复、snapshot hook
- 不在本 track 中处理 `depa-processor` 的 manifest/export 协议
- 不在本 track 中建立 `@cell/composer`、`@cell/mod-sys-*` 的 profile/extension 装配层
- 不把 AI-specific lexical/syntactic/semantic 事件契约直接挪入 vendor
- 不重写 terminal 上层交互协议，只收口其依赖的通用 stream foundation

## 交付结果

- `vendor/depa-data-graph` 暴露可复用的 timeline/log/projection 正式 surface
- `symbiont-*` 的 ingress/timeline helper 变为 vendor foundation 之上的薄封装，或被直接删除
- `core-logic` / `organ-logic` / `terminal` 中的通用 append-only event dispatch 不再以手工 `latest_* + seq` 方式长期存在
- track 文档、实现计划与测试 gate 足够具体，可以直接按 phase 开始执行

## 影响范围

- `vendor/depa-data-graph/packages/core/src/stream/*`
- `vendor/depa-data-graph/packages/core/test/*`
- `cell/packages/symbiont-contract/src/stream/stream.ts`
- `cell/packages/symbiont-logic/src/stream/*`
- `cell/packages/core-logic/src/stream/*`
- `cell/packages/organ-logic/src/stream/*`
- `terminal/packages/organ/src/stream/*`
- 相关 focused tests 与 vendor 文档

## 成功标准

- `vendor/depa-data-graph` 成为 stream/timeline/projection 通用机制的正式来源
- 项目内不再长期维护与 vendor 平行的通用 stream 基座
- AI-specific 数据面逻辑清晰收口到 `symbiont-*` 与上层，而不是回流到 vendor
- 该 track 的 `design.md` 与 `plan.xml` 足以直接指导实现、迁移与验证
