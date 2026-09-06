# 独立 HolonTaskRuntimeService

本文记录 Eidolon 将任务派发给 Holon 或 Member 时的 canonical 运行链。该能力可以脱离 AI Ctrl/Data Workflow 独立使用；Workflow 只是同一服务的一个 origin/适配入口，不拥有另一套任务自治机制。

## Authority 边界

| 事实 | 唯一 authority | 运行时只允许保留的投影 |
| --- | --- | --- |
| Holon、Member、Role 及有效时间 | 已签发的 `HolonEffectiveSnapshot` | admission 中的 eligible Member/Role |
| Member/Role 到执行载体的映射 | 冻结的 `HolonExecutionBinding` 闭包 | deployment、adapter target、runtime isolation policy |
| 可复用任务契约和默认路由 | Halfcode `HolonTaskRuntimeDefinition` 内容身份 | stable admission catalog |
| task、claim、lease、状态、结果 | TaskSpace owner | task identity、receipt、observation |
| dispatch 意图与返回结果 | pump journal | idempotent intent/result receipt |
| 外部 effect 是否已接受 | 具体 adapter 的幂等接受/查询协议 | acceptance 结果；不能仅由缺失 journal result 推断未执行 |
| actor 地址、session、history | 通用 actor/session runtime | `MemberRuntimeRef`、`sessionRef` |
| Ctrl/Data 图位置和节点 material | Workflow checkpoint | TaskSpace receipt/material 的观察结果 |

canonical Processor 经显式 effect ports 工作；Workflow application service 只能取得同一个 VM capability，不能自行创建另一套 owner。`ai-support` 提供 File TaskSpace、journal byte-store 和 submission writer；journal 规则与 task routes 在 `ai-organ-logic`，由显式 runtime 注入上述效果。Terminal 的 `AIAgent/LocalHolonTaskRuntimeBootstrap.ts` 负责选择文件 factory/clock，把当前 VM、Halfcode registry、通用 actor/session owner 与具体 adapter 接入。不得再引入第二个 TaskSpace owner、module `WeakMap` service locator 或 VM `holonState.tasks` 写入路径。

## Halfcode admission 与独立启动

正常 VM 启动读取有效 Halfcode registry，投影所有 `HolonTaskRuntimeDefinition`。每份 definition 必须同时满足：

1. resource identity 与 definitionRef 一致；
2. exact `HolonExecutionBinding` 存在且 content digest 匹配；
3. root Holon、snapshot、freeze receipt 和 registry revision 可复现；
4. binding target、required Role 均处于冻结 snapshot eligibility；
5. 同一 Holon 最多只有一个 default definition。

admission identity 由 definition content identity、binding semantic fingerprint、snapshot bytes/receipt 共同决定，不能根据 VM 名字或运行时猜测。Terminal 只调用一次 `openLocalHolonTaskRuntime`；VM facet 持有一个 service/catalog owner。相同冻结资源重放时复用该 owner，revision、scope 或 authority 冲突时 fail closed。

新采用的 deployment 同时冻结原生资源字节、Agent 执行代码闭包和实际 workspace 指令。即使只改变 `AGENTS.md` 而 admission 未变，下一次明确采用也会形成不同 deployment 身份；同一已采用任务不会自动热换配方。Terminal 的独立执行适配器从该 deployment 编译真实 typed payload，再交给原 addressed child actor，不再从 live AgentRegistry 临时取得配置。

当前派发 catalog 和历史恢复 route 用途不同：新 assign 只选当前 admission；旧订阅按 exact deployment/binding/snapshot/scope 恢复，即使 live 资源已移除，也不能被当成新任务候选。没有冻结材料的历史部署不能被宣称为已经证明可复现，缺失执行配方会明确拒绝；本次不会改写用户旧现场来伪造历史证据。

## 统一执行链

产品入口 `HolonAssign`、`MemberAssign`、`ActorAssign` 与 Ctrl/Data Workflow 最终都调用同一个 `HolonTaskRuntimeService.assign`：

1. catalog 用显式 Holon、Member 或 admission selector 选择唯一 admission；
2. logic routes 经注入的 TaskSpace owner 创建或重放 canonical `eidolon.ai.holon-task` TaskSpace；
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

## 任务诊断与修复

人和 AI 共享 `HolonTaskRuntimeService.observe(selector)` / `repair(selector, invocation)`。正式工具为 `HolonTaskObserve` / `HolonTaskRepair`；人工命令直接走同一 ToolFuncRegistry，不先请求模型：

