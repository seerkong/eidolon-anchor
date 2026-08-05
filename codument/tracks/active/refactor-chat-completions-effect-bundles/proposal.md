# 变更：统一 Chat Completions 官方 Effect Bundle

## 背景和动机 (Context And Why)

OpenAI Chat Completions 与 DeepSeek 官方 Chat Completions 共用 HTTP、SSE、tool-call 增量和 ingress 机制，但当前共享 fetch adapter 通过模型名和 Base URL 猜测 DeepSeek 语义。该隐式分支把 provider 协议差异混入公共传输，并使流式归约依赖可变 class 状态，难以独立验证。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**

- 建立单一 Chat Completions 公共核心，复用 transport、SSE、content、tool-call 和 ingress 机制。
- 建立 OpenAI official Chat 与 DeepSeek official Chat 两个显式 effect bundle 实现。
- 将可确定的数据变换提取为纯函数 reducer，并以 effect shell 承担 fetch、abort、timeout 和事件发送。
- 由已选 provider driver 显式注入 bundle，并把同一选择贯穿请求构造、stream reduction 与 ingress，不在流侧按 adapter type 二次推断。
- 将 Chat Completions、tool-call 与 reasoning 语义归入 AI domain contract/logic；symbiont 层只保留通用 stream/runtime 原语。
- 保持 DeepSeek reasoning roundtrip、历史兼容恢复和普通 OpenAI 隔离行为。

**非目标:**

- 不把 OpenAI Responses API 合并到 Chat Completions 核心。
- 不改变 Anthropic、Claude Code 或 Codex adapter 的协议。
- 不迁移或重写历史 session 文件。
- 不新增任意 provider 的自动识别启发式。

## 变更内容（What Changes）

- 新增 Chat Completions effect bundle contract 与两个官方实现。
- 提取纯 stream state、chunk projection、tool-call reduction、think-tag segmentation 和 assistant message finalization。
- 将现有 fetch/SSE adapter 改为组合公共核心与显式 bundle。
- 更新 OpenAI/DeepSeek driver，分别注入对应 bundle，并由执行期 stream callback 接收当前请求使用的 adapter/driver binding。
- 将 AI-specific stream adapter 从 symbiont-logic 迁入 ai-organ-logic；保留 ai-organ-logic 的公共类名/导出，并迁移工作区内直接引用，不保留错误领域方向的 symbiont 深层导入。
- 添加架构、协议隔离与行为回归测试。

## 影响范围（Impact）

- 受影响的能力（behaviors）：provider-chat-completions、provider-deepseek
- 受影响的代码：ai-core process-stream callback contract、ai-organ-contract provider contract、ai-organ-logic provider drivers/fetch/stream adapter、terminal runtime binding、symbiont compatibility surface/layout guards、相关 AIAgent/LLM tests
