# 设计：AI Turn / Tool / Provider Lifecycle 主干

## 上下文

spine track（P7+P8）把 conversation 三域、commit pipeline、actor.messages 投影做硬；ToolExecutionGateDecision ADT 已建立类型化 gate 决策风格。剩余的运行时事实——turn state、tool lifecycle、provider call 元数据——仍隐式分散于 `AiAgentExecutor.ts`（5221 行单文件）、runtime-control effect evidence 与 PromptPlanData 中。本 track 把这三组事实结构化、收归各自 owner，并据此安全退役 `AiRuntimeTurnSupervisor`。

## 方案概览

### 1. TurnState ADT（核心抽象）

```text
TurnState =
  | Drain
  | StartLlm        { reason: "fresh" | "tool_continuation" | "compress_followup" }
  | WaitLlm         { opId: string, providerCallId: ProviderCallId }
  | StartTool       { toolCallId: string, funcName: string, args: any }
  | WaitTool        { opId: string, toolCallId: string, funcName: string,
                      gateDecision: ToolExecutionGateDecision }
  | WaitQuestionnaire { opId: string, toolCallId: string, questionnaireId: string }
  | WaitCompress    { opId: string, reason: CompressionTrigger }
  | WaitHuman       { reason: "clarification" | "approval" | "answer" }
  | Completed       { stopReason: AgentLoopStopReason }
  | Failed          { error: string }
```

- 每个 variant 自带本阶段必要字段；无跨 variant 字段。
- `turnReducer: (TurnState, TurnEvent) => { state: TurnState, effects: TurnEffect[] }` 是纯函数，与 depa-actor reducer 同构。
- TurnEvent 来自 mailbox（asyncCompletion / control / toolResult / humanInput / memberChat...）以及 LLM 流事件（通过 vm.eventBus）。
- TurnEffect 由 outer runtime 执行（startLlmCall / dispatchTool / emitSemantic / commitEvidence / sendChildDone 等）。

### 2. 统一主循环

```text
旧形态：
  aiAgentLoopStreaming   →  ToolCallPipelineHandler / ToolOutputDispatchHandler 链
  aiAgentCooperativeStep →  phase machine + asyncCompletion mailbox

新形态：
  runTurn(runtime, actor, input)
    └─ 内部：
         while !terminal(state):
           event = await nextEvent(runtime, actor, state)
           { state, effects } = turnReducer(state, event)
           for eff in effects: dispatchEffect(runtime, actor, eff)
       return projectStopReason(state)

  aiAgentLoopStreaming    →  runTurn 的 thin wrapper（mailbox = vm.controlActor）
  aiAgentCooperativeStep  →  runTurn 的 thin wrapper（mailbox = 注入的 fiber actor）
```

- TurnEvent 来源统一：mailbox drain + vm.eventBus（semantic 流）+ async completion → 同一 reducer 入口。
- nextEvent 是异步信号选择器，对应 depa-actor selective receive。
- streaming 与 cooperative 的差别只剩"mailbox owner"，不再有逻辑分叉。

### 3. ToolCallDomain runtime（事实接管）

数据形态：

```text
ToolCallDomain (per-vm runtime data) = Map<tool_call_id, ToolCallRecord>

ToolCallRecord = {
  toolCallId: string                    // LLM 透明 ID
  actorKey: string
  turnId: TurnId
  funcName: string
  args: any
  plannedAt: number
  dispatchedAt?: number
  gateDecision?: ToolExecutionGateDecision
  executedAt?: number                   // 仅 gateDecision.kind === "allow" 时填
  resultAt?: number
  outputText?: string
  failureKind?: ToolFailureKind          // 见决策 6
  status: "planned" | "dispatched" | "denied" | "deferred" | "executing" | "completed" | "failed"
}
```

