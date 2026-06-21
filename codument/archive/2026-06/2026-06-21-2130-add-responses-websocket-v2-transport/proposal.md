# 变更：Responses WebSocket v2 transport + previous_response_id 续传（add-responses-websocket-v2-transport）

## 背景和动机 (Context And Why)

codex/openai-responses 推理模型（gpt-5.5）单轮 repeat-read 不收口的真因已钉死：模型每轮发 reasoning + tool call、0 output_text；eidolon 的 HTTP-SSE adapter 丢弃 reasoning，模型跨工具轮丢推理链 → 重读 → 不收口。两条修复路在真机被代理挡住——stateless 加密推理回放代理不认；stateful `previous_response_id` 代理直接 `400: only supported on Responses WebSocket v2`。

eidolon 的 adapter 是纯 HTTP fetch/SSE，没有 WebSocket，所以用不了 previous_response_id、做不了推理续传。**真正的修复 = 给 eidolon 实现 Responses WebSocket v2 transport + 按 session 持久化 previous_response_id 续传**（服务端保留含 reasoning 的上轮）。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**
- **WS transport**：连 wss://.../responses（带鉴权头），send body JSON，收消息→事件，事件→chunk 解析与 SSE 共用；transport 选择 auto/websocket/http_sse；WS 失败回退 SSE。
- **previous_response_id 续传**：response_id 按 session 持久化（跨 per-call adapter），WS 下带 previous_response_id + store:true + 增量 input；HTTP SSE 下绝不带（避免 400）。
- 以**真机收口**为最终验收。

**非目标:**
- **不**动 Chat Completions（openai/deepseek）路径。
- **不**在 HTTP SSE 下发 previous_response_id。
- WS 不可用/失败 → 回退 SSE、不回归。
- **不**改 domain truth owner / 单写者 / prompt 构建。
- **不**修 history.xnl 持久化冻结（另记录）。

## 变更内容（What Changes）
- `OpenAIResponsesNodejsFetchAdapter.ts`：抽出 transport-agnostic 的事件→chunk 解析；新增 WS 传输（Bun `new WebSocket(url,{headers})` + send body + 收事件）；transport 选择；previous_response_id 续传（WS 下）。
- 续传状态：response_id 按 session 持久化（模块级 map 或 runtime 状态），修 `OpenAIResponsesDriver.ts:31` 每调用 new 致 lastResponseId 丢失。
- provider/connection 配置：加 transport_mode / supports_websockets / websocket_url（fhl_mom 标记可用 WS）。

## 影响范围（Impact）
- 受影响能力：`provider-responses-websocket`（新）。
- 受影响代码：`OpenAIResponsesNodejsFetchAdapter.ts`、`OpenAIResponsesDriver.ts`、provider 连接选项/配置。
- 相邻：history.xnl 持久化冻结（另记录，不碰）。