```text
/holon task-observe {"selector":{"admissionId":"admission:...","taskSpaceId":"holon-task-space-...","taskId":"holon-task-..."}}
/holon task-repair {"selector":{"admissionId":"admission:...","taskSpaceId":"holon-task-space-...","taskId":"holon-task-..."},"invocation":{"kind":"resume","requestId":"repair-001","expectedRevision":4,"reason":"恢复停滞任务","occurredAt":"2026-09-05T12:00:00.000Z"}}
```

identity 来自 assign receipt，`expectedRevision` 必须来自最近一次 observation，时间填写本次请求实际 UTC 时间。观察返回 TaskSpace 状态、attempt/claim、最近事件及失败、订阅、后继/lineage 和建议动作，不派发模型、不创建 MemberRuntime。`memberRuntimeRef` 来自 owner claim；独立及 Workflow 宿主通过已有 deployment store 的读取接口查询 member，并严格按 taskSpaceId、taskId、claimId、attempt 关联持久 session，不取共享 Member 最近的其他任务会话。缺少该事实或宿主没有绑定读取口时，`sessionRef=null` 并给出原因，不能从当前 UI 或名称猜测。`lastWakeError` 仅表示当前进程的协调器观测，成功 wake 清除，进程关闭后不持久化为任务事实。

- `resume`：仅接受非终态。把修复请求追加为 TaskSpace 输入 artifact 审计证据，再向原 coordinator mailbox 唤醒。不更改 claim、attempt、profile 或业务 subscription input，不另起执行器；原 inputArtifacts 保留。过期 claim 仍由原 Processor/owner 协议处理。
- `successor`：仅接受 Failed/Cancelled。再提供 `target`（例如 `{"kind":"admission","admissionId":"admission:..."}`）、`name` 和完整新 `input`。同一 TaskSpace 中以 native replan 原子提交新任务、新冻结 admission/profile 和包含完整订阅的修复 artifact；原失败/取消任务的定义、关系和终态保持不变。后继是新的明确执行，可能产生新的外部 effect，不与原 effect 幂等键混用。成功任务不能通过该入口重复执行；运行中 acceptance 未明的任务不能直接强制改派。
- 相同 selector + requestId 的完整请求重放复用已提交证据；内容、目标、revision 或时间不同均显式冲突。CAS 失败后先重新观察，重新决策并使用新 requestId，不能假装旧请求被接受。
- owner 提交与 subscription 发布之间退出时，恢复扫描已知 TaskSpace 中的引用及对应 replan receipt，再发布缺失订阅；不扫描或信任孤立 artifact。新的 canonical subscription 只执行自己的 taskId；旧 Workflow legacy batch profile 仍由兼容路径处理。

修复 API 返回 request/command identity、source 与 task identity、artifact digest 及 replayed。返回 accepted 不是任务成功，后续必须再次 observe。未知 member-session、未绑定 frozen admission 和外部 effect 未知接受状态均显式暴露，不以猜测补全。

## Workflow 适配

Ctrl/Data Workflow 可以提供 workflow origin、exact task identity 和 recovery scope，也可以把 terminal TaskSpace receipt/material 写回自己的 checkpoint。它不能创建另一套 coordinator、TaskSpace、journal 或 MemberRuntime policy；无 Workflow instance 时，产品 assignment 与 fresh restart 仍须完整工作。

Workflow 宿主必须先显式挂载 capability 及 storageFactory/clock。WorkflowRuntimeService 不再隐式选择文件存储；缺少装配或 scope 冲突时明确拒绝。独立启动仍通过 Terminal 的 `openLocalHolonTaskRuntime` 完成整套生命周期，底层测试或其他宿主可调用 organ 的 `bootstrapLocalHolonTaskRuntime(input, { storageFactory, now })` 并注入替代实现。

## 当前验证矩阵

- contract/profile/catalog/Processor/service 的 focused tests；
- File TaskSpace + File pump journal 的 `final/none/stream`、Holon/Member selector、replay、fresh VM、crash-after-effect E2E；
- Ctrl/Data Workflow-neutral 回归；
- 静态架构门禁：无 module `WeakMap`、无 VM TaskTree writer、logic 层不构造 File TaskSpace/journal、Terminal 只装配一个 standalone host。

跨节点 leadership、remote transport 与数据库后端不属于本次单机服务范围，但未来实现必须复用上述 contract 和 authority，不得用远端协调需求复制任务真源。
