# 变更：新增 DeepSeek 模型高支持迭代

## 背景和动机 (Context And Why)
本项目当前的 LLM 流程已经具备模型选择、运行时配置、Prompt 组装和会话状态持久化，但对 DeepSeek 模型家族还没有形成“以缓存友好和上下文预算为中心”的专门支持。

参考 `/Users/kongweixian/ai/src/DeepSeek-TUI` 可以看到两个关键点：
1. 将 DeepSeek 的模型家族、上下文窗口和 compaction 阈值显式建模，而不是只靠通用默认值。
2. 将系统 prompt、工具定义和其它稳定前缀尽量保持 byte-level 稳定，以提高 DeepSeek 自动前缀缓存命中率。

当前项目中，模型选择和上下文构建分散在以下路径中：
- `terminal/packages/tui/src/cli/cmd/tui/prototype/materials/state/local-context.tsx`
- `terminal/packages/tui/src/cli/cmd/tui/prototype/materials/state/sync-store.ts`
- `terminal/packages/tui/src/cli/cmd/tui/prototype/materials/system/provider/model-dialog.tsx`
- `terminal/packages/tui/src/cli/cmd/tui/prototype/features/composer/materials/prompt-info.ts`
- `terminal/packages/tui/src/cli/cmd/tui/prototype/features/composer/materials/prompt-parts.ts`
- `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts`

这意味着 DeepSeek 支持更适合通过一个迁移迭代来补齐：先把 DeepSeek 的模型语义和缓存语义变成正式能力，再把它接入现有 provider / prompt / runtime 流程。

## “要做”和“不做” (Goals / Non-Goals)
**目标:**
- 将 DeepSeek 作为一等模型家族纳入项目的模型/ provider 语义。
- 将 DeepSeek-TUI 中的缓存友好经验迁移到本项目的 prompt 组装与请求构造中。
- 为 DeepSeek 模型建立 context window、compaction threshold、reasoning / effort 之类的模型能力映射。
- 保持现有 provider UI、local model 选择和 runtime 回退路径兼容。

**非目标:**
- 不一次性重写整个 provider 架构。
- 不把所有模型都强行改造成 DeepSeek 专属流程。
- 不在本迭代中重构无关的 MCP / sandbox / 文件工具链。

## 变更内容（What Changes）
- 新增 DeepSeek 模型家族能力层：模型别名、上下文窗口、缓存策略、推理档位。
- 将 prompt 组装拆成更明确的“稳定前缀 / 动态历史 / 当前输入”三段式语义。
- 让请求构造尽量保持稳定序列化顺序，减少无意义的 cache bust。
- 在需要时为 DeepSeek 请求显式注入模型相关的提示与预算策略。
- 补充针对 DeepSeek 迁移的单元测试与回归测试。

## 影响范围（Impact）
- 受影响的功能规范：模型选择、LLM 请求构造、上下文预算、会话体验。
- 受影响代码：TUI model dialog、local model state、runtime 配置、prompt 组装、LLM 请求适配层。