- ToolCallDomain 由 `vm.runtimeContext.toolCallDomain` 持有；新 contract 在 `ai-core-contract/src/runtime/ToolCallDomain.ts`。
- 写入入口集中（commands）：`planTool`、`recordGateDecision`、`markExecuting`、`recordResult`、`recordFailure`。
- 重复 toolCallId 的二次 result 被拒绝（数据层 invariant）。
- runtime-control effect evidence 改为 link only：`{ effectId, handlerKey, toolCallId }`，不再持 outputText / args 全文。
- 恢复时从 ToolCallDomain 重建 tool result（而非从 effect evidence 重建）。

### 4. ProviderCallDomain runtime（元数据归位）

```text
ProviderCallDomain = Map<provider_call_id, ProviderCallRecord>

ProviderCallRecord = {
  providerCallId: ProviderCallId        // 与 state.inflight (WaitLlm.opId) 一一对应
  actorKey: string
  turnId: TurnId
  modelRef: string
  modelParams: { temperature?, topP?, maxTokens?, ... }
  toolSchemas: ToolSchemaSnapshot[]      // hash 形式存档
  promptGenerationRef: PromptGenerationId // 已存 LLM Context Domain
  startedAt: number
  firstTokenAt?: number
  completedAt?: number
  reasoning?: { text: string, segments: { startAt, endAt, text }[] }
  content?:   { text: string, segments: { startAt, endAt, text }[] }
  toolCallIds?: string[]                 // 本次 provider 调用产出的 tool call ids
  failureKind?: ProviderFailureKind
  rawError?: string
}
```

- `buildProviderPromptForActorTurn` 完成时写入 ProviderCallRecord（startedAt + 元数据）。
- processStreamFn 中 reasoning 段与 content 段分别 append（按 emittedAt 累积 segments）。
- TUI think card / observability 改为读 ProviderCallRecord.reasoning，不再依赖 content_parts 隐式约定。
- MessageAssembly 仍可保留 content_parts 派生（兼容 Anthropic adapter 写入习惯），但读取入口都改 ProviderCallRecord。

### 5. AiRuntimeTurnSupervisor 退役

删除清单（精确）：

- `cell/packages/ai-organ-logic/src/runtime/AiRuntimeTurnSupervisor.ts` —— 文件本体
- `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts:1243-1281` —— continuation 循环（依分析 D 块定位）
- `cell/packages/ai-organ-logic/src/index.ts` —— supervisor 导出
- exec surface 中所有 supervisor warning 回调消费点（findings.md D 块列出）
- 相关单元测试（findings.md D 块列出）

退役安全性论证（依赖本 track 其它工作完成）：

- "重复读文件"的根因是 ToolCallDomain 没真源持有 tool_call_id 与 result，导致同一 tool 重复发出。本 track ToolCallDomain 的 `重复 toolCallId 拒绝` invariant 从根因消除；supervisor 的 hint 不再有意义。
- TurnState ADT 让 phase 与 inflight 不可能跨 variant 不一致，"半步状态落盘 / 错位重放"类问题在编译期被堵。
- ProviderCallRecord 让"哪次 provider 请求产出了哪些 tool calls"成为查询而非推断，"pending bash effect"在事实层有 owner。

### 6. 一致性测试与等价闸门

- **TurnState ADT 形态测试**：每个 variant 构造 / 转换 / 序列化往返；reducer 对每个 (state, event) 组合的 effect 集合做断言。
- **统一主循环行为等价 harness**：spine track 已存在 providerEquivalenceHarness。本 track 扩展该 harness 覆盖更多场景（tool defer/approve、provider failure、reasoning 单独投影、supervisor 移除前后路径无新增 turn 序列差异）；streaming 入口与 cooperative 入口产出的 `(providerMessages 序列, turn 转换序列, ToolCallDomain 状态)` 三元组逐元素等价。
- **ToolCallDomain invariant 测试**：planned → dispatched → (denied | deferred | executing → completed/failed) 状态机覆盖；重复 toolCallId 拒绝；evidence payload 不含全文 outputText。
- **ProviderCallRecord 完整性测试**：每次 provider 调用后 record 存在且字段齐全；reasoning/content segments 完整还原。
- **回归基线对照**：cell + terminal 全套，按 spine track 同样方法对照按名比对。

