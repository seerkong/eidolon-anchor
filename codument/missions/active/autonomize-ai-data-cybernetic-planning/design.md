# Mission Design：Autonomous AI Data Cybernetic Planning

## 控制目标

把 AI Data Workflow 从“可被外部命令重规划的数据图 runtime”演进为“能由资源化控制 Agent 根据观测自主提出计划，并经 canonical admission 持续重规划的数据图系统”。目标不是让模型成为 state owner，而是让模型成为受约束的 planner/reconciler。

## 当前事实与缺口

| 能力 | 当前 authority / 证据 | 判定 |
| --- | --- | --- |
| run graph、generation、patch history、invalidation | depa-flows `AIDataWorkflowRunGraph` 与 checkpoint transition | 已具备 |
| GraphPatch admission/application | `WorkflowApplyGraphPatch → WorkflowRuntimeService.applyGraphPatch → AIDataWorkflowRuntimeDriver.applyPatch` | 已具备 |
| resource Agent 节点 | frozen `AIAgentDefinition` task proof + Eidolon effect provider | 已具备 |
| Agent instance 复用 | durable AI profile 的 `instancesById/instanceIdByName` + `runTargetedAgent` | 已具备，未进入自主闭环 |
| 自主 observation/reconcile/patch loop | 既有 E2E 由测试代码构造 patch | 缺失 |
| live model 自主收敛证据 | iQingwa 三模式运行的是固定图命题 | 缺失 |

## DEPA 与 authority 拓扑

| node | semantic role | authority model / owner | transition / relation |
| --- | --- | --- | --- |
| Goal + verifier contract | immutable desired-state value | E2E proposition / admitted workflow definition | observed by control loop，不因失败而修改 |
| AI Data checkpoint/run graph | current authority + recovery material | depa-flows checkpoint owner | only canonical GraphPatch/result/checkpoint transitions |
| typed node results + verifier report | derived observation | graph/result projection + verifier | projects from current generation；不得反写 graph |
| ControlObservation | derived observation value | observation projector | graph/verifier → controller input |
| ControlDecision | proposed command data | controller Agent output，非 authority | validated by admission Processor |
| admitted GraphPatch | transition command | graph-patch admission Processor | commands checkpoint owner |
| Agent instance index | durable runtime control | workflow AI profile | `runAgent` creates；`runTargetedAgent` resolves exact instance |
| Conversation/session | external current authority | Eidolon Agent runtime | workflow only stores opaque instance/session reference |
| E2E receipt | historical/derived evidence | testkit receipt projection | records/observes，不参与 live decision |

ReactiveDataGraphProfile 被明确激活：node 端口、generation、依赖边、dynamic add/update/remove、失效传播、恢复、终止和预算都必须可观察并测试。ControlDecision 只能通过 owner command 改变 graph，禁止 projection backwrite。

## 控制侧组件

- **Data**：`AutonomousControlGoal`、`ControlObservation`、`ControlDecision`、`AdmittedGraphPatch`、`ControlIterationReceipt`，全部是封闭、可序列化、带 schema version 的数据。
- **Effect**：provider Agent execution、workspace/tool effects、GraphPatch transition、checkpoint persistence。
- **Processor**：
  - Observation projector：从 canonical checkpoint、node results、verifier report 投影控制输入。
  - Decision validator/admitter：校验 generation、闭合 node tag、typed ports、allowed code/Agent refs、DAG、预算和 patch uniqueness。
  - Control-loop driver：调度 controller、应用 admitted patch、推进 graph、再次观察；不拥有 graph 副本。
- **Actor**：
  - resource-managed ControllerAgent：只根据 typed observation 提出下一步。
  - resource-managed WorkerAgent：执行动态任务；跨 generation 通过 exact selector 复用。
  - runtime owner：以 command/message 边界协调 provider/tool/human 等异步过程。

所有核心逻辑保持 `output = fn(runtime, input, config)`；模型输出先成为 Data，再由 Processor 决定是否可转为 Effect。

## 预制 Agent 与类型化数据流

ControllerAgent 和 WorkerAgent 均由 Halfcode ResourcePackage 提供：

