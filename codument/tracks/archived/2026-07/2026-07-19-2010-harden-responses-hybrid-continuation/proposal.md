# 变更：加固 Responses 混合状态与原生回放

## 背景和动机 (Context And Why)

当前 Responses transport 把 `previous_response_id` 保存在模块级 Map，并在 WS 下隐式启用 stateful chain；无状态 fallback 则从普通 ChatMessage 重建输入，丢失 Responses 原生 reasoning/phase items。动态 overlay 还会随最后一个 user 移动，full replay 的 exact prefix 与 prompt cache key 都不稳定。任一 continuation 丢失、进程恢复、上下文 revision 变化或 WS→HTTP fallback，都可能让 provider 实际看到的上下文与本地 canonical context 不一致。

## “要做”和“不做” (Goals / Non-Goals)

**目标:**

- 让 Conversation domains 成为唯一 canonical context，stateful Responses 只是一层可丢弃优化。
- 用显式 request plan 决定 StatefulIncremental 或 StatelessReplay，并对所有 provider-visible baseline 变化失效旧 chain。
- 保存、恢复并回放 Responses 原生 input/output items，包括 encrypted reasoning、assistant phase 与 compaction-compatible items。
- 只有在原生 output 证据完整、且 request lineage 的 function-call 闭包有效时才发布可重放 checkpoint；无法证明时退回 canonical rebuild 或在发送前本地失败。
- 去掉模块级 response-id Map，让 actor continuation baseline 持有 response id/context digest。
- 把动态状态固定在 system prefix 与 conversation history 的语义边界，并将所有物化 system messages 按确定顺序编译进 Responses wire instructions。
- 使 Responses context digest、prompt cache key、request observation 与 wire instructions 共享单一 assembly 真源。
- 保持 provider request SQLite ledger 可观测每次最终 send body，用于目标 session 验证。
- 让 provider request SQLite ledger 显式关联 send-before request plan observation 与 response-after outcome，而不是从 wire body 反推 planner 事实。

**非目标:**

- 不引入 Skill、TaskTree、Read、mission 或重复循环名称特例。
- 不增加调用次数限制、无进展检测、循环纠偏或 prompt-only guardrail。
- 不把 provider replay checkpoint 变成 History、recovery 或产品事实源。
- 不在本 track 重写持久 WebSocket 连接池/60 分钟连接生命周期；连接复用属于后续可测性能改造。
- 不切换到 Conversations API，也不删除 HTTP SSE fallback。

## 变更内容（What Changes）

- 增加 provider replay snapshot/checkpoint 与 continuation request-plan 数据契约。
- 用纯 Responses input planner 合并 canonical message delta、prior native window 和本轮 output。
- transport 捕获完整 `response.output` 与 response id，并通过显式结果返回 executor。
- transport 输出原始 Responses event evidence，由纯 logic 重建并裁决 snapshot completeness 与 lineage closure；不完整 output 不推进 checkpoint/baseline。
- 当 terminal `completed.output` 为空时，只有 indexed event evidence 和 call lineage 能独立证明完整性才允许重建；其他情况继续 fail-closed。
- executor 在成功 provider completion 后推进 actor continuation baseline、写入 Conversation replay checkpoint；失败/中止不推进。
- continuation 只有在 mode/capability/id/epoch/context digest 全匹配时才发送增量，否则新建 full chain。
- full replay 使用稳定 prefix-derived `prompt_cache_key`，并移除 per-request UUID。
- materializer 把 work-context/projection overlays 放到固定 conversation boundary。
- Responses adapter 从物化 messages 中统一提取 system-role 文本，与固定 transport/sandbox/provider-configured instructions 按确定顺序合并，不重复、不丢失。
- 增加 request body、native item、recovery、baseline invalidation、cache key 和原 session 回归验证。
- 扩展顶层 support SQLite ledger，记录 plan/fallback/previous-id decision 与 attempt-scoped outcome completeness；sink 保持 fail-open 且不参与 planning。

## 影响范围（Impact）

- 受影响能力：`provider-responses-websocket`、`ai-runtime-work-context-control`、`ai-runtime-observability-rx-sinks`
- 受影响代码：LLM contract、Responses request/input/continuation/completeness helpers、Responses transport、provider driver/runtime adapter、Conversation context asset/runtime/materializer、executor continuation lifecycle、terminal 顶层 SQLite support effect 与定向测试
