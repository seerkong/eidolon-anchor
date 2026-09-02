# Track：退役 VM autonomous Holon TaskTree runtime

## 目标

以已经落地的 File-XNL organization snapshot、`HolonExecutionBinding`、canonical TaskSpace、`HolonTaskSpaceCoordinatorActor` 和通用 `MemberRuntime` 为唯一 autonomous Holon 执行路径。保留 Holon 的治理模型与 `HolonAssign`/`ActorAssign` 产品语义，但删除 VM 内 task board、TaskTree scope routing、专属 lane/workload、envelope、completion signal 和旧 runner/controller。

## 为什么现在做

G5 已证明 AI Ctrl 与 AI Data 的 Holon task 能在不调用逐任务 `holon-process` 的情况下，由可恢复 pump 自动 claim、dispatch、settle 并回流到父 Flow。旧 VM 路径仍拥有另一套 task status、ownership 与 completion 事实；即使目前用 retirement receipt 阻止部分双写，它仍是可执行兼容退路，并且继续污染 actor、snapshot、event 和 tool 语义。

## 范围

- 将 `HolonAssign` 与 `ActorAssign` 的 autonomous 分支改为 canonical assignment facade；只有能解析 frozen execution binding / workflow task context 的请求才可提交，缺少 authority 时明确失败，绝不回退 VM task board。
- 保留一般 `TaskTreeRead`/`TaskTreeWrite`、普通 member lane/workload、Holon 的 governance/member/watch 投影和 leader-led 行为；它们不是本 Track 的删除目标。
- 删除 autonomous 专属 `TaskTree activeForm` 路由、`autonomous_holon` lane、`autonomous_holon_task` workload、VM task state、task envelope、waiter signal、claim/idle event API 和旧 orchestration-history stream。
- 将旧 runner 的有效行为逐项映射到 canonical TaskSpace/Coordinator/MemberRuntime 测试后再删除源文件与旧测试；不以直接删测试冒充 parity。
- 不引入 GoalGraph、动态 Capability Catalog、第二套组织图或 VM compatibility writer。

## 非目标

- 不在本 Track 深化 Capability Catalog 的 Halfcode 化。
- 不重构 leader-led Holon 的 route/backflow 协议。
- 不删除一般 TaskTree 或一般 member/detached runtime。
- 不承诺直接恢复旧 autonomous task board；历史格式若保留解析，只能形成显式只读审计结果，不能重新驱动任务。

## 完成判据

1. AI Ctrl/Data Holon 节点和产品 autonomous assign 都只经 canonical TaskSpace authority；缺少 frozen binding 时 fail closed。
2. claim eligibility、roster/policy selection、single claim、dispatch、final/none/stream 投影、idle/lease、settlement、failure 与 fresh recovery 均有 canonical parity 证据。
3. 产品源码中旧 runner/controller/envelope/signal/special lane/workload/event/TaskTree Holon route 静态引用为零。
4. `AutonomousHolonTaskRunner.ts`、`AutonomousHolonController.ts`、`autonomousHolonEnvelope.ts` 和 `_autonomousHolonAssignCore.ts` 被删除，相关测试已迁移到 canonical suites。
5. fresh AttractorCheck 与 focused/full regression 通过；任何保留的 legacy decoder 都明确只读且无法进入执行路径。
