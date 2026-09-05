# Design: establish-standalone-holon-task-runtime-service

## 1. 历史设计复原

本 Mission 不是另起炉灶，而是把已经形成的 canonical 链路从错误的宿主边界中提取出来。

| 演进阶段 | 当时能力 | 应保留/淘汰 |
| --- | --- | --- |
| `add-aiagent-background-teams-protocols-autonomy` | VM `TaskTree` 上 scan → claim → execute → complete；teammate 可长驻，subagent 临时 | 保留“组织接单并自治完成”的产品语义；淘汰 process-local task authority |
| `refactor-aiagent-to-member-collective-formation-model` / `refactor-aiagent-to-member-holon-primary-model` | Member/Holon 成为统一组织模型；autonomous Holon 内部拥有调度；assign 支持 `final/none/stream` | 保留 direct Member 与 Holon assignment、执行模式和治理语义 |
| `local-file-single-node-holon-task-actor-runtime` | File-XNL snapshot、`HolonExecutionBinding`、TaskSpace、HolonCoordinator、共享 MemberRuntime 与 task-attempt session | 全部作为当前 canonical 基础保留 |
| `add-canonical-holon-taskspace-pump` | durable subscription、claim/start/dispatch/settle、heartbeat/expiry/recovery、accepted-effect journal | 作为服务内部唯一连续执行引擎保留 |
| `retire-vm-autonomous-holon-tasktree` | 删除旧 VM writer；产品 assign 暂时从冻结 Workflow target 投影 authority | 删除旧 writer 的决定保持；“必须先有 Workflow”是本 Mission 要消除的宿主耦合 |

关键现状代码：

- `cell/packages/ai-organ-logic/src/workflow/runtime/WorkflowRuntimeService.ts` 的 `workflowHolonContext()` 当前创建 deployment store、TaskSpace owner、journal、coordinator 与 assignment authority；
- 同文件 `assignCanonicalHolonTask()` 当前承载产品 Holon assignment；
- `organization/CanonicalHolonAssignmentFacade.ts` 明确把 frozen Workflow target 当作唯一 admission；
- `organization/HolonWorkflowTaskRuntime.ts` 的执行核心仍强制要求 `workflowInstanceId`/`runId`；
- `organization/HolonTaskSpacePump.ts`、`HolonCoordinator.ts`、`HolonMemberRuntime.ts` 已具备可复用的 canonical processor。

## 2. 目标组件关系

```text
File-XNL Holon snapshot + HolonExecutionBinding + RuntimeDefinition
                              │ freeze/admit
                              ▼
                    HolonTaskRuntimeService
             ┌───────────────┼────────────────┐
             │               │                │
       HolonAssign      MemberAssign     Workflow adapter
       ActorAssign    (canonical member)  (Ctrl / Data)
             │               │                │
             └───────────────┴────────────────┘
                              │
                 TaskSpace owner + pump journal
                              │
                     HolonCoordinator actor
                              │
                 shared MemberRuntime / task session
                              │
                       generic actor runtime
```

`HolonTaskRuntimeService` 是应用层 façade 和 composition root，不夺取底层 owner：它只把 frozen authority、TaskSpace processor、journal、coordinator 与 actor runtime 接起来。

## 3. Authority 边界

| 事实 | 唯一 owner |
| --- | --- |
| Holon/member/role 组织结构与 effective snapshot | Holon Workbench + File-XNL issuer |
| member/role → execution adapter | `HolonExecutionBinding` resource closure |
| 可供独立派发的 task contract 与默认入口 | `HolonTaskRuntimeDefinition`（Halfcode resource）及其 freeze receipt |
| task、relation、claim、lease、result、artifact、transition receipt | TaskSpace owner |
| dispatch accepted-effect 与幂等 replay | Holon task pump journal |
| runtimeRef、sessionRef、binding/snapshot receipt | Holon deployment store / MemberRuntime |
| conversation history、provider context、compression | generic actor/session runtime |
| Ctrl/Data graph position与 material consumption | 对应 Workflow checkpoint；仅观察 TaskSpace receipts |

禁止：Workflow checkpoint 复制 task truth；service 复制 actor history；VM Holon record 伪造 snapshot/binding；命令按模糊名称选择多个 admission。

## 4. 中立运行时 contract

第一条 Track 应在 `@cell/ai-organ-contract` 中建立 closed data contract，具体命名可在 Track 内按现有风格收敛，但必须覆盖：

- `HolonTaskRuntimeDefinition`
  - `definitionRef` 与 schema/version；
  - `rootHolonRef`；
  - 精确 `executionBindingRef`；
  - TaskSpace profile/policy；
  - input/output schema、material ports；
  - 是否为该 Holon 的默认 assign admission；
