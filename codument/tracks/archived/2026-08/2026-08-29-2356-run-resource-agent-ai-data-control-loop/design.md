# Design：Resource Agent AI Data Control Loop

## 1. 设计边界

本 Track 把 G2 的闭合控制协议接入 Eidolon 已有 AI Data runtime。它必须保留三条已经成熟的 authority 链：

1. `AIDataWorkflowRunGraph + AIWorkflowFlowRunCheckpoint` 是 graph/generation/recovery 唯一真源。
2. `checkpoint.profile.ai` 是 Agent instance/index/invocation receipt 唯一真源；Eidolon Agent runtime 仍拥有 Conversation/session。
3. `EidolonWorkflowEffectProvider` 是 provider/tool effect 的既有入口；控制环不得复制其 dispatch/recovery 逻辑。

模型输出仅是 `AIDataControlDecision`。只有 G2 `admitAIDataControlDecision` 产生的 admission 才可作为 canonical transition 输入。

## 2. 现有代码到目标 Halfcode/DEPA 链路的映射

| 现有位置 | 当前责任 | 本 Track 映射 | 禁止的替代实现 |
| --- | --- | --- | --- |
| `AIDataWorkflowRuntimeDriver.start/advance/applyNode/persist/statusValue` | 构造 checkpoint、推进图、执行节点、持久化 | driver 继续拥有 graph projection；新增显式 control state、barrier 和一个原子 `commitControlTransition` | controller 自己保存 graph；先 `applyPatch` 后另存 receipt |
| `WorkflowRuntimeService.createDataDriver/loadDataDriver/applyGraphPatch` | 创建/恢复 driver 与公开 patch surface | 创建时冻结 autonomous control binding；恢复时只从 checkpoint 重建；自主环走受限 control command | tool 直接写 sidecar；从 event replay 拼第二份状态 |
| `WorkflowRuntimeService.discoverAgentTasks/frozenAgentTaskProofs` | 冻结初始定义中的 Agent task proof | 静态 proof 继续保留；动态 capability 使用 frozen snapshot 中的 exact `taskProofRef` | 从最新 registry 重新解析或仅按 AgentDefinition 名称猜测 |
| `EidolonAppResourceRegistryAdapter.listWorkflowAgentTasks/freezeWorkflowAgentTaskBinding` | 从 ResourcePackage 冻结 AIAgentDefinition task | 增加 proof-ref 精确读取与 tuple 校验，产出既有 `AIAgentNodeTaskBinding` | 扫描 workspace 最新资源或接受未证明的 dynamic node |
| `EidolonWorkflowEffectProvider.runAgent/runTargetedAgent` | 调用 Eidolon Agent actor 并记录 effect/recovery evidence | 原样复用；控制环只决定 new/targeted 与 invocationKey | 自建 provider SDK loop、复制 Conversation、重做 retry |
| `ai-workflow-logic.bindAIAgentProcessors` | durable Agent state、selector 与 effect idempotency | 每个动态 node/control turn 绑定当前 checkpoint；first new，later exact `{byId}` | target 失败后 fallback new；把 effect replay 当 instance reuse |
| G2 `projectAIDataControlObservation/admitAIDataControlDecision` | provider-neutral observation/admission | 直接从发布包消费，作为 control Processor | 在 host 复制 schema 或 proposition-specific 分支 |

因此，AIAgentDefinition 的 `MessagePrefix + ContextPipeline` 仍由已冻结 ResourcePackage 与既有 Agent execution 链处理。本 Track 不另造消息管线，只把 Controller/Worker 作为 typed dynamic dataflow node 调用。

## 3. Canonical checkpoint control state

冻结定义必须在 protected control step 上显式声明
`ExtensionRef(kind="eidolon.ai-data-autonomous-control", schema="schema://eidolon.ai-data-autonomous-control/v1")`。
`checkpoint.stepExtensions.byStepId[controlNodeId]["eidolon.ai-data-autonomous-control"]` 是控制状态的唯一持久化位置，闭合形态为：

```ts
type AIDataAutonomousControlState = {
  schemaVersion: "eidolon.ai-data-autonomous-control/v1"
  controlNodeId: string
  goalDigest: string
  catalogDigest: string
  verifierDigest: string
  phase: "observing" | "planning" | "admitting" | "executing" | "verifying" | "completed" | "failed"
  iteration: number
  noProgressCount: number
  latestObservation?: AIDataControlObservation
  latestVerifier?: HostVerifierReport
  feedback: AIDataControlFeedback[]
  receipts: AIDataControlIterationReceipt[]
  terminal?: { kind: "complete" | "failed"; code: string }
}
```

`goal/catalog/controlNodeId/controller binding` 由 ExtensionRef 的资源闭包在 definition capture 时冻结并进入 semantic identity；每轮 verifier fact 是 host-owned checkpoint revision fact。event store 只记录审计事件；恢复直接读取 checkpoint。`profile.ai` 仍与 extension fact 同 checkpoint 保存，但不把 instance 状态复制进 autonomousControl。`controllerSidecars` 保持为 RunGraph status 的严格派生投影，不承载自定义状态。

### 原子 transition

`commitControlTransition(expectedVersion, admittedDecision, verifierReport, nextControlState)` 在 driver 所有权内完成：

1. 校验 expected checkpoint/generation、control binding 和 host verifier identity。
2. 对 `revise` admission 在临时 graph projection 上应用 patch；对 `complete` 校验当前 verifier PASS；对 `fail` 记录受控终止。
3. 同时生成 next graph/checkpoint、control state 与 receipt。
4. 通过既有 checkpoint store 的一个 compare-and-swap 写入提交。
5. 成功后才更新内存 projection 并发出 audit event。

