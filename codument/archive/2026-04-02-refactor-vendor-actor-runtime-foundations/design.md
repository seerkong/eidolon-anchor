# 设计：vendor actor runtime foundations

## 1. 背景

当前仓库已经完成 AI runtime 主路径 actorization，但 control-plane 中真正可复用的 runtime foundation 仍主要散落在项目侧：

- `OrchestratorDriver` 持有等待、完成绑定、settle loop 等机制化逻辑
- runtime snapshot / recovery 由项目侧 schema 与恢复路径主导
- `AiAgentActor` 与 `AiAgentVm` 仍直接内嵌大量产品态字段

这导致 `vendor/depa-actor` 更像一个低层内核片段，而不是正式的 runtime substrate。后续若继续推进微内核化，会遇到两个直接问题：

- 通用调度/恢复机制无法稳定复用到其他 runtime；
- AI-specific coordination / organization / TaskTree 语义难以与 substrate 清晰拆分。

本设计的目标是先补齐 `vendor/depa-actor` 中缺失的通用 foundation，再让项目侧第一批真实实现开始收口到这些 foundation 上。

## 2. 设计目标

- 让 completion signal / waiter、child completion binding、snapshot / hydrate / recover protocol、facet / plugin extension point 成为 `vendor/depa-actor` 的正式公开能力。
- 让项目侧现有 runtime 改为建立在 vendor foundation 之上，而不是继续各自维护平行机制。
- 保持 vendor 纯粹表达“通用 actor runtime 机制”，不吸收 AI-specific 业务语义。
- 把第一轮 adoption 控制在可验证、可回归的范围内，不一次性重写全部 runtime。

## 3. 非目标

- 不在本设计中处理 data-plane foundation、processor manifest 或 composer/profile 装配。
- 不在 vendor 中定义 collective / formation / TaskTree / plan approval / shutdown 等业务语义。
- 不要求第一轮就删除所有项目侧 runtime 包装类型；允许先把它们收口为 vendor foundation 之上的薄封装。

## 4. 边界划分

### 4.1 应进入 `vendor/depa-actor` 的内容

- keyed completion signal / waiter primitive
- child completion binding
- actor / fiber / orchestrator snapshot contract
- actor state codec hook
- fiber / orchestrator state codec hook
- hydrate / recover hook
- persistence effect port
- actor facet / plugin extension point
- actor / fiber 索引 hook

### 4.2 应保留在 `symbiont-*` / `core-logic` / 上层的内容

- collective / formation 组织语义
- `TaskTree`
- `planApproval`
- `shutdownCoordination`
- questionnaire suspend / human-wait 的 AI-specific 业务映射
- detached task contract、organization projection、AI coordination envelope 等 AI-specific 中层

一句话边界：

- vendor 负责“actor runtime 如何等待、恢复、扩展”；
- `symbiont-*` 和上层负责“这些等待、恢复、扩展在 AI runtime 中具体代表什么”。

## 5. 第一轮 adoption 策略

### 5.1 Orchestrator driver

当前 `OrchestratorDriver` 中已经有一批高度机制化的能力，例如：

- `waitForSignal(...)`
- child completion binding
- foreground / background settle loop
- detached completion routing

第一轮应将其收口为：

- vendor 提供 keyed completion signal / waiter foundation；
- vendor 提供 parent-child completion binding 的正式协议；
- `OrchestratorDriver` 只保留 AI runtime bridge、调用顺序和业务路由，不再长期承载通用等待基座。

### 5.2 Runtime snapshot / recovery

当前 runtime snapshot / recovery 同时承载了通用结构和 AI-specific 业务字段。

第一轮目标不是把所有恢复逻辑都挪进 vendor，而是：

- vendor 提供 actor / fiber / orchestrator snapshot contract；
- vendor 提供 codec hook、hydrate / recover hook 与 persistence effect port；
- 项目层保留 AI-specific product-state codec 与外部 persistence adapter；
- 明确 side effect 分离，不让 vendor 直接碰文件系统或数据库。

这里需要额外收紧一条边界：

- `vendor/depa-actor` 不能只提供泛型 `SnapshotCodec<TState, TSnapshot>` 包装器；
- 它还需要提供 actor / vm(or runtime root) / fiber / manifest 的 base snapshot contract；
- 项目层 snapshot 类型必须通过扩展这些 base contract 来附加 AI-specific 字段，而不是继续独立定义整套基础结构。

