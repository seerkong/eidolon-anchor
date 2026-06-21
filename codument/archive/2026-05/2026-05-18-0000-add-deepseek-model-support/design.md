## 上下文
本迭代的核心不是“再加一个模型名称”，而是把 DeepSeek 的优势前提显式化：
1. 模型家族和上下文窗口必须可识别。
2. 稳定前缀必须尽量不漂移。
3. compaction 不能过早破坏 cache hit。

本项目里，相关链路大致是：
- `local-context.tsx` / `sync-store.ts` 负责模型选择、持久化和回退。
- `model-dialog.tsx` 负责 provider / model 可选项呈现。
- `prompt-info.ts` / `prompt-parts.ts` 负责把用户输入、结构化引用和文件片段拼成运行时 prompt。
- `TerminalRuntime.ts` 负责把模型配置、provider 配置和运行时 metadata 送入实际 LLM adapter。

DeepSeek-TUI 的迁移经验说明：
- 模型识别应该和 context window / compaction 策略绑定。
- prompt 的稳定区应保持严格的序列化顺序。
- 当模型族支持缓存标记时，应尽量把“系统 prompt + 工具定义”视为 immutable prefix。

## 方案概览
1. **建模 DeepSeek 能力**
   - 为 DeepSeek family 定义统一的 capability 映射。
   - 识别 legacy / modern / alias 形态。
   - 将 context window 和 compaction threshold 变成显式模型属性。

2. **收敛 prompt 组装语义**
   - 将 prompt 构造明确分成稳定前缀、动态历史、当前输入。
   - 保证结构化 part 的顺序和来源信息可重复。
   - 对 DeepSeek 请求保持稳定序列化，降低无意义 cache bust。

3. **把 provider / runtime 接口对齐到能力层**
   - 保持现有 provider 选择 UI 不被打断。
   - 在 runtime 侧根据模型能力决定是否走 DeepSeek 专门路径。
   - 非 DeepSeek 模型继续走当前默认路径。

4. **补充验证与回归测试**
   - 重点测模型别名、context window、compaction threshold、prompt 序列化稳定性。
   - 测 provider 选择与 fallback 不回退。
   - 测 DeepSeek 流程不会破坏现有非 DeepSeek 流程。

## 影响范围与修改点（Impact）
- `terminal/packages/tui/src/cli/cmd/tui/prototype/materials/state/local-context.tsx`
- `terminal/packages/tui/src/cli/cmd/tui/prototype/materials/state/sync-store.ts`
- `terminal/packages/tui/src/cli/cmd/tui/prototype/materials/system/provider/model-dialog.tsx`
- `terminal/packages/tui/src/cli/cmd/tui/prototype/features/composer/materials/prompt-info.ts`
- `terminal/packages/tui/src/cli/cmd/tui/prototype/features/composer/materials/prompt-parts.ts`
- `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts`

## 决策摘要
- DeepSeek 采用独立 provider 形态接入，而不是挂在通用 OpenAI-compatible provider 下做隐式增强。
- 优先采用“模型能力层”而不是“单一 provider hardcode”。
- DeepSeek 的专属逻辑应尽可能依附在模型 family / capability 映射上。
- prompt 稳定性优先于早期重写，避免把可缓存前缀轻易打散。
- 非 DeepSeek provider 保持现状，不引入不必要的迁移风险。

## 基于现有三阶段上下文机制的增量方案
当前项目已经有一套可承载 DeepSeek 优化的上下文控制面：
- `ContextControlPlane.ts` 中存在 `PromptPlanData`、`CompactionPolicyContextData`、`ContinuationBaselineData`。
- `materializeExecutionMessagesWithWorkContext()` 会在实际 LLM 请求前插入 work-context overlay。
- `recordPromptPlanForActorExecution()` 会把 prompt plan / routing / selected model 记录到 conversation domain runtime。
- `buildCompactionPolicyContextForActor()` 当前已经基于 `actor.modelConfig.inputLimit` 计算 token threshold 和 token pressure。
- `AiAgentExecutor.ts` 在调用 `llmAdapter.createStream()` 之前，已经把 `prompt_plan` 和 `work_context` 放进 `extraBody`。

因此 DeepSeek 迁移不需要重写上下文管线，建议作为现有机制的两层增强：

1. **Provider / capability 层增强**
   - 新增 `deepseek` adapter/provider driver。
   - 扩展 provider config adapter 类型，使 `deepseek` 成为正式 adapter。
   - 在模型解析阶段产出 DeepSeek 的 `inputLimit`、`outputLimit`、`reasoningEffort`、cache policy 等 capability。
   - 复用现有 `actor.modelConfig.inputLimit` 驱动 compaction threshold。

2. **Prompt plan / serialization 层增强**
   - 不另建一套 prompt builder，而是在 `PromptPlanData.metadata` 中补充 cache profile，例如 stable prefix hash、stable section count、provider family。
   - 在 `materializeExecutionMessagesWithWorkContext()` 附近增加 cache-friendly serialization hook，确保 system prompt、work-context overlay、tool list 顺序稳定。
   - DeepSeek provider driver 读取 `prompt_plan` / capability metadata，构造 DeepSeek 友好的请求体。

这样 A（模型能力层）和 B（prompt 稳定性）可以同时纳入现有架构，但落地顺序建议是：先让独立 provider 能读到正确 capability，再把 prompt 稳定性作为 provider-aware 的序列化策略接入。

## 风险 / 权衡
- 风险：DeepSeek 专属规则太多会把 provider 层变复杂。
  - 缓解：将规则集中在 capability resolver 和 prompt serializer。
- 风险：上下文预算过激会导致过早 compaction。
  - 缓解：以模型窗口为基准，采用偏晚的阈值策略。
- 风险：对 prompt 序列化的改动影响现有行为。
  - 缓解：先做保持语义不变的稳定化，再补 DeepSeek 专属优化。

## 迁移计划
1. 先冻结当前 provider / prompt 路径，梳理 DeepSeek 需要的能力点。
2. 再补模型 family / context window / compaction 映射。
3. 然后引入稳定前缀和 cache-friendly 序列化策略。
4. 最后补测试并评估是否需要进一步 provider 级别拆分。

## 待解决问题
- DeepSeek 是作为独立 provider，还是作为现有 OpenAI-compatible provider 下的增强模型族？
- 是否需要把 cache marker 显式体现在当前请求模型里，还是先只保证稳定序列化？
- DeepSeek 的 reasoning / effort 语义是否要和现有 runtime model config 一并抽象？

