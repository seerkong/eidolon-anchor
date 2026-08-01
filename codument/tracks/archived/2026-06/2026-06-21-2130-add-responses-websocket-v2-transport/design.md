## 上下文
真因：HTTP-SSE adapter 丢 reasoning + 代理要求 WS 才能 previous_response_id 续传。修法 = WS transport + session-keyed 续传。约束：只动 responses 路径、WS 失败回退 SSE、HTTP SSE 绝不发 previous_response_id、不碰单写者/prompt。

## 方案概览
1. transport-agnostic 事件解析（先重构，零行为变化）
  - 把 `streamToOpenAIChunks` 内「event 对象 → yield chunk」的逻辑抽成纯生成器/函数 `responsesEventsToChunks(events)`（输入：event 对象序列；输出：Chat-Completions chunk）。SSE 路径喂「SSE 行 → JSON.parse」后的 event；WS 路径喂「WS 消息 data → JSON.parse」后的 event。reasoning 项保持现状（不在本 track 处理 reasoning 字段——续传由服务端保留）。
2. WS transport（P1）
  - URL：`build-responses-ws-url(baseUrl, websocketUrl?)`：/responses 的 https→wss。
  - 连接：Bun `new WebSocket(wsUrl, { headers })`（鉴权头，剥离 WS 控制头）；onopen 后 `ws.send(JSON.stringify(body))`；onmessage 收 JSON event → 喂解析器 → 产 chunk；onclose/onerror/[DONE] 收尾。
  - transport 选择：`resolveTransportMode(connectionOptions)`：auto（supports_websockets || websocket_url ? ws : sse）/ websocket / http_sse。
  - 失败回退：WS 连接/传输异常 → 标记 disabled、回退 HTTP SSE（本次或后续）。
3. previous_response_id 续传（P2，仅 WS）
  - response_id 持久化：模块级 `Map<sessionKey, lastResponseId>`（sessionKey 取 createStream 可得的 session/actor 标识；取不到则按 baseUrl+model 退化）。onResponseId 写入、构造时读出。修 per-call new adapter 致 lastResponseId 丢的问题。
  - 构造：WS 且有 previousResponseId 且有 tool 输出 → body.previous_response_id + store:true + input=增量（既有 Branch 1：仅 trailing tool items/outputs）；否则完整 input。
  - HTTP SSE：永不带 previous_response_id（守 case sse-never-sends-previous-response-id）。

## 影响范围与修改点（Impact）
- `OpenAIResponsesNodejsFetchAdapter.ts`：抽解析器 + WS 传输 + transport 选择 + previous_response_id 续传。
- `OpenAIResponsesDriver.ts`：把 session 标识传入 adapter（用于续传 key）；或在 driver 层持久化 response_id。
- provider 连接选项/`llm-provider.json`：transport_mode / supports_websockets / websocket_url（fhl_mom 开 WS）。

## 决策摘要
- 详见 decisions.md。D1 先重构解析器（零行为）再加 WS；D2 response_id 按 session 持久化（非单实例）；D3 HTTP SSE 绝不发 previous_response_id；D4 WS 失败回退 SSE。

## 风险 / 权衡
- WS 连接/鉴权/代理差异致连不上。→ 缓解：失败回退 SSE；连接超时；真机验证。
- session key 取不到致续传错配（跨 session 串）。→ 缓解：key 必含 session/actor；取不到则禁用续传（退化为完整 input，不串）。
- 重构解析器引入回归。→ 缓解：先抽纯函数 + 单测断言 SSE 路径 chunk 不变（零 net-new）。
- 增量 input 与服务端状态不一致。→ 缓解：仅在有 previous_response_id 时发增量；首轮完整。

## 兼容性设计
- 默认 auto：未标记 WS 的 provider 仍走 HTTP SSE，行为不变。Chat Completions 不受影响。WS 失败回退 SSE。

## 迁移计划
- P1 transport-agnostic 解析重构 + WS transport + transport 选择 + 回退（先红：WS url 派生、WS 事件→chunk 同 SSE、未标记能力回退 SSE）。
- P2 previous_response_id 续传（先红：response_id 按 session 持久化跨实例、chain 发增量+store、SSE 不发 previous_response_id）。
- P3 收口：全量回归 0 net-new + spec 覆盖 + **真机验证收口**（fhl_mom 开 WS，重置 session→重跑→output_text>0/停止重读/rc=0）+ findings 终态。真机不收口则记录边界。
- 回滚：transport 选择默认 SSE 即回退；分阶段 revert。

## 待解决问题
- session/actor 标识在 createStream 是否可得（续传 key）——P2 实现期定（必要时 driver 层传入）。
- fhl_mom 的 websocket_url 是否 = baseUrl 派生 / 需单配——P1 真机连一次定。
