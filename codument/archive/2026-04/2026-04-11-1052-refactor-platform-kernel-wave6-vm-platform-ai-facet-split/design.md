# 设计：VM platform/AI facet split

## 1. 目标

本 wave 解决一个核心结构问题：

- `AiAgentVm` 目前同时承载平台执行状态与 AI 领域状态

目标是先把“运行时承载体”分层，而不是立即做更大规模的包重组。

## 2. 拆分方向

### Platform facet

- actor runtime
- generic registries
- callbacks / effects / options
- outer context / mcp manager
- 可继续作为后续 shell bridge 的平台 runtime 宿主

### AI facet

- member roster
- holon state
- detached actor state
- AI runtime context
- AI coordination / semantic runtime 相关状态

## 3. 迁移策略

- 先在 `runtime.ts` 内定义 facet types 与 accessor
- 允许 `AiAgentVm` 暂时作为聚合壳继续存在
- 后续调用方逐步改为依赖 facet accessor，而不是直接依赖整块 VM

## 4. 风险

- `organ-logic` 与 `terminal` 当前对 `AiAgentVm` 的耦合非常深
- 因此本 wave 必须先建立 facet boundary，再做最小调用方切换

## 5. Focused Verification

- runtime snapshot / recovery tests
- orchestrator / organization tests
- terminal runtime adoption tests
