# Design

## 背景

参考项目 `sparrow-agents` 中，控制大模型执行上下文的核心并不是某一份 prompt，而是一套运行时控制面：

- 正式 `work_mode` / `task_phase` 状态
- turn start / tool round 的状态推进
- plan-based prompt assembly
- capability / routing candidate gating
- phase-aware compaction policy
- prompt truth / history truth / session truth 分离
- continuation baseline epoch 与 cache reset

本项目已经拥有：

- `vendor/depa-data-graph`
- `vendor/depa-actor`
- 统一 signal + stream
- `.eidolon` conversation domain persistence 主链

因此本次设计不应照搬参考项目的 manager/helper 风格，而应将这些能力表达为本项目的 runtime/data-graph 语言。

## 方案概览

本 track 将把“上下文控制”提升为正式 runtime 控制面，核心由 5 组结构组成：

1. `WorkContext`
2. `PromptPlan / PromptGeneration / PromptTransform`
3. `CompactionPolicyContext / CompactionPolicyDecision`
4. `ContinuationBaseline`
5. `Runtime-first consumption views`

### 1. WorkContext

定义正式 `WorkContext` 数据对象，至少包含：

- `workMode`
- `taskPhase`
- `workModeSource`
- `taskPhaseSource`
- `workModeUpdatedAt`
- `taskPhaseUpdatedAt`
- 可选的 `lastTrigger` / `actorId` / `sessionId`

接线规则：

- turn 开始时进行一次解析
- tool round 后根据工具种类再次推进
- compaction、prompt assembly、runtime bridge 统一读取该状态

建议落点：

- actor/runtime domain contract
- conversation 或 aiagent runtime family 中的 actor-scoped state

### 2. PromptPlan / PromptGeneration / PromptTransform

在现有 conversation domain 基础上继续补厚 prompt truth：

- `PromptPlan` 表示一次结构化 prompt 装配结果
- `PromptGeneration` 表示基于某个 history basis 的 prompt 基线
- `PromptTransform` 表示 overlay、summary、context block、micro compact 等改写

需要强调：

- history truth 仍然只保存正式 committed messages
- prompt truth 负责模型输入附加层
- 上层 materialize runtime prompt view 时，统一解释 prompt generation + transforms

建议首期 transform 类型至少覆盖：

- `prompt_request`
- `overlay`
- `history_compaction_summary`
- `context_block_attach`
- `context_block_detach_all`

### 3. CompactionPolicyContext / CompactionPolicyDecision

为压缩主链增加正式 policy 输入和输出对象，而不是“超过阈值就直接压缩”：

- 输入至少包括：
  - `workMode`
  - `taskPhase`
  - `trigger`
  - `mode`
  - `tokensBefore`
  - `tokenThreshold`
  - `baselineEpoch`
  - `recentToolEvidenceCount`
  - `hasRecentPatchRationale`
  - `hasRecentVerificationTarget`
- 输出至少包括：
  - `policy`
  - `decision`
  - `reason`
  - `protectedCategories`
  - `rewrittenCategories`
  - `skipReason`

phase 约束方向：

- `context_build`: 优先保护 discovery evidence
- `implementation`: 优先保护 patch rationale
- `verification`: 优先保护 verification evidence

### 4. ContinuationBaseline

定义 provider-agnostic 的 continuation baseline contract：

- `baselineEpoch`
- `lastResetReason`
- `latestResponseId` 或同类 replay 身份

当 compaction rewrite 改变 replay 基线时：

- 提高 baseline epoch
- 清空 continuation identity
- 触发缓存失效
- 让 runtime / persistence 可观察到这次 reset

首期可以先做 provider-agnostic reset hook 和最小持久化/诊断定义，provider-specific 细节后续扩展。

### 5. Runtime-first consumption views

上层消费面统一走 runtime-first：

- TUI / headless 查看当前会话上下文
- runtime prompt view materialization
- history / prompt / session 恢复
- compaction 后继续执行

只有 runtime 不可用、无状态或离线场景下，才回退 `.eidolon` persistence-first loader。

## 包职责与 ownership

### `cell/packages/ai-support`

负责本地 `.eidolon` 副作用实现：

- prompt generation / transform 持久化扩展
- compaction policy / decision artifacts
- continuation baseline 本地 side effect / snapshot
- 相关 recovery / loader 的文件系统 backend