### 5.3 Runtime state mounting

当前 `AiAgentActor` / `AiAgentVm` 仍直接内嵌大量产品态字段。

第一轮目标不是一次性搬空所有字段，而是：

- 在 vendor 中提供 facet / plugin extension point；
- 至少让一类产品态或索引改为通过该扩展点挂载；
- 证明“产品态可以外挂而不是写死”这条边界在真实代码中成立。

## 6. 关键设计决策

### 决策 1：先沉淀 runtime mechanism，再清理产品态

原因：

- 如果没有稳定的 waiter / snapshot / facet foundation，直接清理产品态只会把逻辑搬来搬去；
- 先把通用 foundation 做实，后续产品态才能稳定外移。

### 决策 2：vendor 只提供 persistence protocol，不提供 concrete persistence

原因：

- 这是本轮最关键的边界约束；
- 一旦 vendor 直接提供 save/load，就会把存储介质假设固化进底层；
- side effect 分离要求 vendor 只表达 protocol、codec、effect port。

### 决策 3：允许项目侧保留兼容层，但不允许其继续作为正式 foundation

原因：

- `OrchestratorDriver`、snapshot runtime 等类型已有多处调用；
- 第一轮要证明 vendor foundation 可用，不需要同时大面积改名；
- 但必须明确正式来源已经切到 vendor，而不是长期双轨。

## 7. 实施顺序

1. 冻结 track 文档、实施边界和 adoption 目标。
2. 在 `vendor/depa-actor` 中实现 completion signal / waiter foundation。
3. 在 `vendor/depa-actor` 中实现 snapshot / hydrate / recover / effect port foundation。
4. 在 `vendor/depa-actor` 中补齐 snapshot base contracts，并让项目侧 snapshot 类型改为建立在这些 base contract 之上。
5. 在 `vendor/depa-actor` 中实现 facet / plugin extension point。
6. 用 vendor focused tests 锁定基础行为。
7. 迁移 `OrchestratorDriver` 的等待与完成绑定到 vendor foundation。
8. 迁移 runtime snapshot / recovery 的通用协议到 vendor foundation。
9. 迁移至少一类 actor / vm 产品态挂载到 vendor facet foundation。
10. 清理当前工作树中不属于本 track 的 `vendor/depa-data-graph` / stream foundation 改动，恢复 capability 边界。
11. 补齐文档与 strict validation。

## 8. 验证策略

- vendor tests 证明：
  - keyed waiter 能稳定等待与唤醒；
  - child completion binding 能把结果回路由到 parent 或 watcher；
  - snapshot / hydrate / recover protocol 能表达通用结构；
  - facet / plugin extension point 能承载外层状态与索引挂载。
- project tests 证明：
  - `OrchestratorDriver` 的等待与完成路径行为不回归；
  - runtime snapshot / recovery 在迁移 protocol 后外部行为不回归；
  - 至少一类产品态挂载已不再依赖内嵌字段作为唯一正式来源。

## 9. 风险与缓解

### 风险：vendor API 抽象过深，第一轮 adoption 反而困难

缓解：

- 先以 `OrchestratorDriver`、runtime snapshot、actor state 挂载这三个真实调用点倒推 vendor API；
- 不要求 vendor 第一轮同时覆盖所有未来 runtime 场景。

### 风险：snapshot protocol 容易误带入业务字段

缓解：

- 在 design 与 tests 中显式锁定“vendor snapshot 只表达通用结构”的边界；
- 让 AI-specific 字段必须通过 codec / facet hook 注入。

### 风险：当前工作树混入其他 capability 改动，导致 review 与验收边界失真

缓解：

- 把 `vendor/depa-data-graph` / stream foundation 改动视为独立 capability 处理；
- 当前 track 的修正中显式移除这些超范围改动；
- 验证时同时检查测试通过和工作树范围是否回到 actor runtime foundation。

### 风险：facet foundation 只停留在抽象层，没有真实 adoption

缓解：

- `plan.xml` 中显式要求至少一类产品态完成真实挂载迁移；
- focused tests 和 project adoption 一起锁定该边界。
