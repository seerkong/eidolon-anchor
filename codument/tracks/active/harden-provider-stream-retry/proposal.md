# 变更：加固 provider stream 消费阶段的安全重试

## 背景和动机

Eidolon 当前的通用 provider retry 只包住 `createStream()`。当 Responses/SSE 已经建立连接、随后在流内返回 `response.failed` 或 `server_error` 时，错误会被分类为 retryable，但不会真正重试。目标 session 已出现 delegate 和主 actor 连续失败，而 OpenCode 使用相同 provider 时没有同样现象。

## 目标和非目标

**目标：**

- 将流消费阶段的临时 provider failure 纳入统一 retry decision。
- 在没有任何可见 assistant/tool 输出时安全重试。
- 在已经产生可见输出后禁止自动 replay，避免重复工具副作用或重复文本。
- 记录每次实际 attempt 与 retry decision，便于区分“分类为 retryable”和“实际已重试”。
- 保持 OpenAI Responses、OpenAI Chat、DeepSeek 及其他 provider 的既有请求契约。

**非目标：**

- 不引入按 work mode、工具名或任务类型推断的重复调用阈值。
- 不对所有 stream 错误无条件重试。
- 不改变 provider 的默认 retry 次数和总时间预算，除非测试证明当前策略不足。
- 不把已产生部分输出的请求强行转换成可重放请求。

## 变更内容

- 为 stream consumption 增加可观测输出状态和安全 replay classification。
- 让流内 retryable upstream failure 复用 provider retry policy。
- 将 retry attempt identity 和诊断写入现有 provider diagnostics/transport observation surfaces。
- 增加 SSE/Responses、Chat/DeepSeek、部分输出和 retry exhaustion 回归测试。

## 影响范围

- 行为能力：`provider-stream-retry`。
- 关键代码：`cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts`、`cell/packages/ai-organ-logic/src/llm/ProviderRuntimeAdapter.ts`、`cell/packages/ai-organ-logic/src/llm/OpenAIResponsesNodejsFetchAdapter.ts`、provider retry contracts/tests。
