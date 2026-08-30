# DeepSeek Thinking Tool Roundtrip Design

## 上下文

DeepSeek 的 interleaved thinking 工具调用协议把 `reasoning_content` 作为 assistant message 的 wire contract 一部分。它可能是非空文本、空字符串，兼容 provider 也可能把相同文本同时投影到 reasoning 与 content。界面是否展示 thinking 是 presentation policy，不能改变后续 provider request 所需的协议消息。

当前链路存在三个损失点：stream adapter 只累计非空且非镜像 reasoning；message normalizer 只保留 truthy reasoning；conversation projection 只在 reasoning 非空时持久化 think block。历史 session 因此可能永久缺字段。

## 方案概览

1. 流式协议保真
   - stream adapter 记录是否观察到 `reasoning_content` 字段。
   - wire buffer 始终累计 provider 返回的 reasoning，包括与 content 镜像的文本。
   - display emission 继续独立判断是否抑制镜像 thinking，避免把 UI 策略作用到 wire buffer。
   - buildMessage 在观察到字段时写入 `reasoning_content`，即使最终值为空字符串。

2. DeepSeek 请求归一化
   - `preserveReasoningContent` 使用字段存在性而非 truthy 判断。
   - 对 DeepSeek assistant tool-call 消息，如果历史 materialization 已缺字段，兼容性地补 `reasoning_content: ""`。
   - 该恢复仅在 DeepSeek 路径启用；普通 OpenAI 路径继续移除 provider-specific reasoning。

3. Conversation 与历史兼容
   - 新响应应尽可能保留真实 wire reasoning。
   - 历史记录无法从已丢失的 SSE 重建真实 reasoning，故请求边界空字符串恢复是唯一无数据迁移方案。
   - 不重写 XNL；恢复在 provider projection 时完成。

4. 验证
   - stream unit test：非空、空、镜像 reasoning 与 tool call。
   - normalization unit test：DeepSeek 保留空字段，DeepSeek 历史 tool call 补空字段，OpenAI 不注入。
   - transport test：序列化请求 body 包含 assistant `reasoning_content` 和相邻 tool result。
   - 回归运行现有 stream、chat driver、provider context tests。

## 影响范围与修改点（Impact）

- `cell/packages/symbiont-logic/src/stream/OpenAICompletionsNodejsFetchStreamAdapter.ts`
- `cell/packages/ai-organ-logic/src/llm/OpenAIChatHelpers.ts`
- `cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts`（仅在确需 provider-specific projection 参数时）
- 对应 `ai-organ-logic/tests/AIAgent` 定向测试

## 决策摘要

- Wire contract 与 TUI display policy 必须分离。
- 历史缺失字段采用 DeepSeek-only 空字符串兼容恢复，不修改持久化文件。
- 修复落在共享 OpenAI-compatible adapter 的可配置协议层，不为单个业务项目建立旁路。

## 风险 / 权衡

- 第三方兼容 provider 可能返回非标准 mirrored reasoning。
  - 缓解：保存 wire 值但允许 display emission 去重。
- 历史消息的真实 reasoning 已不可恢复。
  - 缓解：只补协议要求的字段存在性，并通过诊断/测试明确这是兼容 fallback。
- 全局注入字段可能影响 OpenAI-compatible provider。
  - 缓解：仅 DeepSeek normalization option 启用 fallback。

## 兼容性设计

- 新 session 保留 provider 返回的真实 reasoning。
- 旧 session 在下一次 DeepSeek tool continuation 请求时补空字段，无需迁移。
- 非 DeepSeek adapter 的 request body 不新增 `reasoning_content`。

## 迁移计划

无需数据迁移或 session 重写。安装新版本后重新加载历史 session 并继续即可走兼容 projection。

## 待解决问题

- 原始故障 SSE 未持久化，无法区分空 reasoning 与镜像 reasoning；两类均纳入回归测试。
