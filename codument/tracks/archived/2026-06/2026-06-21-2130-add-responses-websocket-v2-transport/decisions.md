# Decisions

## Usage
- 记录需用户确认的决策；字母仅用于选项；后续新决策追加。

### 1. 【P0】先重构事件解析器再加 WS
- 决定：P1 先把 `streamToOpenAIChunks` 的「event→chunk」抽成 transport-agnostic 纯生成器（零行为变化，SSE 单测护住），再让 WS 复用。
- 决策理由：WS 与 SSE event 同形状；共用解析器避免两份逻辑漂移、降回归。
- 状态：resolved

### 2. 【P0】response_id 按 session 持久化（非单实例）
- 决定：response_id 存在按 session/actor 的 map，跨 per-call adapter 实例复用（修 `OpenAIResponsesDriver.ts:31` 每调用 new 致 lastResponseId 丢失）。取不到 session key 则禁用续传（退化完整 input），不跨 session 串。
- 决策理由：真机 PoC 证实单实例 lastResponseId 永远 undefined。
- 状态：resolved

### 3. 【P0】HTTP SSE 绝不发 previous_response_id
- 决定：previous_response_id 仅在 WS transport 下使用；HTTP SSE 下永不带（代理会 400）。
- 决策理由：真机实测 `400: previous_response_id is only supported on Responses WebSocket v2`。
- 状态：resolved

### 4. 【P1】WS 不可用/失败回退 SSE
- 决定：provider 未标记 WS 能力，或 WS 连接/传输失败 → 回退 HTTP SSE，不报错、不回归现有行为。
- 状态：resolved

### 5. 【P1】验收以真机收口为准
- 决定：最终验收 = fhl_mom 开 WS、重置真实 session、重跑，断言收口（rc=0、output_text>0、停止重读）。WS 连不上/不收口则记录边界与后续。
- 状态：resolved

### 6. 【P1】不在范围
- 决定：不动 Chat Completions 路径；不修 history.xnl 持久化冻结；reasoning 字段捕获/回放不做（续传由服务端保留）。
- 状态：resolved
