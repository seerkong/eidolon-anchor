# Design：Autonomous AI Data Planning E2E

## 1. 证据分层

本 Track 只建立 deterministic mechanics 证据和防伪边界，不提前宣称 live autonomy：

| evidence class | 能证明 | 不能证明 |
| --- | --- | --- |
| `deterministic-mechanics/v1` | runtime 的 observation、typed decision、admission、canonical patch、Worker execution、verifier、recovery、Agent reuse 机制正确 | DeepSeek 会自主理解任意 goal 并产生正确计划 |
| `live-provider/v1` | 指定 provider/model 在无 harness answer 的 proposition 中实际自主收敛 | 由 G5 产生，本 Track 不伪造 |

sealed verifier 在检查 Mission live gate 时必须拒绝 `deterministic-mechanics/v1`。

## 2. 输入与 authority

`AutonomousPlanningProposition` 是闭合数据，只允许：

- `goal` 与稳定 goal digest；
- immutable verifier identity/digest 和 host-owned evaluator；
- initial typed data；
- frozen capability catalog、ResourcePackage proof refs、Controller/Worker refs；
- deadline、iteration/generation/no-progress/token/cost budgets；
- 可选的 crash boundary 和 invalid-output fault 注入，仅用于证明恢复/feedback，不携带成功答案。

禁止字段包括 expected patch、repair intent、expected node id、expected implementation fragment、verifier answer。成功路径只允许通过 `WorkflowRuntimeService.runAutonomousControl` 进入 canonical control loop。

## 3. Proposition-neutral planner seam

deterministic planner 是 observation/catalog 到 `AIDataControlDecision` 的通用闭合函数：它可以理解 control protocol 的 operation kind，但不得读取 proposition id/name，不得包含业务节点或 expected patch 常量，也不得调用 graph mutation API。它的输出仍需经过与 live model 完全相同的 parse、normalize、admit、commit 链路。

测试通过重命名/重排 proposition、替换 hidden failure facts 和 source scan 证明其只依赖 observation 与 catalog。G5 将同一 seam 换成真实 resource Controller provider，不改 harness authority。

## 4. 两代纠偏场景

bootstrap graph 只有 initial fact、protected control barrier 和 Return 边界，不携带修复计划：

1. observation 0 表明目标尚未实现；Controller 从 frozen catalog 选择一个 Worker capability，产生 patch A。
2. Worker 执行后，immutable verifier 返回结构化 failure facts；Controller 基于新 observation 产生与 A digest 不同的 patch B。
3. 至少一次 controller output 被 fault seam 破坏为 invalid decision；admission 记录 `INVALID_DECISION`，iteration 增长但 graph digest/generation 不变。
4. patch B 后 Worker 通过 exact targeted Agent instance 执行，verifier PASS；Controller 才能提出 complete 并释放 protected barrier。

测试断言 patch causality 来自 receipt 中的 observation digest → raw decision digest → admission → patch digest 链，而不是仅断言最终值。

## 5. Recovery 与 Agent continuity

patch A 提交并完成第一次 Worker invocation 后，保存完整 canonical checkpoint/material facts，销毁 runtime/service，构造 fresh runtime：

- graph/control/profile 均只从 checkpoint 恢复；
- Controller 后续轮通过 `{byId: exactId}` 调用；
- 被再次执行的 Worker 通过同一 exact instance id 调用；
- sessionId 必须和外部 effect receipt 一致；
- missing/corrupt reciprocal index 或 targeted failure 直接 fail closed，不可 fallback new。

测试 harness 不保留 private patch cursor；恢复后的下一步完全由 checkpoint observation 决定。

## 6. Sealed receipt

`AutonomousPlanningSealedReceipt/v1` 包含：

- evidence class、provider/model、workflow/definition/run ids；
- goal/verifier/resource/executable source digests；
- 每 generation 的 observation、verifier、raw decision、normalization、admission、patch history/frontier/invalidation digest；
- 每次 Controller/Worker invocation 的 mode、definition ref、instanceId、instanceName、sessionId、generation、invocationKey；
- invalid feedback、budget、provider usage/failure/replay、prefix integrity；
- final outcome 和覆盖以上 canonical serialization 的 receipt digest。

seal/verify 都使用稳定 key ordering 与 SHA-256。验证器重新计算子 digest 和总 digest，并执行跨字段 invariant；它不信任 receipt 自带的 `reused=true` 或 `passed=true` 布尔值。

## 7. Source conformance

扫描范围为 fixture ResourcePackage、harness、planner seam 和 receipt builder。规则至少禁止：

- proposition id/name、known expected patch/node/capability answer 出现在 planner/harness executable source；
- `repairIntent`、`expectedPatch`、`applyGraphPatch`/`resumeDataNode` 直达成功路径；
- `shadowGraph`、独立 graph store 或从 events 重建第二 authority；
- targeted 失败后 `runAgent` fallback；
- deterministic evidence 被标记成 live provider。

负向测试通过注入每一类违规 source/receipt，要求返回 typed conformance diagnostics，而不是字符串快照碰巧失败。

## 8. 与既有实现映射

| 既有链路 | G4 使用方式 |
| --- | --- |
| `AIDataAutonomousControlRunner` | 唯一的 observe-plan-admit-commit 调度入口 |
| `AIDataAutonomousControlLoop` | 唯一 control state/graph atomic transition authority |
| `AIDataWorkflowRuntimeDriver` | Worker frozen proof dispatch 与 canonical checkpoint 恢复 |
| `WorkflowRuntimeService` | 创建/恢复 run 并调用 `runAutonomousControl` |
| `EidolonAppResourceRegistryAdapter` | 冻结并恢复 exact Controller/Worker task proof |
| `EidolonWorkflowEffectProvider` | `new`/`targeted` external Agent effect 与 session evidence |

G4 不复制这些实现；fixture 只实现 host verifier、provider effect double 和 evidence observer。

## 9. 验证顺序

1. RED：answer-bearing fixture、direct patch bypass、fallback creation、fake live receipt、tampered receipt 必须失败。
2. GREEN：运行两代 patch、invalid feedback、mid-loop recovery、exact reuse、unchanged verifier convergence。
3. 运行 source conformance、sealed receipt verify、focused regression、focused typecheck 和 strict Codument validate。
4. 归档后只把稳定行为提升到 `ai-data-workflow`；provider/model 真实性要求继续留给 Mission G5。
