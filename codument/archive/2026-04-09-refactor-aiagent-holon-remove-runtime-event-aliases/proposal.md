# 变更：移除 holon runtime event 与 core-contract 的 collective alias

## 背景

当前剩余的 `collective` 真正还在运行时 API 面上出现的，主要只剩两处：

- `AgentEventGraph.emitCollectiveClaim/emitCollectiveIdleExit`
- `cell/packages/core-contract/src/runtime/Collective.ts`

它们都已经不再承担独立逻辑，也没有业务调用方，继续保留只会让 `collective` 看起来仍像当前 runtime API 的正式组成部分。

## 变更内容

- 删除 `AgentEventGraph.emitCollectiveClaim/emitCollectiveIdleExit`
- 删除 `cell/packages/core-contract/src/runtime/Collective.ts`
- 将 `core-contract` 默认导出切到 `runtime/AutonomousHolon.ts`
- 同步 stream/layout tests 与 theater 报告

## 非目标

- 不删除 internal-only `Collective* / Formation*` tool alias
- 不处理历史文档里作为迁移前基线保留的 `collective / formation` 描述
- 不修改 `AutonomousHolon.ts` 的 payload 结构

## 影响范围

- `cell/packages/core-contract/src/index.ts`
- `cell/packages/core-contract/src/runtime/Collective.ts`
- `cell/packages/core-contract/src/runtime/AutonomousHolon.ts`
- `cell/packages/core-logic/src/stream/AgentEventGraph.ts`
- `cell/packages/organ-logic/tests/AIAgent/stream/agent_event_graph.test.ts`
- `cell/packages/organ-logic/tests/AIAgent/cell_contract_packages_layout.test.ts`
- `.theater/actor/2026-04-09-collective-formation-rename-readiness-report.md`
