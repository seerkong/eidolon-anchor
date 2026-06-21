# 变更：AI Turn / Tool / Provider Lifecycle 主干

## 背景和动机 (Context And Why)

P7+P8 收口（spine track）让 conversation 三域成为内存唯一真源、vm.eventBus 成为 commit 唯一入口、actor.messages 成为 readonly 投影；ToolExecutionGateDecision ADT 也把 tool gate 从字符串 hack 推到了类型化数据。但 turn / tool / provider 的**运行时事实仍散落**在 cooperative state.phase、state.inflight、pendingAiGenerated 数组、runtime-control effect evidence 之中：

- TurnState 没有 ADT：phase 字符串 + 平行 inflight union + 多个 pending 数组的隐式组合，运行时 invariant 由代码秩序维持。
- tool 生命周期事实分散：tool 是否真的运行只能靠 ToolExecutionGateDecision.kind === "allow" 这一瞬时信号；tool_call_id 配对依赖数组位置；evidence 与 ToolCallDomain 边界未划清。
- ProviderCall 元数据（model、temperature、tool schemas）散在 PromptPlanData 与 effect evidence；reasoning_content 隐式合入 content_parts。
- AiRuntimeTurnSupervisor 已被 capsules track 证伪原"未接线"假设，仍在 TerminalRuntime live turn 主路径上做 hint 注入 + 最多 3 轮 continuation，是 mission 否决方向的 guardrail，但当时受限于 lifecycle 主干未稳定无法移除。

mission roadmap Track-5（`refactor-ai-turn-tool-provider-lifecycle`）的目标是把 TurnState / ToolCallDomain / ProviderCallDomain 从声明态推到事实接管态，从根因消除"重复读文件"、"pending bash effect"、"tool output 没有对应 tool call"等问题；并据此安全退役 AiRuntimeTurnSupervisor，不引入新 guardrail。

## "要做"和"不做" (Goals / Non-Goals)

**目标：**

- **TurnState ADT**：用 discriminated union 显式表达 turn 运行时状态，每个 variant 自带必要字段（wait_llm 自带 opId、wait_tool 自带 opId+toolCallId+gateOutcome 等）；类型系统在编译期防止"phase 是 wait_llm 但 inflight 是 tool"这类组合。
- **统一主循环**：把 `aiAgentLoopStreaming` 与 `aiAgentCooperativeStep` 合并到单一 phase machine；streaming 入口退化为 cooperative phase machine 的薄包装；ToolExecutionGateDecision 评估、tool 任务派发、eventBus emit、runtime-control evidence 记录由共享函数承担。
- **ToolCallDomain 事实接管**：tool 全生命周期事实（planned / dispatched / gate decision / executed-or-skipped / result / failed）由 ToolCallDomain 独占；evidence 退化为 audit / 恢复辅助；tool_call_id 配对仅依据 LLM 提供的透明 ID，不依赖位置。
- **ProviderCallDomain 元数据归位**：每次 provider 请求落 ProviderCallRecord（modelRef / temperature / tool schemas / prompt generation 引用 / startedAt）；reasoning_content 与 final content 作为两类独立事实；provider 失败按 failureKind 枚举显式分类。
- **AiRuntimeTurnSupervisor 退役**：删除文件本体、TerminalRuntime continuation 循环（1243-1281）、exec warning 回调、cell 侧导出、单元测试；不引入任何替代 guardrail。
- **一致性测试**：TurnState ADT 形态 / 统一主循环行为等价（streaming 与 cooperative 入口产出相同 providerMessages 与 turn 转换序列）/ ToolCallDomain 单一真源 / ProviderCallRecord 完整性 / supervisor 移除后既有功能不回归。

**非目标：**

- 不改 conversation 三域（spine track 已收口）。
- 不引入新 guardrail（包括"deny 第 N+1 次重复 tool"、自动 retry 策略等）。
- 不修改 provider 请求的实际 wire 协议（请求构造内容不变，只改元数据归属）。
- 不动 persistence backplane（Track-6 范围）。
- 不动 TUI 投影逻辑（Track-7 范围；但 reasoning_content 拆出后 TUI 入口需要相应修改，归类为附带最小迁移）。
- 不修复历史 session，不做迁移 shim。
- 不引入"tool args hash 派生配对"（决策 3：LLM 透明 ID 已够用，hash 派生会引入 evidence 双源风险）。

## 变更内容（What Changes）

- **新增三个 capability**：`ai-turn-execution-spine`、`tool-call-domain-lifecycle`、`provider-call-domain-lifecycle`。
- **核心重构**（cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts，5221 行单文件）：
  - 提取 TurnState ADT 与 turnReducer（cooperative phase 转换的核心，纯函数）。
  - 把 `aiAgentLoopStreaming` 改写为驱动 cooperative phase machine 的薄入口；删除独立 streaming loop。
  - tool dispatch（gate 评估 + IIFE task + emit + evidence）抽成共享函数。
- **ToolCallDomain owner 落实**：在 ai-core-contract / ai-organ-logic 增加 ToolCallDomain runtime 实现，executor 不再持有 pending tool 状态，全部读 domain；effect evidence payload 改为 link only。
- **ProviderCallDomain owner 落实**：增加 ProviderCallRecord 与 reasoning/content 分离事实；buildProviderPromptForActorTurn 落 record；processStreamFn 收到的 reasoning_content 显式入 reasoning fact。
- **BREAKING（内部）**：删除 `AiRuntimeTurnSupervisor` 文件与所有接线点；删除 TerminalRuntime continuation 循环；删除 exec warning 回调；删除 cell 侧 supervisor 导出与单元测试。
- **spec 同步**：新增三个 capability spec；`runtime-data-subgraph-contracts` 的清单声明不动（三个新 capability 已承担细节）；`control-plane-logic-capsules` 中的 `guardrail-disposition-recorded` 保持不动（历史时点声明）。

## 影响范围（Impact）

- 受影响的功能规范：`ai-turn-execution-spine`（新增）、`tool-call-domain-lifecycle`（新增）、`provider-call-domain-lifecycle`（新增）。
- 可能影响的代码区域：
  - `cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts`（核心重构）
  - `cell/packages/ai-organ-logic/src/runtime/AiRuntimeTurnSupervisor.ts`（删除）
  - `cell/packages/ai-core-contract/src/runtime/AiRuntimeDataSubgraphs.ts`（ToolCallDomain / ProviderCallDomain owner contract）
  - `cell/packages/ai-organ-logic/src/runtime/`（TurnState ADT、turnReducer、ToolCallDomain runtime、ProviderCallDomain runtime）
  - `cell/packages/ai-core-contract/src/runtime/AiAgentVm.ts`（state.inflight 等字段移除）
  - `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts`（删除 supervisor continuation 循环、reasoning_content 投影入口调整）
  - 相关 tests（ToolCallDomain / ProviderCallDomain / 主循环等价 / supervisor 移除回归）
- 风险面：合并主循环 + supervisor 删除两个动作叠加，单文件 5221 行重构 + live turn 主路径行为变更；以 turnReducer 单元测试 + 主循环行为等价 harness + 失败基线对照三层防守。