- `MessagePrefix` 组合稳定 kernel、角色和 workspace instructions。
- `ContextPipeline` 复用成熟 Eidolon history/context/provider 处理链。
- Input/Output schema 是 frozen dependency，进入 run semantic identity。
- Controller 工具面只允许读取本 run 的 canonical observation 与提交 typed decision；不得直接访问 checkpoint 文件。
- Worker 工具面按任务 Effect policy 精确投影。

初始 AI Data graph 只声明 bootstrap、observe、control 和 terminal barrier，不携带业务解法。Controller 可以从一个封闭 node catalog 选择 add/update/remove operation；动态 node 必须引用已冻结的 node implementation 或 Agent task proof。

## 自主反馈循环

```text
@delimiter: --
@node: #
@marker: ?
-- #loop ?autonomous_control until="unchanged verifier satisfied or bounded terminal failure"
---- #step ?observe
从 canonical checkpoint、当前 generation node results 和 immutable verifier 生成 typed ControlObservation。
---- /?observe
---- #step ?plan
首次用 runAgent 创建具名 ControllerAgent；后续用 runTargetedAgent 复用 exact instance，让其输出 typed ControlDecision。
---- /?plan
---- #switch ?decision on="validated ControlDecision"
------ #case ?converged when="verifier satisfied and terminal contract complete"
-------- #return ?success value="seal completion receipt"
-------- /?success
------ /?converged
------ #case ?patch when="decision contains an admissible minimal graph change"
-------- #step ?admit
校验 generation、DAG、typed ports、resource/code refs、Effect policy、budget 和 patch uniqueness。
-------- /?admit
-------- #step ?apply
通过 canonical GraphPatch transition 改变 graph；推进 ready frontier。新 worker 用 runAgent，已有 worker 用 runTargetedAgent。
-------- /?apply
-------- #continue ?feedback
重新进入 observation；不得沿用旧 generation observation。
-------- /?feedback
------ /?patch
------ #case ?invalid when="decision/schema/patch 不合法或没有事实进展"
-------- #step ?feedback_error
把结构化 admission error 作为下一轮 observation；不修改 graph。
-------- /?feedback_error
-------- #continue ?repair_decision
在剩余 iteration/token/deadline 预算内让同一 ControllerAgent 纠偏。
-------- /?repair_decision
------ /?invalid
------ #case ?bounded_failure when="预算耗尽、deadline、abort 或重复无进展"
-------- #fail ?stop value="preserve checkpoint and complete failure evidence"
-------- /?stop
------ /?bounded_failure
---- /?decision
-- /?autonomous_control
```

## E2E 命题

至少维护两个不共享修复答案的命题：

1. **从目标生成工作图**：初始图没有 implementation/verification 解法；Controller 选择 frozen catalog 节点、连接 typed ports、运行 Worker 并收敛。
2. **黑盒反馈二次纠偏**：generation 1 的结果通过结构校验但被隐藏行为 verifier 拒绝；Controller 必须读取 typed failure observation，形成不同的 generation 2 patch，并复用既有 Agent instance 完成修复。

其中一个运行在 generation 之间销毁并恢复 runtime，证明 checkpoint 与 opaque Agent reference 足以继续，不依赖内存对象或测试 harness 私有状态。

## 禁止捷径

- fixture 中出现 expected patch、repairIntent、目标实现片段或模型专用答案。
- controller implementation 依据 proposition id/node id 分支。
- 把模型文本直接 cast 成 GraphPatch。
- 新建第二份 graph/control state store。
- 通过相同 AgentDefinition 新建多个实例冒充 instance reuse。
- 将 deterministic scripted provider 的成功替代 live provider 自主证据。

## 受控重规划

Mission 在每次 live run 后比较 desired 与 actual：

- schema/admission 缺口 → 修订 control-contract Track 或新增最小 repair Track。
- Agent reuse 丢失 → 修复 instance selector/host binding，不以 prompt 指令掩盖。
- 模型提出无效/过大 patch → 改进 typed observation、closed catalog 或 validator feedback；不把 expected patch 写入 prompt。
- 无进展或成本异常 → 优先增加观测和收窄单轮 decision contract，再调整 budget。
- E2E 暴露通用 depa-flows 问题时在 external project 创建 Track；Eidolon binding/provider 问题留在 host Track。

每次修订写入 `reports/replan-XXX.md`，并重新严格校验 Mission。
