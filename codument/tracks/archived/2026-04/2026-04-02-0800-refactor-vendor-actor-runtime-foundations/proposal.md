# 变更：沉淀 vendor actor runtime foundations

## 背景和动机 (Context And Why)

当前仓库已经完成 AI runtime 主路径的 actorization，但真正可复用的 control-plane foundation 仍主要堆叠在项目内：

- `cell/packages/organ-logic/src/OrchestratorDriver.ts`
- `cell/packages/core-logic/src/runtime/actor.ts`
- `cell/packages/core-logic/src/runtime/runtime.ts`
- `cell/packages/core-logic/src/runtime/snapshot/*`
- `cell/packages/organ-logic/src/persistence/RuntimeSnapshots.ts`

这些实现里同时混有两类内容：

- 通用机制：
  - keyed completion signal / waiter
  - child completion binding
  - foreground/background settle loop
  - actor / fiber / orchestrator snapshot 与 hydration hook
  - runtime bridge 与索引挂载点
- AI-specific 业务态：
  - `TaskTree`
  - `planApproval`
  - `shutdownCoordination`
  - `collectiveState`
  - `formationState`
  - questionnaire / detached / organization 相关业务协议

如果继续把这两类内容混放在项目侧，会产生三个直接后果：

- `vendor/depa-actor` 仍不是 control-plane 的真实基础设施；
- 通用调度/恢复机制和 AI-specific 业务语义继续耦合；
- 后续微内核化时，很难把 runtime substrate、AI 中层与最终 profile/extension 装配清晰拆开。

本 track 的目标是先把真正通用的 actor runtime foundation 沉淀到 `vendor/depa-actor`，并为第一轮真实 adoption 提供清晰路径，同时严格遵守 side effect 分离：vendor 只提供 hook / protocol / codec / effect port，不假定具体 save/load 逻辑，不内置业务态持久化实现。

## “要做”和“不做” (Goals / Non-Goals)

**目标:**

- 在 `vendor/depa-actor` 中补齐 keyed completion signal / waiter、child completion binding、runtime snapshot / hydrate hook、actor runtime facet / plugin extension point 等正式 foundation；
- 为这些 foundation 提供清晰的公开导出、focused tests 与 adoption 路径；
- 让项目中的第一批真实调用方开始迁移到 vendor foundation，优先覆盖 `OrchestratorDriver`、runtime snapshot / recovery、actor runtime state 挂载边界；
- 明确 vendor 与 `symbiont-*` 的边界，避免把 AI-specific coordination / organization / TaskTree 语义错误沉淀到 vendor。

**非目标:**

- 不把 collective / formation 的业务路由策略直接沉淀到 `vendor/depa-actor`；
- 不把 `TaskTree`、plan approval、shutdown coordination、questionnaire suspend policy 等 AI-specific 业务逻辑直接沉淀到 vendor；
- 不在本 track 中完成 profile / extension / composer 装配层；
- 不在 vendor 中直接提供文件系统、数据库或其他具体存储介质的 save/load 实现；
- 不要求第一轮就删除全部项目侧 runtime 包装，只要求 vendor 成为正式机制来源并完成第一批真实 adoption。

## 变更内容（What Changes）

- 在 `vendor/depa-actor` 中新增 runtime wait / completion foundation：
  - keyed completion signal / waiter primitive
  - parent wait / detached notify 的 child completion binding
  - scheduler / runtime bridge 所需的最小等待接口
- 在 `vendor/depa-actor` 中新增 persistence / recovery foundation：
  - actor state codec hook
  - fiber / orchestrator state codec hook
  - snapshot contract
  - hydrate / recover hook
  - persistence effect port
- 在 `vendor/depa-actor` 中新增 runtime extension foundation：
  - actor facet / plugin 扩展点
  - actor / fiber 索引 hook
  - 允许上层挂载 domain-specific state，而不是把产品态写死在 vendor actor shell
- 在项目侧完成第一轮 adoption，优先把以下实现收口为 vendor foundation 之上的消费者或薄封装：
  - `OrchestratorDriver`
  - runtime snapshot / recovery
  - `AiAgentActor` / `AiAgentVm` 的 product-state 挂载方式

## 第一轮实施范围

本 track 第一轮需要收敛到一个可直接开工、可验证的最小闭环：

1. 在 `vendor/depa-actor` 中定义正式的 completion signal / waiter foundation；
2. 在 `vendor/depa-actor` 中定义 snapshot / codec / hydrate / recover / persistence effect port foundation；
3. 在 `vendor/depa-actor` 中定义 actor runtime facet / plugin extension point；
4. 用 focused tests 锁定 waiter、completion binding、snapshot protocol 与 facet extension 的行为；
5. 在项目侧完成第一轮 adoption，使 `OrchestratorDriver`、runtime snapshot / recovery、actor runtime state 挂载开始建立在 vendor foundation 之上；
6. 补齐迁移说明，明确哪些能力进入 vendor，哪些能力继续留在 `symbiont-*`、`core-logic` 或更高层。

## 直接执行的交付物

第一轮交付物至少包括：

- `vendor/depa-actor/src/*` 中新增或扩展的 runtime foundation；
- vendor 侧 focused tests：
  - completion signal / waiter
  - child completion binding
  - snapshot / hydrate / recover protocol
  - facet / plugin extension point
- 项目侧第一轮 adoption：
  - `OrchestratorDriver` 的等待与完成绑定收口
  - runtime snapshot / recovery 的 protocol 收口
  - actor / vm 产品态挂载边界的第一轮整理
- 自包含设计文档，说明 vendor 与 `symbiont-*` 的边界、adoption 顺序和风险控制。

## 本 track 不做什么

- 不处理 `vendor/depa-data-graph` 的 stream / timeline foundation；
- 不处理 `vendor/depa-processor` 的 manifest / 分发协议；
- 不把 AI-specific 组织语义直接收进 `vendor/depa-actor`；
- 不在本 track 中完成 `@cell/composer`、`@cell/mod-sys-kernel`、`@cell/mod-sys-coding` 的装配层建设。

## 影响范围（Impact）

- `vendor/depa-actor`
- `cell/packages/core-logic`
- `cell/packages/organ-logic`
- `cell/packages/symbiont-contract`
- `cell/packages/symbiont-logic`
- 相关测试与恢复文档

## 成功标准

- `vendor/depa-actor` 成为 waiter / completion / snapshot / facet extension 的正式来源；
- persistence / recovery 在 vendor 中只以 hook / protocol / codec / effect port 形式存在；
- 项目侧不再长期维护与 vendor 平行的通用 runtime foundation；
- AI-specific coordination / organization / TaskTree 逻辑清晰保留在 `symbiont-*` 或更高层；
- 第一轮 adoption 通过真实仓库代码与 focused tests 被验证，而不是只停留在 vendor 内部抽象。
