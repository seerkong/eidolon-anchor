# 变更：迁移 Sparrow LLM Provider Runtime

## 背景和动机 (Context And Why)

当前项目已经迁移了 Sparrow 的 LLM provider 配置机制，并完成了 provider runtime/driver 的第一版外壳。但大模型调用链仍主要复用原有 Node fetch adapters，Sparrow 中更完整的 provider 执行能力尚未完全迁移，例如 retry、stream timeout、Responses continuation、diagnostics、normalized response 和 fallback chain。

该 track 用于跟进剩余迁移任务，使本项目的 LLM provider 层不仅能读取新配置，也能采用 Sparrow 的 provider 处理思路管理调用生命周期。

## “要做”和“不做” (Goals / Non-Goals)

**目标:**
- 将 retry/error classification 迁入 ai-organ provider 层。
- 将 first-event timeout、idle timeout、adaptive timeout 策略迁入 provider 层。
- 完整迁移 OpenAI Responses continuation / replay repair / previous_response_id 管理。
- 接入 provider diagnostics：model selection、retry、progress、continuation、request summaries。
- 提供 normalized provider response 抽象，稳定 text/tool-call/usage/stop-reason/response-id 语义。
- 将 present config fallback chains 变成 runtime 可执行能力。
- 保持 provider contract 在 `ai-organ-contract/src/llm`，provider logic 在 `ai-organ-logic/src/llm`。

**非目标:**
- 不恢复旧 ai-core LLM config/loader facade。
- 不引入需要真实外部 API key 的 CI 测试。
- 不改变 `.eidolon/llm-provider-config.json` 与 `.eidolon/llm-present-config.json` 的当前加载位置。

## 变更内容（What Changes）

- **BREAKING**：LLM provider 执行语义继续从 ai-core/旧 adapter 直连路径迁移到 ai-organ provider runtime/driver 层。
- 新增/完善 provider retry 和 provider error 类型。
- 新增/完善 provider stream timeout 策略。
- 增强 OpenAI Responses driver，迁移 Sparrow 的 request builder、continuation 和 replay handling。
- 增强 OpenAI Chat / Anthropic / Claude Code driver 的请求构造、stream normalization 和 tool-call 处理。
- 接入 runtime diagnostics event contracts。
- 为 fallback chain execution 添加 runtime 流程和测试。

## 影响范围（Impact）

- 受影响的功能规范：
  - LLM provider runtime
  - Runtime model config resolution
  - OpenAI Responses adapter behavior
  - OpenAI Chat adapter behavior
  - Anthropic / Claude Code adapter behavior
  - Terminal runtime turn execution
  - Provider diagnostics and fallback behavior