### aiagent / conversation runtime logic

负责 orchestration：

- turn start / tool round 的 `WorkContext` 推进
- prompt assembly / transform 应用
- compaction policy 计算与 rewrite orchestration
- runtime-first consumption 派生

### vendor data graph / actor runtime

负责承载正式 state / stream：

- actor-scoped work context state
- conversation domain family 的 signal + stream
- compaction / continuation 等观测事件通道

## 与参考实现的映射关系

### 直接保留的设计思想

- `work_mode` / `task_phase` 是正式状态
- tool round 会推进 phase
- prompt truth 与 history truth 分离
- compaction 依赖当前任务阶段
- compaction rewrite 后 reset continuation baseline

### 转换为本项目表达的设计

- 不复制 Python manager，而改为 runtime/data-graph family
- 不要求照搬 reference registry 的所有接口命名，但保留 candidate routing / prompt plan / transform 的结构边界
- `.eidolon` 副作用继续由 `ai-support` 承担

## 风险与权衡

### 风险

- 如果只迁移 `work_mode` / `task_phase` 文本字段，而不接 prompt truth / compaction / continuation 主链，会形成新的“名义状态”，没有真正控制执行上下文。
- 如果把所有能力一次性做满，会与当前项目的 runtime 结构产生过大改动面，增加偏差和调试成本。

### 权衡

- 首期优先闭合“状态推进 -> prompt assembly -> compaction -> continuation -> runtime consumption”这条主链。
- skill / subagent / overlay 的完整生态保留结构定义与最小接线，避免阻塞主链。

## 首期预留定义

以下能力在本轮已经被纳入正式控制面边界，但仍保留为“最小定义 + 后续扩展”：

- skill / subagent routing 生态：
  - 本轮已经给出 `PromptRoutingDecision` 与最小 candidate/gating 入口。
  - 后续仍可把真正的 skill manifest、subagent registry、candidate scoring 扩展进去，而不需要再改基础 schema。
- inspection guard / bounded context budget：
  - 本轮已通过 `taskPhase` 和 work-context overlay 表达阶段约束。
  - 但像参考实现那样的连续 inspection warning / block 阈值，目前仍未进入强执行主链。
- provider-specific continuation diagnostics：
  - 本轮已经落地 provider-agnostic `ContinuationBaseline`、compaction reset 与 `.eidolon` diagnostic artifact。
  - 但不同 provider 的 response identity、cached input token 诊断、reset event stream 仍保留后续扩展。

这三类机制都不再是“无定义空白区”，但也不假装已经做到参考实现的全量形态。

## 当前实现收口

截至本轮实现，已经正式落地：

- actor durable `WorkContext` 与 `ContinuationBaseline`
- turn start / tool round 的状态推进
- 最小 `PromptPlan`、prompt request metadata 与 runtime work-context overlay
- phase-aware compaction policy / decision
- compaction rewrite 后的 baseline bump 与 `.eidolon` diagnostic artifact
- recovery 时从 prompt truth metadata 回填 context-control 状态
- runtime facade 对 `workContext` / `continuationBaseline` 的 runtime-first 读取入口

## 迁移阶段建议

### P1. 定义 contract 与状态模型

- WorkContext
- PromptPlan / PromptGeneration / PromptTransform
- CompactionPolicyContext / Decision
- ContinuationBaseline

### P2. 接 turn/tool progression

- turn start 解析
- tool round phase progression
- source / timestamps tracing

### P3. 接 prompt assembly 主链

- 让 prompt assembly plan-based
- 把 work context 写入 metadata
- 接最小 routing decision 与 tool surface gating

### P4. 接 compaction / continuation 主链

- policy-based compaction
- baseline epoch reset
- prompt truth summary transform

### P5. 接 runtime-first consumption

- TUI / headless / runtime bridge
- persistence fallback
- 验证恢复与继续执行链路

## 本 track 的设计结论

本次迁移的本体不是“多几段提示词”，而是：

> 把参考项目中用于控制 LLM 执行上下文的运行时控制面，迁移为本项目的正式 runtime/domain 能力，并与既有 `.eidolon` conversation persistence 主链合流。

只有这样，`work_mode` / `task_phase`、动态 prompt assembly、压缩策略、历史恢复与继续执行，才会成为同一套数据驱动系统，而不是分散在多个 helper 中的局部约定。
