# Track: isolate-codument-proposition-e2e-testkit

## Goal

把 Codument 三模式命题验证所需的 contract、harness、matrix runner、terminal binding 与 live runtime 收敛到一个仓库私有的 E2E testkit；生产包的 `src` 与公开 `index.ts` 不再承载或导出这些测试专用能力。

## Why

当前 `AIAgentDefinition` 资源生成代码位于 `terminal/packages/organ-support/src`，却直接引用 `@cell/ai-organ-*/e2e/*`。这让测试命题成为生产依赖图的一部分，模糊了 contract/logic/support 的发布与所有权边界，也会让后续 Agent Halfcode 重构建立在错误的基础上。

## Scope

- 建立仓库级私有 `testkit/codument-proposition` 所有者。
- 迁移命题 contract、harness、matrix runner、terminal support 与 live runtime，保持 receipt、manifest、mode identity、provider observation 的既有语义与字节证据。
- 更新命题脚本、测试与专用 typecheck 入口。
- 删除生产包公开导出与生产 `src` 中的测试专用实现。
- 添加源码边界棘轮，拒绝生产源码导入 testkit 或 proposition E2E 实现。

## Non-goals

- 本 Track 不重构 `AIAgentDefinition`、`CodeAgent.xnl` 或 Workflow runtime。
- 本 Track 不重新运行付费的完整 live provider 矩阵；只保持 live runner 可执行并做无网络验证。
- `ProviderCacheCostObservation`、`WorkflowPublicRuntimeEvidence` 等产品证据 contract 继续属于生产代码，不迁入 testkit。

## Success

生产包入口没有 Codument proposition E2E 导出，生产 `src` 不依赖私有 testkit；现有命题测试、专用类型检查和 live runner 的无网络行为全部通过，receipt/manifest 的外部语义保持不变。
