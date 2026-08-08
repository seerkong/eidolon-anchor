# 设计：AIDataWorkflow Eidolon Runtime Adapter

## 方案概览

`WorkflowRuntimeService` 根据 definition form 分派 AICtrlWorkflow 或 AIDataWorkflow。数据型 run 的语义真源由 depa-flows `createAIDataWorkflowRunGraph`、`applyAIDataWorkflowGraphPatch`、`listReadyAIDataWorkflowNodes`、semantic fingerprint、reuse lookup 与 state projection 提供；Eidolon 只实现 host driver、持久化和 effects。

数据 driver 按 RunGraph ready frontier 推进：EntryNode 注入 contract input；TransformNode/SinkNode 通过 EagerDataFlow filesystem code resolver 执行；ReturnNode 组装最终输出；manual node 进入 waiting 状态并由 `WorkflowResume` 提供输出。每个 transition 后原子保存 graph 与 generation state。

GraphPatch 先由 canonical patch function 产生新 generation 与传递性 invalidation，再执行新 frontier。每个可执行节点以 effective input、node tag、config、material revision/effect policy 计算 semantic fingerprint。`semantic-hash` 仅查询同一 run 的历史 generation；命中则记录 `Reused` 与 `reusedFrom`。`never` 总是重新执行。generation 仅保存历史，不进入 fingerprint。

## Effect 与 authority

机器 effect 继续调用 `EidolonWorkflowEffectProvider`；同步 agent node 复用既有 actor，tool node 复用 ToolFuncRegistry，material node 复用 authoring workspace，生命周期证据进入 runtime-control。RunGraph 只保留 workflow result/ref/event。

## Public tools

- 现有 `WorkflowRun/Status/Events/Result/Resume` 同时支持两种 form。
- 新增 `WorkflowApplyGraphPatch`，接受结构化 canonical patch；结构与风险 policy 校验通过后默认自动提交。
- manual resume 使用稳定 `node_id` 和 result payload；ctrl resume 继续使用 WaitHandle signal。

## 风险与缓解

- Host driver 复制 Eager scheduler 语义：限制为 RunGraph 的 ready-node application，所有图、依赖、patch、invalidation、reuse 和 policy 判定调用 depa-flows API；不解析 XNL、不另建图模型。
- crash 中断节点：执行前保存 Running/Waiting 事实，恢复时将无完成证据的机器节点重新纳入本 generation；effect evidence/idempotency key 用稳定 run/generation/node 标识。
- manual 默认复用：canonical node-type default 为 `never`，节点仅可显式覆盖并保留 `reusePolicy.source`。