- `FrozenHolonTaskRuntimeAdmission`
  - definition bytes/digest、registry revision、snapshot/binding freeze receipts；
  - 从 binding target 派生的 `member` 或 `role` eligibility，不接受调用方伪造；
- `HolonTaskAssignmentTarget`
  - `{ kind: "holon", holonRef }`；
  - `{ kind: "member", holonRef, memberRef }`；
- `HolonTaskExecutionOrigin`
  - 中立 `originRef` 与 `kind`；
  - Workflow lineage 只在 adapter metadata 中出现，核心 processor 不要求 Workflow id；
- assignment/open/observe/settlement/recovery receipts。

Workflow 的 `ai-workflow-contract/HolonTaskTarget` 不迁移、不泛化。adapter 负责验证其 freeze receipt，并投影出一次中立 admission；历史 profile/subscription 通过显式 compatibility decoder 归一化，不能在核心逻辑中散落双分支。

## 5. Service 生命周期

`HolonTaskRuntimeService` 至少提供以下语义接口：

1. `open()`：扫描/冻结 runtime definitions，物化 deployment definition，打开 TaskSpace owner 与 journal，重建 coordinator registry；
2. `registerAdmission()`：供 Workflow adapter 注册已冻结 target 的临时/实例级 admission，但不得创建第二套 owner；
3. `assign()`：解析精确 target，幂等创建 TaskSpace/subscription，按 reply mode pump；
4. `observe()`/`wait()`：只从 TaskSpace/receipt 投影状态与 material；
5. `recover()`：扫描 durable subscriptions，验证 frozen closure，续跑未终态任务；
6. `close()`：停止 wake timer/heartbeat，不删除 durable truth。

Service identity 绑定一个 runtime support root 与一个资源 registry。相同 root 上只能有一个 live service owner；重复打开必须复用或 fail closed，不能并行写同一 TaskSpace。

## 6. Holon 与 Member 路由

- Holon assignment：只选择 `rootHolonRef` 匹配且标记为 default 的一个 frozen admission；不存在返回 `canonical_holon_binding_required`，多于一个返回 `canonical_holon_binding_ambiguous`。
- canonical member assignment：只选择 binding target 为该 `memberRef` 的一个 frozen admission；HolonCoordinator 仍负责 claim，但 eligibility 被 exact member binding 收窄。
- role binding：组织级 admission 可让 coordinator 在 frozen role eligibility 中选择成员。
- session-local Member：保留现有 `MemberManager` mailbox/continuity 行为，并在 receipt/error 中表明它不是 canonical Holon TaskSpace member。后续若要迁移，必须另开 Track。
- Agent continuity：调用方不能传 Agent instance；只有 frozen binding 与 MemberRuntime 能在 claim 之后选择 shared/isolated actor session。

## 7. Workflow 适配

`WorkflowRuntimeService` 不再创建私有 TaskSpace owner、journal、coordinator map 或向 VM 注册独立 authority。它只：

1. 发现并验证 frozen `HolonTaskTarget`；
2. 把 Workflow lineage 和 target contract 映射为 service admission；
3. 调用 service open/assign/observe/consume；
4. 在 checkpoint 中保留稳定 TaskSpace/receipt/material refs。

Ctrl 与 Data adapter 必须共用同一 service instance。Data material validation 仍由 Workflow/resource schema owner 完成；service 只提供 settlement artifact 与 receipt。

## 8. 恢复与兼容

- 新 subscription/journal 使用中立 `originRef`，不要求 workflow fields；
- compatibility decoder 能读取现有 `workflowInstanceId/runId/nodeId` subscription 和 `depa.ai.organization-task` profile，归一化后进入同一 pump；
- fresh process recovery 的输入来自 runtime definitions、deployment definition、TaskSpace snapshots 与 journal，不读取旧 VM TaskTree；
- 已 accepted dispatch 在 crash 后必须通过 journal replay，不能重复调用 member actor；
- lease expiry、stale settlement、snapshot/binding digest mismatch 都 fail closed 并留下可观察 receipt/error。

## 9. Track 切片

### Track 1 — `introduce-standalone-holon-task-runtime-contract-and-service`

建立中立 contract/resource projection、generic processor input、service lifecycle 与最小独立 assign；把 `HolonWorkflowTaskRuntime` 的核心重构为不依赖 Workflow identity 的 `HolonTaskRuntime`，保留兼容 wrapper。

### Track 2 — `route-holon-member-and-workflow-assignment-through-task-runtime`

在应用 runtime bootstrap 中创建唯一 service；让 product Holon/member assign 与 Ctrl/Data adapter 委托服务；删除 `WorkflowRuntimeService` 内重复 composition ownership。

### Track 3 — `harden-standalone-holon-task-runtime-recovery-and-e2e`

