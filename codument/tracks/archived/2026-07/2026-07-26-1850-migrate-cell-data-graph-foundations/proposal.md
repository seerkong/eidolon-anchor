# 变更：迁移 Cell DataGraph Foundations

## 背景和动机 (Context And Why)

1.0.1 已使 Cell aggregation 可加载，但 reference-aligned stage pipeline 的
`addConsumer` callback 仍依赖旧 `ctx.get` shape，导致 semantic/live-stage
tests 运行时失败。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**
- 将 stage graph consumers 迁至 1.0.1 支持的读取方式。
- 保持 stage ordering、replay/live parity、callback emission 与 module refs。
- 重新验证 RxData、AgentEventGraph、semantic facade 和 symbiont compatibility。

**非目标:**
- 不修改 observability graph、MessageHistoryGraph 或 terminal projection。
- 不重写 stage parser 的领域语义。

## 影响范围（Impact）

- behaviors：`vendor-data-graph-modular-node-identity`
- 代码：`createLLMStagePipeline.ts` 和 focused Cell foundation tests。
