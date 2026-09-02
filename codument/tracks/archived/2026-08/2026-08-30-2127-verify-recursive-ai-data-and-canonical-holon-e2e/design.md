# 设计：递归 AI Data 与 canonical Holon 产品 E2E

## 上下文

当前实现已经拥有四条真实链路：

1. `AIDataWorkflowRuntimeDriver` 和安装的 depa-flows runtime 可执行自主加入的 `SubFlowNode`，child invocation 由 exact child definition/instance/run/checkpoint/terminal receipt 描述。
2. `WorkflowRuntimeService.observeAIDataAgentDefinition` / `prepareAIDataAgentDefinition` 经 Halfcode authoring authority 创建或选择 `AIAgentDefinition`，并把 preparation receipt 合入 run freeze。
3. Ctrl/Data Holon node 经 `HolonTaskPumpJournal`、`HolonTaskSpaceCoordinatorActor` 和 generic `MemberRuntime` 自动推进 TaskSpace。
4. `WorkflowRuntimeService.replanHolonTask` 显式采用新的 organization snapshot，只为 successor task 建立新 frozen deployment。

现有证据分散在 `workflow_app_resource_registry.test.ts`、`autonomous_agent_resource_host.test.ts`、`holon_execution_binding_registry.test.ts` 以及 depa-flows 的 SubFlow 测试中。G7 不重新实现这些 authority，而是验证跨边界组合，并只在组合失败处修 production wiring。

## 方案概览

### 1. 证据矩阵而非单个巨型场景

同一测试入口组织下列可独立定位、共同构成产品闭环的 journeys；每个 journey 都输出并断言 durable identity/receipt：

| Journey | Ctrl | Data | 必须观测的事实 |
| --- | --- | --- | --- |
| recursive goal | typed child boundary | autonomous `SubFlowNode` | parent/child exact refs、child terminal receipt、parent checkpoint output |
| Worker resource | exact frozen Worker target | author-new 与 select-existing | Halfcode transaction receipt、candidate decision、run preparation proof |
| Holon task graph | dependent TaskSpace | dependent/parallel MaterialPort tasks | automatic claim/settle、subscription correlation、无手工 process |
| failure/recovery | accepted effect crash window | parent/child or task checkpoint crash window | fresh runtime 重建、effect 不重复、同一 settlement |
| organization replan | successor Ctrl task | successor Data output | old target不漂移、新 snapshot receipt、新 deployment、父 Flow消费 |

这些 journeys 可以共享 fixture builder，但不得共享可写 runtime state；失败必须能定位到具体 authority 边界。

### 2. 反作弊门禁

- 不调用 `WorkflowProcessHolonTask`、CLI `holon-process` 或任何已退役 VM task API。
- 不把 expected controller patch、definition 文本或 candidate choice预写进 host production code。测试 provider 可以返回声明式决策，但 host 只接受 typed proposal/admission。
- 完成条件读取 checkpoint、TaskSpace history、Halfcode receipt 和 frozen proof；`providerCalls` 只作“没有重复 effect”的辅助断言。
- fresh recovery 必须构造新的 runtime/service owner，不能复用旧 service instance 冒充恢复。

### 3. 运行与修复策略

先建立 coverage map，运行已有聚焦测试。然后新增最小组合测试：优先复用现有 fixture builder，避免复制大段 resource package。若测试暴露缺口，修复实际 authority owner并在同一测试保留回归。最后运行产品矩阵、相关类型检查、静态 anti-cheat scan 和 fresh 独立审查。

## 影响范围与修改点（Impact）

- 测试：`cell/packages/ai-organ-logic/tests/workflow/`
- Eidolon product host：`cell/packages/ai-organ-logic/src/workflow/runtime/`
- Halfcode adapter：`cell/packages/ai-organ-logic/src/resources/`
- canonical Holon runtime：`cell/packages/ai-organ-logic/src/organization/`

## 决策摘要

- graph authority 仍是唯一 recursive AI Data RunGraph；不创建 `GoalGraph`。
- dynamic Agent definition 的 authority 是 Halfcode resource authoring/effective registry；Capability Catalog 保持 frozen projection。
- Holon task authority 只有 TaskSpace；Ctrl/Data/product facade 共享 coordinator、MemberRuntime 和 receipt 链。
- 本 Track 没有新增待决设计，继承 Mission 已接受的三项 P0 决策。

## 风险 / 权衡

- 组合测试可能较慢：按 journey 分段，等待 durable terminal facts而不是盲目扩大固定 sleep。
- 外部本地候选依赖可能被其他 session 替换：先验证 frozen candidate 路径；若依赖目录漂移，记录协调事实，不覆盖他人安装。
- 大型 fixture 容易重复生产语义：只把模型输出/外部故障作为 fixture，resource 校验与生命周期继续走产品代码。

## 兼容性设计

本 Track 不保留旧 VM fallback。发现旧 snapshot 时只能审计读取或明确拒绝，不能恢复 writable autonomous task fiber。

## 待解决问题

- 当前组合测试运行后，哪些 Mission 矩阵项仍只有局部证据；该问题由 P1 coverage map 以当前源码回答。
