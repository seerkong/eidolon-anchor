# 变更：Provider Epoch 与 DeepSeek 会话投影

## 背景和动机 (Context And Why)

一个由 Codex/OpenAI-compatible provider 长期运行、包含多轮工具调用的持久会话，在人工切换到 SiliconFlow DeepSeek V4 Flash 后，于本地请求 admission 阶段稳定失败为 `invalid_provider_request_body`。同一个现场切回原 provider 后仍可运行，说明 canonical conversation 没有损坏；失败发生在 provider-specific wire projection 与模型切换恢复边界。

当前 DeepSeek Chat 投影会复制 assistant message 的开放对象字段、为缺失 reasoning 的历史 tool call 伪造空 `reasoning_content`，并把 runtime-only capability/cache metadata 放入 wire body。request admission 又吞掉精确的 closed-data 路径，使现场只能看到无定位信息的通用错误。人工切换模型只更新 actor model config，没有显式推进 conversation provider epoch。

## “要做”和“不做” (Goals / Non-Goals)

**目标：**

- 保持 Conversation Domain 和 ToolCallDomain 为唯一 canonical authority；provider epoch 只是可恢复的投影边界与 receipt。
- 为 Chat Completions 建立 closed provider wire message 投影，禁止把 internal/accessor/undefined/runtime-only 字段带到请求。
- 由 provider adapter 声明 wire protocol profile：所有 `adapter=deepseek` 的 endpoint 统一使用 `deepseek-chat@1`，provider id 只负责路由、凭据、endpoint 与模型目录。
- 人工/CLI 切换 provider 或 protocol 时推进 durable context/provider epoch，失效旧 continuation，并以中立 handoff 投影承接不兼容的历史 tool protocol；不得伪造 provider reasoning。
- admission 失败只报告安全的 JSON pointer、value kind 与 request digest，不记录 prompt、args、tool output 或完整 body。
- provider projection/admission 失败后，交互 fiber 保持可继续；用户可切换模型或重试，而不是把 session 永久封死。
- 用事故 session 的复制现场验证 SiliconFlow DeepSeek 能完成下一轮，且 canonical history、tool effects 与原始现场不被改写。

**非目标：**

- 不修改或迁移原始事故 session。
- 不把 OpenAI Responses native replay 合并进 Chat Completions。
- 不为 DeepSeek 创建第二 conversation/history store。
- 不把缺失的 DeepSeek reasoning 伪造成空字符串并声称是原 provider 事实。
- 不触碰 Holon/AI workflow 组织集成实现。

## 变更内容（What Changes）

- 新增 closed Chat wire projection，并把协议 profile 的 authority 收回 adapter。
- 收紧 DeepSeek request body，只发送 endpoint 已声明支持的字段。
- 增加 provider epoch/handoff receipt，复用现有 Conversation Domain context epoch 与 actor continuation reset。
- 增加安全 admission diagnostics 与交互恢复语义。
- 增加 provider-switch、DeepSeek reasoning recovery、no-duplicate-tool-effect 和真实复制现场回归。

## 2026-08-31 Replan：纠正 Provider/Profile Authority

原实现把 `deepseek-official-chat@1` 与 `deepseek-compatible-chat@1` 暴露给 provider 配置、CLI 和 workflow。该设计把网关身份错误地提升为协议语义 authority，导致同样使用 DeepSeek Chat 协议的 SiliconFlow、iqingwa 等 provider 必须人工补 profile，并可能被排除在统一缓存命中率与成本验收之外。

本次重开 Track 后将其纠正为：

- adapter/driver 是协议 profile 的唯一 authority；DeepSeek adapter 固定声明 `deepseek-chat@1`。
- provider 配置不再接受 `compatibility_profile`，CLI/workflow 不再传递 `provider-chat-profile`。
- 旧 `deepseek-official-chat@1`、`deepseek-compatible-chat@1` 只作为持久化迁移输入，读取时归一化，写出时只产生 `deepseek-chat@1`。
- 所有 DeepSeek 网关共享 reasoning/tool projection、cache observation、定价权重与 SLO 语义；provider id 不参与协议分流。

## 影响范围（Impact）

- 受影响能力：`ai-semantic-conversation-spine`、`terminal-tui-shell`
- 受影响代码：`ai-organ-contract` provider/conversation contracts、`ai-organ-logic` Chat/DeepSeek projection/admission/executor、terminal model switch bridge、相关 tests
