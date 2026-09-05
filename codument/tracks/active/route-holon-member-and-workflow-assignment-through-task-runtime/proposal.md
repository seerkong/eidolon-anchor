# 变更：统一 Holon/member 产品派发与 Workflow task runtime

## 背景

G1 已建立 Workflow-neutral `HolonTaskRuntimeService`，但现有产品工具仍通过 `CanonicalHolonAssignmentFacade` 的模块级 `WeakMap` 查找由 Workflow 启动时注册的 authority；Ctrl/Data 的 `openTask` 则直接调用旧 Workflow Holon processor。结果仍是两套入口，且没有 Workflow 就没有产品 capability。

## 目标

- 在 VM actor runtime facet 上为显式 `{supportRoot, registryRef}` scope 挂载唯一 serviceRuntimeRef/service/catalog owner，admission 只注册 config/effect route；
- 正常 Eidolon VM bootstrap 在没有 Workflow 时也装配该 owner 与 support-layer effects；
- `HolonAssign`、`ActorAssign`、`MemberAssign` 的 canonical autonomous 分支调用该 capability；
- frozen Workflow target 通过独立 adapter 生成 admission 并把 effect route 注册到同一 owner；
- Ctrl/Data 的 task open path 与产品工具调用同一 `HolonTaskRuntimeService`；
- 删除模块 `WeakMap` authority 与 Workflow-specific product receipt；
- 保留 leader-led Holon 和非 canonical 普通 Member direct-message 行为。

## 非目标

- 本 Track 实现正常进程启动的 VM composition；不实现 fresh-process 对中断任务的自动发现/重建与续跑，那属于 G3 recovery；
- 不改变 TaskSpace、journal、deployment、actor/session 的事实权威；
- 不恢复 VM TaskTree/autonomous envelope；
- 不引入新的 package 或 transport。

## 影响

- `ai-organ-contract` 的 invocation 使用 `derive | exact` 判别联合，并以 submission fingerprint 约束精确 identity replay；
- `ai-organ-logic/organization` 增加 facet-backed runtime capability 与 Workflow adapter；
- 产品 assign tools 和 `WorkflowRuntimeService` 接线收敛；
- focused tests 增加 standalone Holon/member 与 Ctrl/Data compatibility matrix。
