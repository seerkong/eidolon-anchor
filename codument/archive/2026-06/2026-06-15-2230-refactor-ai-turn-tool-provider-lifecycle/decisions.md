# Decisions

## Usage
- 用于记录需要用户确认的决策问题、选项、最终结论与理由
- 问题标题不用字母前缀；字母只用于选项
- 后续执行过程中出现的新决策，也继续追加到本文件，不新建分散的决策记录

### 1. 【P0】AiRuntimeTurnSupervisor 处置
- 背景：capsules track 决策 3 证伪原"未接线"假设——supervisor 已接线进 TerminalRuntime live turn 主路径（hint 注入 + 最多 3 轮 continuation + exec warning 回调）。capsules track 期间不能删（行为变更），明确归入本 track。supervisor 当前仅 observational（只能 hint，不能 gate），是 mission 否决方向的 guardrail。
- 选项：
  - A) 本 track 直接删除（文件、接线、回调、导出、单元测试全删，不引入替代）
  - B) 保留并冻结，归到 Track-9 最终迁移
  - C) 升级为有 gate 能力的 supervisor（deny 第 N+1 次重复 tool）
- 用户答复：A（2026-06-14）
- 最终决策：A
- 决策理由：TurnState ADT + ToolCallDomain 真源唯一化后，supervisor 的 hint 是死代码；继续保留只是把死代码外延到下一个 track；mission 005 已明确"重复读"的根因在事实边界混乱，guardrail 是表象修补不应保留。
- 状态：accepted

### 2. 【P0】TurnState 形态
- 背景：当前 cooperative state 由 phase: string + inflight: discriminated union + 三个 pending 数组组成，run-time invariant 由代码秩序维持，编译器无法防止"phase 是 wait_llm 但 inflight 是 tool"。
- 选项：
  - A) ADT discriminated union（每个 variant 自带本阶段必要字段）
  - B) 单一 record + 可选字段（现状字段正规化但 invariant 仍弱）
- 用户答复：A（2026-06-14）
- 最终决策：A
- 决策理由：延续 spine track 已建立的 ToolExecutionGateDecision ADT 风格；编译期防止跨 variant 组合；与 D3（tool_call_id 透明 ID + evidence link-only）天然搭配——wait_tool variant 直接持 toolCallId + gateOutcome 字段。
- 状态：accepted

### 3. 【P0】tool_call_id 配对策略 + runtime-control evidence 边界
- 背景：当前 tool_call ↔ tool_result 配对依赖数组下标与 tool_call_id 字段双重存在；evidence 既持 outputText 又被恢复读取，与 ToolCallDomain 边界模糊。
- 选项：
  - A) LLM tool_call_id 作为透明唯一 ID（合同断言）+ evidence 只持 request_id/link
  - B) tool_call_id + args hash 派生配对 + evidence 持元数据
  - C) 保留现状
- 用户答复：A（2026-06-14）
- 最终决策：A
- 决策理由：符合 spine track "evidence 不再充当 truth" 原则；ToolCallDomain 自主拥有 (tool_call_id, args, status, gate_decision, result) 全套事实；evidence 退回 audit/恢复辅助，恢复时从 ToolCallDomain 重建 tool result。LLM 协议保证 tool_call_id 全局唯一，hash 派生是过度设计且引入双源。
- 状态：accepted

### 4. 【P0】cooperative 与 streaming path 处理
- 背景：当前两条 path 维护 ~30% 重复代码（gate 评估、tool IIFE、emit、evidence），但事件循环模型不同（streaming 是 ToolCallPipelineHandler / ToolOutputDispatchHandler 链，cooperative 是 phase machine）。
- 选项：
  - A) 抽共享 evaluator/dispatcher，不合并主循环
  - B) 本 track 内合并主循环（streaming 退化为 cooperative 薄包装）
  - C) 各自接 owner，不抽共享
- 用户答复：B（2026-06-14）
- 最终决策：B
- 决策理由：本 track 是 lifecycle 的根因修复，若两条 path 继续独立会让 TurnState ADT 与 ToolCallDomain 接管都要做两遍，未来 lifecycle 改动也要改两遍。合并主循环风险高但收益是永久的；用 turnReducer 单元测试 + 行为等价 harness 防守。
- 状态：accepted

### 5. 【P1】reasoning_content 归属
- 背景：当前 reasoning_content 通过 anthropic adapter 的 on-the-fly merge 进 content_parts.find(type==="reasoning")，没有作为独立事实存在。
- 选项：
  - A) ProviderCallDomain 显式记录 reasoning fact 与 content fact 两类
  - B) 维持现状（合并进 content_parts）
- 当前建议：A
- 决策理由：与 D2/D3 同步——既然 ProviderCallDomain 要做 owner，reasoning 是显然要分开记录的事实；TUI think card 与 observability 都受益；MessageAssembly 仍可保留向后兼容的 content_parts 字段，但读取入口改显式。
- 状态：pending（已起草 spec，待评审时用户最终确认）

### 6. 【P1】provider failure 分类粒度
- 背景：当前 provider 失败只以 `Error: ...` 字符串表示；运行时区分依赖字符串前缀（spine track 已用 plan-gated 案例证伪过此风格）。
- 选项：
  - A) 引入 failureKind 枚举（network_error / provider_rate_limit / provider_invalid_response / aborted_by_user / timeout）
  - B) 维持字符串
- 当前建议：A
- 决策理由：失败分类是后续 retry / 错误观测的前置；与 spine track 用 ADT 替换字符串的方向同向。
- 状态：pending

### 7. 【P1】turnReducer 与 actor / fiber 的关系
- 背景：turnReducer 是本 track 的核心新抽象。需要确认它是 actor.callbacks 之一、独立的 contract，还是直接是 AiAgentActor 的字段。
- 选项：
  - A) 作为 actor.runtime 注入（与现有 LlmAdapter / ToolFuncRegistry 等同层级）
  - B) 作为 AiAgentVm 单例（vm.turnReducer）
  - C) 作为 actor 字段（actor.turnReducer）
- 当前建议：A
- 决策理由：turnReducer 是纯逻辑无状态，按 runtime 注入符合 explicit-runtime 吸引子；与 ToolFuncRegistry 等同层级，便于测试时替换。
- 状态：pending