crash 发生在提交前时，恢复得到旧 graph/旧 cursor；提交后时得到新 graph/新 cursor。不存在“patch 已生效但 receipt 未记录”或相反的 authority split。

## 4. Protected control barrier

bootstrap definition 显式冻结 `controlNodeId`。该节点是 host-protected manual node：

- 普通 `advance()` 只可令其进入/保持 `Waiting`，不得通过普通 resolve 或 graph patch 完成。
- patch admission 禁止 update/remove/rename control node，也禁止改变其 contract。
- graph 的其他节点全部成功时，只要 barrier 未释放，run 仍是 `Waiting`，不是 `Completed`。
- 只有 `complete` admission、匹配当前 generation 的 immutable host verifier `PASS`、未耗尽预算且 transition 成功时，driver 在同一 commit 中把 barrier 置为 succeeded。
- verifier 是 host 注入的 typed port，binding/digest 随 run 冻结；Controller 只能看到 report，不能生成权威 PASS。

## 5. Dynamic Agent proof resolution

G2 admitted agent capability 的 implementation 为：

```ts
config.agent = { agentDefinitionRef, taskProofRef }
```

driver 遇到该形态时调用 frozen proof resolver，而不是寻找 `src/impl`：

1. `taskProofRef` 必须解析到 run 的 frozen MaterialBinding snapshot。
2. binding 的 workflow kind/ref、nodeId、agentDefinitionRef 必须与当前 run、dynamic node 和 admitted capability 完全一致。
3. input/output contracts 和 Effect policy 来自该 frozen binding，不跟随 registry latest。
4. 任一缺失/不匹配在 `runAgent` 前 fail closed；canonical graph/checkpoint 不变，仅返回明确 host invariant error。

这样动态节点复用了 Halfcode ResourcePackage 的 MessagePrefix、ContextPipeline、workspace instructions 与 schema，而不是在 GraphPatch 里携带 prompt。

## 6. Agent reuse state machine

Controller 和 Worker 均使用稳定 `instanceName`，其生命周期由 `checkpoint.profile.ai` 决定：

```text
name 未登记 -> runAgent(instanceName) -> durable instance/index/receipt
name 已登记且 reciprocal instance 有效 -> runTargetedAgent({ byId: exactId })
name/index/instance/AgentDefinition 任一不一致 -> fail closed
```

- 不使用 `{byName}` 作为最终 dispatch selector，以便调用前显式校验 reciprocal index并把 exact id 写入 evidence。
- 每个 control iteration/node generation 使用新的 semantic `invocationKey`；同一 key 重放由既有 effect receipt 恢复。
- invocation recovery 和 instance reuse 是两件事：前者允许同一 effect 幂等恢复，后者要求跨不同 iteration/generation 的新 invocation 都命中同一 instance id/session id。
- targeted dispatch 失败不允许 fallback new；错误作为 runtime failure 或可恢复 provider effect 保留。

## 7. Autonomous loop Processor

新增小型 `AIDataAutonomousControlLoop`，只保存依赖，不保存 graph：

```text
reload canonical checkpoint
  -> run host verifier over current typed outputs
  -> projectAIDataControlObservation
  -> create-or-target ControllerAgent with typed observation
  -> normalize/validate AIDataControlDecision
  -> admitAIDataControlDecision
  -> commitControlTransition (revise / complete / fail / rejected-feedback)
  -> driver.advance ready frontier
  -> repeat within budget
```

每轮开始重新读取 canonical checkpoint，拒绝 stale decision。控制 Agent 输出解析错误、闭合 schema 错误和 admission rejection 转为有界 `INVALID_DECISION` feedback；checkpoint/CAS、proof、verifier identity、protected node等 host invariant 错误必须抛出，不得包装成让模型重试的普通反馈。

`rejected-feedback` 不修改 graph/generation，但原子增加 iteration/feedback/receipt，以支持 crash-safe bounded retry。`noProgressCount`、iteration、deadline/token budget 都由 host 检查，模型不能放大。

## 8. 测试策略

P1 先写 RED cases：

1. 普通图节点完成但 control barrier 仍 Waiting。
2. dynamic agent proof 成功执行；missing/tampered proof 在 effect 前拒绝。
3. admitted complete + stale/FAIL verifier 不释放 barrier。
4. invalid/stale decision 仅增加 feedback，graph digest/generation 不变。
5. patch commit 前/后注入 crash，fresh runtime 观察到完整 before/after 状态。
6. Controller/Worker 分别证明 new、targeted、fresh-runtime targeted；索引损坏不 fallback。
7. host invariant error 不被转成 `INVALID_DECISION`。
8. source scan 禁止 controller-owned graph、tool-owned patch、proposition id branch、fallback create。

G3 的 deterministic fixtures 只验证 mechanics，不携带真实问题的 expected patch。G4 再构建 anti-cheat autonomous proposition harness，G5 才运行 iQingwa DeepSeek V4 Pro。

## 9. 失败与恢复

- provider 的 transient/reasoning-only 行为继续由既有 Agent runtime/Effect provider 处理；control loop 不设置次数型 DeepSeek workaround。
- admission rejection 是可观测控制反馈；budget 耗尽形成 typed failed terminal，但不损坏 graph。
- CAS conflict 重新读取 checkpoint 并基于新 observation 开始新轮，旧 decision 不复用。
- frozen Agent proof 或 instance index 损坏属于 authority/invariant failure，保留 checkpoint 后停止。
- verifier 实现抛错属于 host failure，不伪装成未通过的业务报告。