## 影响范围与修改点（Impact）

见 proposal.md。核心是 `AiAgentExecutor.ts` 5221 行单文件的 turnReducer 抽取 + 双主循环合并，以及 ai-core-contract 增加 ToolCallDomain / ProviderCallDomain runtime data contracts。

## 决策摘要

- 详见 `decisions.md`。关键结论：
  - D1（accepted）：本 track 直接删除 supervisor，不引入替代 guardrail。
  - D2（accepted）：TurnState 为 ADT discriminated union。
  - D3（accepted）：tool_call_id 用 LLM 透明 ID 配对；evidence 退回 audit/link only。
  - D4（accepted）：本 track 合并主循环（streaming 退化为 cooperative phase machine 薄包装）。
  - D5/D6/D7 进入 design/plan 阶段后由用户最终评审确认（reasoning_content 分离 / failureKind 枚举 / turnReducer 注入位置）。

## 风险 / 权衡

- **风险**：合并主循环 + supervisor 删除两个动作叠加，5221 行单文件重构 + live turn 主路径行为变更，回归面巨大。
  - 缓解：分阶段实施——P1 先抽 TurnState ADT + turnReducer 作为纯函数（可单元测试覆盖）；P2 在不删 streaming 旧 path 的前提下，让 cooperative 走 turnReducer（双路径并存）；P3 行为等价 harness 通过后 streaming 退化为 wrapper；P4 删除旧 streaming 代码与 supervisor。每阶段独立 gap-loop。
- **风险**：ToolCallDomain 接管后，effect evidence 缩减可能影响现有 session 恢复路径。
  - 缓解：spine track 已建立"恢复单向交接"约定，新旧 evidence 格式 schema 版本号标识；恢复时按 schema 版本走不同 reconstruction 路径，不引入 shim 但允许旧 schema 直接拒绝（与 spine track 处理 transcript 一致策略）。
- **风险**：reasoning_content 拆出后 TUI think card 投影代码需要修改。
  - 缓解：本 track 提供 ProviderCallRecord.reasoning 读取入口；TUI 修改范围限于 think card render 函数；不动 TUI 主体。
- **风险**：supervisor 删除后真出现"重复读"会瞬间暴露。
  - 缓解：本 track 之所以删 supervisor，前提是 ToolCallDomain 真源消除根因。回归测试增加专门的"同一 tool_call_id 不能被消费两次"行为测试；如观测到回归，回滚 supervisor 删除是低成本的（git revert 即可）。

## 兼容性设计

- ToolCallDomain / ProviderCallDomain runtime data 是新加 vm.runtimeContext 字段，不影响既有序列化（schema 版本递增）。
- effect evidence payload 缩减是 BREAKING：旧 schema 写入的 session 恢复需要 ToolCallDomain 兜底（已在风险章节说明）。
- `aiAgentLoopStreaming` 函数签名保留（薄 wrapper），调用方不动。
- `aiAgentCooperativeStep` 函数签名保留（薄 wrapper），调用方不动。

## 迁移计划

- P1：抽取 TurnState ADT + turnReducer（纯函数 + 单元测试）。不动主循环。
- P2：cooperative phase machine 改为驱动 turnReducer；streaming 维持旧实现。双路径行为等价 harness 上线。
- P3：streaming 退化为 turnReducer 驱动的 wrapper；删除旧 ToolCallPipelineHandler / ToolOutputDispatchHandler。
- P4：ToolCallDomain runtime 上线；executor 持有的 pending tool 状态迁移；effect evidence payload 缩减。
- P5：ProviderCallDomain runtime 上线；buildProviderPromptForActorTurn 落 record；reasoning/content 分离投影；TUI think card 改读 record。
- P6：AiRuntimeTurnSupervisor 退役；删除文件、接线、回调、导出、测试。
- P7：全量回归、findings.md 写最终基线。

## 待解决问题

- 决策 5/6/7（reasoning 分离、failureKind 枚举、turnReducer 注入位置）在评审 design.md 时由用户最终拍板。
