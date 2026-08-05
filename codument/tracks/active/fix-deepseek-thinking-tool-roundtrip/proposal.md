# 变更：修复 DeepSeek Thinking 工具调用回传

## 背景和动机 (Context And Why)

DeepSeek thinking 模式在使用 tools 时要求后续请求完整回传 assistant 消息的 `content`、`reasoning_content` 和 `tool_calls`。当前通用 OpenAI stream adapter 会把空的 `reasoning_content` 删除，也会在 reasoning 与 content 镜像时同时丢弃协议缓冲；conversation materialization 和 DeepSeek 请求归一化继续使用 truthy 判断，最终导致下一轮请求缺少该字段并收到 HTTP 400。

故障 session 的 provider completion turn 139 已成功返回正文和工具调用，工具也完成；turn 140 因缺少 `reasoning_content` 被 provider 拒绝。该 session 使用第三方 DeepSeek-compatible base URL，原始 SSE 未持久化，因此修复必须同时覆盖规范响应、空/镜像响应和已有历史消息缺字段的兼容恢复。

## “要做”和“不做” (Goals / Non-Goals)

**目标：**

- 将 provider 协议回传数据与 TUI thinking 展示去重分离。
- 保留 `reasoning_content` 字段存在性，包括空字符串和与 content 镜像的内容。
- DeepSeek assistant tool-call 消息在后续请求中始终携带 `reasoning_content`。
- 对升级前已落盘且缺少该字段的历史 session 提供 DeepSeek 请求边界兼容恢复。
- 增加流式聚合、消息归一化和多轮工具调用回传回归测试。

**非目标：**

- 不修改或重写用户历史 session 文件。
- 不向非 DeepSeek provider 注入 DeepSeek 专用字段。
- 不把 reasoning 文本写入普通 content，也不取消 TUI 的重复 thinking 抑制目标。
- 不依赖第三方 provider 的未文档化行为作为唯一修复路径。

## 变更内容（What Changes）

- 补充空 reasoning、镜像 reasoning、正常非空 reasoning 的 stream adapter characterization。
- 修复 stream 聚合，独立保存 wire-level reasoning 与 display-level thinking。
- 修复 DeepSeek 消息归一化，使空字符串不被 truthy 判断删除。
- 为历史 assistant tool-call 消息增加 DeepSeek-only 缺字段恢复。
- 验证 provider 请求 payload、现有 streaming tests 和故障 session 的可继续性前提。

## 影响范围（Impact）

- 受影响的能力：`provider-deepseek`
- 受影响的代码：OpenAI-compatible stream adapter、DeepSeek/OpenAI chat message normalization、conversation/provider prompt materialization 相关测试
- 兼容性：非 DeepSeek 请求保持现有字段过滤；历史 session 无需迁移