覆盖 final/none/stream、canonical member、并发幂等、crash/restart、legacy Workflow recovery、Ctrl/Data regression；更新 `docs/ai/architecture/holon-task-actor-system.md` 与 behavior registry。

## 10. 纠偏与验收策略

每条 Track 均采用先 contract/fixture、后 implementation、再真实恢复验证的闭环。若实现必须重新引入 Workflow id、第二 TaskSpace owner 或 VM task writer，MissionReconciler 将其判定为 drift 并重规划，而不是用兼容层掩盖。

最终 Mission 验证以五条可观察证据为准：无 Workflow 派发、精确 member 派发、同一服务的 Workflow 回归、fresh process recovery、authority 静态扫描。仅类型通过而无真实 TaskSpace/actor receipt 不算完成。

## 11. DEPA 实施映射

本 Mission 全程受 `analysis/depa-guidance.md` 约束。特别地，产品名 `HolonTaskRuntimeService` 不意味着把业务逻辑塞进一个持有隐式依赖的 class：

- `HolonTaskRuntime` 是 data-only runtime，显式承载 admission catalog、TaskSpace/deployment/journal/actor/scheduler ports；
- 核心采用 `assignHolonTask(runtime, selector, invocation, config)` 等 Processor；
- `HolonTaskRuntimeService` 是由 composition root 构造的薄 port/facade；
- contract 在 `ai-organ-contract`，纯逻辑在 `ai-organ-logic`，本地环境 effect 在 `ai-support`，terminal runtime 只负责装配；
- coordinator 的 mailbox 是唯一 live pump control owner，TaskSpace 仍是任务事实 owner；
- module-level `WeakMap`、Workflow 私有 owner 和 file support 被核心逻辑直接构造均视为 drift。

## 12. Halfcode 0.3 跨仓映射

| 原逻辑/事实 | Halfcode 架构映射 | 项目 owner | 消费方 |
| --- | --- | --- | --- |
| legacy `apiVersion/version` authored metadata | `envelopeVersion="halfcode.resource-envelope/v1"` + exact integer `specVersion` | Halfcode | Holarchy、Eidolon |
| `currentApiVersion/supportedApiVersions` 描述性 KindDefinition | immutable Kind subject owner + exact `SpecRevision` + schema/semantic/source contract fingerprints | 各 Kind 业务 owner，算法由 Halfcode 提供 | Halfcode loader/resolver、Eidolon registry |
| `HolonEffectiveSnapshot` Kind bytes | Holarchy 生成并导出 owner/revision/source/bytes；snapshot parser/canonicalizer仍是 semantic authority | Holarchy | Eidolon adapter |
| `HolonExecutionBinding` Kind bytes | Eidolon adapter 生成并导出 owner/revision/source/bytes | Eidolon adapter | ai-organ/resource registry |
| `HolonTaskRuntimeDefinition` Kind bytes | ai-organ contract 生成并导出 owner/revision/source/bytes | Eidolon ai-organ contract | standalone service admission |
| effective VFS overlay planning 与 revisioned CAS publication | `xnl-vfs` 的公开 root/subpath API；XNL 仓拥有 planner、mutation/CAS 组合与 browser-safe build | XNL VFS | Eidolon symbiont materializer |

迁移不是让三个仓库共享一个隐式 registry。每个 owner 导出可审计 contract registration；host composition 显式组合这些 registrations，并验证 authored KindDefinition 中的 fingerprint 与代码侧 admitted revision 完全一致。

## 13. 发布闭包与顺序

1. 先验证并打包 `halfcode-compiler.xnl@0.3.0`；
2. 再用该 tarball 构建/验证 Holarchy snapshot 与 local-file library release closure；
3. 再用前两层候选构建 `holarchy-eidolon-adapter` 和 Eidolon private consumer；
4. 最后运行 normal VM、fresh restart、Ctrl/Data regression 与架构扫描。

`npm pack`、隔离安装和 build/test 属于发布准备；`npm publish` 不属于默认执行范围。若用户另行授权发布，命令必须显式使用 `/Users/kongweixian/.npmrc_official`，且 Holon Workbench 的 server/web 业务应用始终排除在 npm 发布清单之外。

### Clean-build closure correction

正式发布后的第一次 clean/frozen install 证明 `@cell/symbiont-logic` 声明的 `xnl-vfs@0.1.2` 不包含源码已使用的 `planVfsOverlays` 与 `publishRevisionedVfsOverlayPlan`。这不是 Eidolon 应拥有的逻辑：两个 API 及其 atomicity/browser-safety tests 位于 XNL 仓的 `packages/vfs`，该包是唯一 owner。纠偏顺序固定为：在 XNL owner 仓验证并发布下一精确版本 → Eidolon 依赖声明升级 → 重建 lock → 再次 clean/frozen install → 最终构建。禁止把实现复制进 Eidolon、patch `node_modules` 或依赖工作站路径。
