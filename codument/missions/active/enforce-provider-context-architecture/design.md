# Design：enforce-provider-context-architecture

## Mission 控制目标

Mission 的 desired state 是一组带依赖的 provider-context architecture tracks；actual state 来自代码、类型、架构 conformance tests、Responses request observation、checkpoint facts、rewind session evidence 和历史回归 session。Mission 只负责按 DAG 创建/执行/验证 tracks，不复制 track 的实现细节。

## Authority 分层

```text
ConversationAuthority
  -> CanonicalConversationHistory
  -> ProviderProjectionCompiler
       -> OpenAIChatWireCompiler
       -> OpenAIResponsesCanonicalReplayCompiler
  -> ProviderProjectionCoverageGate
  -> ProviderOptimization
       -> ResponsesCheckpointPlanner
```

- `ConversationAuthority` 是唯一事实源。
- `ProviderProjectionCompiler` 是无损 provider-specific 投影层。
- `ProviderProjectionCoverageGate` 是发送前 processor gate。
- `ResponsesCheckpointPlanner` 只能选择 canonical projection 的增量，不得自行组装 provider context。

## 强制设计规则

1. `openai-chat` projection 不得被 `openai-responses` projection import。
2. provider projection 不得返回无证明的裸 `any[]`；必须返回 typed projection + receipt。
3. 所有 repair/drop 必须带显式 reason；Responses 不允许使用 Chat 的 `unpaired_tool_call` drop reason。
4. canonical replay 必须完整遍历历史中的所有 assistant function calls 和 matching outputs，不得只扫描 trailing tool messages 或 latest assistant call。
5. checkpoint 使用必须满足 semantic equivalence proof；checkpoint 失效时必须调用同一个 canonical compiler。
6. rewind/fork/history head movement 必须推进 context epoch，并使 checkpoint/baseline 失效。
7. full runtime snapshot 继续只在 safepoint 写入；closed conversation progress 继续使用已有 sealed-progress/recovery authority。

## Track DAG

1. `inventory-provider-context-authority`：盘点现有 projection、checkpoint、rewind、send gate 和真实 session 证据，形成可执行 contract。
2. `repair-responses-canonical-replay`：修复完整历史 replay、frontier 稳定性和 rewind 后 canonical rebuild。
3. `separate-provider-projection-contracts`：建立 typed projection、明确目录/类/函数命名和 Chat/Responses import boundary。
4. `add-provider-projection-coverage-gate`：增加 coverage proof、显式 drop receipt 和 send-before fail-closed gate。
5. `bind-rewind-context-epoch`：把 rewind/fork/history-head movement 与 Responses checkpoint invalidation、checkpoint equivalence 绑定。
6. `verify-provider-context-architecture`：加入架构 lint、property tests、长工具轮次、compaction、恢复和历史 session 验证。

其中 1 完成后才能开始 2；2 和 3 可在 contract 收敛后顺序执行；4/5 依赖 2、3；6 依赖全部前置 tracks。

## 受控重规划条件

- 真实 session 证明问题来自 History sealing/recovery，而非 provider projection：增加一个 recovery track，保留现有 projection tracks。
- provider native replay 与 Chat projection 无法共享任何 contract：保留完全独立的 typed protocol packages，不强行抽公共 adapter。
- checkpoint equivalence 证明需要调整 canonical history schema：先创建 decisions/replan report，再拆分新的 schema track。
- 任一 track 发现会削弱 safepoint-only snapshot：停止该 track，标记 blocked 并要求重新决策。

## G6：provider tool-schema projection 与 request admission

```text
Canonical ToolDefs
  -> configured ProviderDriver
  -> provider-specific ToolSchemaProjectionAuthority（每次 provider call 一次）
  -> concrete transport body materialization（每个 transport attempt）
  -> schema-fact coverage + body readback
  -> opaque AdmittedProviderRequest
  -> request observation + transport effect
```

- OpenAI Chat、DeepSeek Chat 与 OpenAI Responses 各自拥有独立 projector；generic fetch 不推断 provider policy。
- canonical 与 emitted schema 都规范化为 `kind/path/valueDigest` facts；exact 或 versioned compatible transformation 必须完整覆盖。
- Tool-schema projection authority 在 provider call prepare 阶段产生一次并跨 retry/transport attempt 复用。
- 每个实际 HTTP/WebSocket body 在具体 transport attempt 中独立 admission，因为 Responses fallback、continuation 与 transport mode 可产生不同 body。
- Coverage gate 是 opaque admitted capability 的唯一 factory；capability 绑定 defensive-copied serialized bytes 与 body digest，effect 只发送该固定字节。
- 现有最终 wire request observation 保持不变；新增 bounded coverage receipt metadata，不以本 Track 删除或隐藏既有 requestBody/messages/tools authority。
