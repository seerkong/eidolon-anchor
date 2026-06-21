# 变更：将 holon runtime 的 manager helper 与 collective event wording 继续收口

## 背景

当前 formal surface、内部主工具路径，以及 legacy tool family 已经基本收口到 `holon + governance`。但 runtime 内部还留有两类明显旧名：

- `OrganizationManager.createCollective/createFormation/...` 这类旧 helper 仍承载真实实现
- autonomous holon claim / idle exit 相关 runtime event 仍沿用 `Collective*` 命名和可见文案

## 变更内容

- 将 `OrganizationManager` 中的 holon-first API 提升为主实现入口
- 让 `createCollective/createFormation/...` 等旧 helper 退化为显式 alias 包装
- 为 autonomous holon runtime event 引入 holon-first 命名和可见文案
- 保留旧 event API 名作为兼容 alias

## 非目标

- 不处理 lane/workload `collective` 这类调度协议保留项
- 不处理 task-tree `collective:` / `formation:` scope marker
- 不在本 track 中继续清理所有 executor 内部 helper 的语义名

## 影响范围

- `cell/packages/organ-logic/src/organization/OrganizationManager.ts`
- `cell/packages/organ-logic/src/organization/AutonomousHolonTaskRunner.ts`
- `cell/packages/organ-logic/src/exec/AiAgentExecutor.ts`
- `cell/packages/core-logic/src/stream/AgentEventGraph.ts`
- `cell/packages/core-contract/src/runtime/*`
- 相关 focused tests 与 theater 报告
