# 独立 HolonTaskRuntimeService

本文记录 Eidolon 将任务派发给 Holon 或 Member 时的 canonical 运行链。该能力可以脱离 AI Ctrl/Data Workflow 独立使用；Workflow 只是同一服务的一个 origin/适配入口，不拥有另一套任务自治机制。

## Authority 边界

| 事实 | 唯一 authority | 运行时只允许保留的投影 |
| --- | --- | --- |
| Holon、Member、Role 及有效时间 | 已签发的 `HolonEffectiveSnapshot` | admission 中的 eligible Member/Role |
| Member/Role 到执行载体的映射 | 冻结的 `HolonExecutionBinding` 闭包 | deployment、adapter target、runtime isolation policy |
| 可复用任务契约和默认路由 | Halfcode `HolonTaskRuntimeDefinition` 内容身份 | stable admission catalog |
| task、claim、lease、状态、结果 | TaskSpace owner | task identity、receipt、observation |
| 已接受的外部 actor effect | pump journal | idempotent intent/result receipt |
| actor 地址、session、history | 通用 actor/session runtime | `MemberRuntimeRef`、`sessionRef` |
| Ctrl/Data 图位置和节点 material | Workflow checkpoint | TaskSpace receipt/material 的观察结果 |

`ai-organ-logic` 的 canonical Holon runtime 模块只定义 data、Processor 和显式 effect ports；Workflow application service 也只能取得同一个 VM support facet，不能自行创建另一套 owner。`ai-support` 组装 File TaskSpace、pump journal 和本地 deployment store；Terminal 负责把当前 VM、Halfcode registry、通用 actor/session owner 与具体 adapter 接入。不得再引入第二个 TaskSpace owner、module `WeakMap` service locator 或 VM `holonState.tasks` 写入路径。

## Halfcode admission 与独立启动

正常 VM 启动读取有效 Halfcode registry，投影所有 `HolonTaskRuntimeDefinition`。每份 definition 必须同时满足：

1. resource identity 与 definitionRef 一致；
2. exact `HolonExecutionBinding` 存在且 content digest 匹配；
3. root Holon、snapshot、freeze receipt 和 registry revision 可复现；
4. binding target、required Role 均处于冻结 snapshot eligibility；
5. 同一 Holon 最多只有一个 default definition。

admission identity 由 definition content identity、binding semantic fingerprint、snapshot bytes/receipt 共同决定，不能根据 VM 名字或运行时猜测。Terminal 只调用一次 `openLocalHolonTaskRuntime`；VM facet 持有一个 service/catalog owner。相同冻结资源重放时复用该 owner，revision、scope 或 authority 冲突时 fail closed。

## 统一执行链

产品入口 `HolonAssign`、`MemberAssign`、`ActorAssign` 与 Ctrl/Data Workflow 最终都调用同一个 `HolonTaskRuntimeService.assign`：

1. catalog 用显式 Holon、Member 或 admission selector 选择唯一 admission；
2. support 创建或重放 canonical `eidolon.ai.holon-task` TaskSpace；
3. coordinator mailbox 按 `(deploymentId, holonRef)` 唤醒唯一 actor；
4. Processor 通过 TaskSpace claim 分配 Member，并依据 frozen binding policy 创建 shared 或 `isolated-task-runtime` MemberRuntime；
5. actor/session runtime 为每次 task attempt 提供 session，TaskSpace 和 support 不复制消息历史；
6. pump journal 在外部 dispatch 前写 intent，adapter 使用 intent identity 幂等接受 effect，随后写 result；
7. Processor 以 TaskSpace settlement 收口，调用方只观察 receipt/material。

旧 `depa.ai.organization-task` profile 和 v1 Workflow subscription 只在 compatibility decoder 中投影到上述 canonical Processor。新 subscription v2 使用 `origin + recoveryScope`；standalone scope 不要求 `workflowInstanceId/runId/nodeId`。

## reply mode

- `final`：当前请求驱动一次执行并等待 TaskSpace terminal settlement；不能把 pending 伪装成完成。
- `none`：TaskSpace 和 durable subscription 成功建立后立即返回 accepted receipt，由 runtime lifecycle 后台继续。
- `stream`：与 `none` 使用同一 durable task identity，界面可基于 receipt/observation 投影进度，不创建第二套 stream 状态。

assign 与 final 是 response command；后台 wake/recovery 是 message。三种 mode 的 accepted effect 和 TaskSpace 事实完全相同。

## fresh-process 恢复

1. 重开有效 registry，复现 admission 和 deployment authority；
2. 读取 durable subscription，并和 TaskSpace profile、snapshot/binding digest 交叉验证；
3. terminal task 只计入观察，不重新 dispatch；
4. 非终态 task 重建 MemberRuntime/coordinator 地址并发送一个 typed wake；
5. 若 journal 已有 result，直接重放；若崩溃发生在 effect 已接受但 result 未落盘，adapter idempotency key 保证 effect 不重复；
6. close 只释放 timer/live actor，下一进程从 TaskSpace/journal 重建，不读取 Workflow checkpoint 或旧 VM TaskTree。

## Workflow 的位置

Ctrl/Data Workflow 可以提供 workflow origin、exact task identity 和 recovery scope，也可以把 terminal TaskSpace receipt/material 写回自己的 checkpoint。它不能创建另一套 coordinator、TaskSpace、journal 或 MemberRuntime policy；无 Workflow instance 时，产品 assignment 与 fresh restart 仍须完整工作。

## 当前验证矩阵

- contract/profile/catalog/Processor/service 的 focused tests；
- File TaskSpace + File pump journal 的 `final/none/stream`、Holon/Member selector、replay、fresh VM、crash-after-effect E2E；
- Ctrl/Data Workflow-neutral 回归；
- 静态架构门禁：无 module `WeakMap`、无 VM TaskTree writer、logic 层不构造 File TaskSpace/journal、Terminal 只装配一个 standalone host。

跨节点 leadership、remote transport 与数据库后端不属于本次单机服务范围，但未来实现必须复用上述 contract 和 authority，不得用远端协调需求复制任务真源。
