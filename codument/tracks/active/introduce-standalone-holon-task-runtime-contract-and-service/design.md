# Design: introduce-standalone-holon-task-runtime-contract-and-service

## 1. Contract

`HolonTaskRuntimeDefinition` 是中立、closed、可冻结的数据，不含物理路径：

- stable definition ref/version；
- root Holon ref；
- exact execution binding ref/digest；
- TaskSpace profile/policy and role/capability constraints；
- input/output schema and material ports；
- `defaultForHolon` admission policy。

`FrozenHolonTaskRuntimeAdmission` 额外携带 registry revision、definition digest、可复用的 frozen snapshot authority 与 binding freeze evidence。该 authority 不含 `taskSpaceId` 或 per-task issuer receipt；这些事实只有在一次 TaskSpace submission 后才能成立。binding target 是 eligibility authority：member binding 只允许 exact member，role binding 允许 coordinator 在 frozen role closure 中选择。closed data/schema/effect ports 位于 `ai-organ-contract`；所有 normalizer 与状态转移位于 `ai-organ-logic`。

公开交互拆分为：

```text
assignHolonTask(runtime, selector, invocation, config)
```

selector 只表达 Holon/member target；invocation 表达 task input、reply mode、origin 与 idempotency key；config 只含 lease/max-step 等静态策略。

## 2. Profile compatibility

新 profile 使用稳定 kind/version 并存放中立 definition/admission projection 与既有 `HolonTaskSnapshotReceipt` 等价事实。canonical `normalizeHolonTaskExecutionProfile` 只接受中立 schema。独立 legacy Workflow adapter 接受：

1. legacy `depa.ai.organization-task` profile；
2. 先调用 `ai-workflow-contract` 原 normalizer 验证，再投影为中立 internal view。

Coordinator、pump 与 execution Processor 只消费 canonical internal view，且不 import Workflow contract。兼容性不能散布在各模块，也不复制一份 legacy schema。

## 3. Processor extraction

`executeHolonTask(runtime,input,config)` 取代 Workflow-specific core：

- `runtime`：deployment store、TaskSpace runtime、actor runtime、journal；
- `input`：deployment/binding/Holon/TaskSpace/task/origin、command ids、timestamps、lease 与 closed task input；
- `config`：TaskProcessorConfig。

task-attempt session 记录一个中立 origin ref/kind。原 `executeHolonWorkflowTask` 保留为 adapter，构造 Workflow origin 后调用新 Processor。claim/start/heartbeat/settle 与 journal semantics 不变。

## 4. Service shape

`HolonTaskRuntimeService` 是 thin port，不承载隐藏业务状态。实现由 data-only runtime + functions 构成：

- admission catalog 是 runtime data；`registerHolonTaskRuntimeAdmission(runtime,input,config)` 产生 successor catalog，或调用 runtime 显式 catalog port，service 对象不持有隐藏 `Map`；
- target resolver 以 closed selector 做 cardinality check；
- task identity 从 service/admission/request id 确定性派生；
- open processor 调用注入的 TaskSpace creation port；该 port 返回本次 task 的 exact snapshot receipt，service 交叉验证 admission authority、binding 与实际 `taskSpaceId` 后才接受；
- coordinator registry 通过注入的 runtime facet/registry 保存，而不是 module `WeakMap`；
- TaskSpace 创建/提交是 command；pump wake 是发给唯一 `(deploymentId, holonRef)` coordinator actor 的 typed mailbox message；`final` 等待 settlement observation；none/stream 的 background scheduler 留给下一 Track 接线，但 contract 在本 Track 固定。service 禁止直接调用 coordinator/member 内部方法或另建消息总线。

为控制本 Track 范围，service 接受已冻结 admission 与已注入 ports；workspace Halfcode resource discovery、file effects 与 terminal bootstrap 后置。

## 5. Data authority

- TaskSpace：task/claim/lease/status/result/artifact truth；
- journal：dispatch intent/accepted effect/idempotent output record；
- deployment store：frozen binding/snapshot and runtime/session refs；
- actor/session：conversation and provider context；
- service catalog：runtime-only projection of frozen admissions, rebuildable；
- Workflow profile：legacy input/adapter observation only。

任何兼容 adapter 都只能 command owner 或投影观察，不得反写/复制 task truth。

## 6. Failure and migration

- invalid closed data → contract error；
- no target → `*_binding_required`；multiple → `*_binding_ambiguous`；
- exact member mismatch → target mismatch；
- stale claim/settlement semantics unchanged；
- persisted legacy profile remains readable; no bulk migration in this Track。

## 7. Verification

Tests must execute a task through injected in-memory/file test ports without constructing any Workflow instance. A second test uses a member-targeted binding. Repeated-assignment coverage proves one reusable admission can yield distinct per-request TaskSpace snapshot receipts. Negative cases cover extra fields, wrong digests, no/multiple admission and legacy profile. Static checks inspect new logic imports/service locators, assert canonical core does not import Workflow contract, and prove wake travels through the unique coordinator mailbox before final settlement observation.
