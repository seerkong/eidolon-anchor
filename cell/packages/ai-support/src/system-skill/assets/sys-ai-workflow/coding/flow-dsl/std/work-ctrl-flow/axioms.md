# L2 领域公理 · WorkCtrlFlow（可挂起控制流）

> 编号 `WF-*`。继承 L1 与[共享 CtrlFlow grammar](../../spec/flow-core/nodes.md)。容器根是 `<WorkCtrlFlow>`；与 InstantCtrlFlow 的差异只在持久生命周期能力。

## WF-1 · 共享 grammar，不共享生命周期上限

WorkCtrlFlow 使用与 InstantCtrlFlow 完全相同的 `Run`、`If`、`Fallback`、`Until`、`Return` authoring 语法，并追加两种生命周期 statement：`ExternalJob` 与 `Timer`。根和嵌套 body 的 `[]` 仍是唯一顺序真源，不引入另一套条件或组合语法。

所有动态代码仍遵守 `output = fn(runtime, input, config)`。snapshot/resume 是 profile runtime 的职责，不改变 code ref 的参数顺序、数据链或 fault 约定。

## WF-2 · 只有显式 statement 可以持久挂起

- `ExternalJob` 等待与 `(signalKind, signalKey)` 匹配的外部恢复消息。
- `Timer` 等待声明的 duration 到期。

进入上述 statement 时，引擎登记包含稳定 statement path 与 resume token 的 open WaitHandle，原子保存 snapshot，然后返回 suspension。`Run`、predicate 和其他公共 statements 必须在当前 tick 内正常返回或产生技术 fault，不能暗中跨 tick 挂起。

## WF-3 · snapshot 是实例真源

snapshot 至少保存：

- definition identity/version 与当前 statement path、嵌套 body frame、循环 invocation 等恢复位置。
- 当前 data 以及恢复后继续数据链所需的 statement output。
- open/closed WaitHandle、deadline、resume token 与已应用恢复消息标识。
- 已发生的 branch decision，键由稳定 `If` path 与 invocation identity 构成。
- profile runtime 明确声明的持久 state；definition 和 `state.seed` 不被回写。

definition 仍是 authoring topology 真源，snapshot 只拥有某个实例的运行事实。definition 变更若会改变已有 statement path，必须显式迁移在途 snapshot。

## WF-4 · branch decision 先记录，后进入 body

`If` 首次执行某次 invocation 时按共享 grammar 求值，并在进入所选 body 前持久记录 `{ decisionKey, selectedBranchId }`；选择 Otherwise 或无匹配也必须记录为明确值。

实例恢复或内部 plan 重建时：

1. 已有 decision 的 invocation 直接复用记录，不重新调用已发生 Branch predicate。
2. 尚未发生的 `If` 才按当前 input/config 求值并创建新 decision。
3. decision 与 snapshot 一起持久化，不能只存在于进程内缓存。

这保证挂起前已经发生的业务路径不会因时间、配置或外部数据变化而改道。

## WF-5 · 恢复消息幂等且不混淆 data/fault

ResumeSignal 必须匹配一个 open WaitHandle 并携带其 resume token。成功恢复的 payload 成为 `ExternalJob` output；`Timer` 到期后透传进入 Timer 的 input。重复 token 幂等，未匹配或已关闭的句柄不得改变 snapshot。

恢复消息的 payload 是普通 data，其中的 `refused`、`cancelled` 等业务字段不会自动变成 fault。只有独立的技术 fault 通道（例如外部作业不可恢复失败、超时 policy 或无效恢复协议）才使 statement 技术失败。suspension 本身既不是 data，也不是 fault。

## WF-6 · 中断等价性

从 snapshot 恢复后的最终结果必须等价于同一恢复消息在原进程中即时到达后的结果，已发生外部副作用的时点除外。恢复必须从保存的 statement 位置、data 和 decision 继续，不能通过重跑整条 authoring definition 猜测现场。

## WF-7 · agent 语义留在协议外

agent、人或远端系统都可以是 ExternalJob 的执行方，但 `AgentTask`、`Questionnaire` 等角色特定节点不进入 WorkCtrlFlow grammar。协议只定义等待与恢复，不定义外部执行者的身份。
