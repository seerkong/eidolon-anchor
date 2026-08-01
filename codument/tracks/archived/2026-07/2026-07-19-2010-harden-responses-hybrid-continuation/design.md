# Responses Hybrid Continuation Design

## 上下文

本地 Conversation 三域必须能独立恢复可见对话与动态上下文；OpenAI Responses 的 response id、encrypted reasoning 和原生 output items 是 vendor continuation material。它们能改善 reasoning continuity、延迟和回放完整性，但失效或丢失时不得让本地 session 不可运行。

## 方案概览

1. Canonical truth 与 checkpoint 分离
   - History/Prompt/Session domains 保持唯一 canonical context。
   - actor `continuationBaseline` 持有 epoch、latest response id 与 context digest。
   - Conversation context asset 持有一个 actor/provider/model/epoch scoped replay checkpoint；它是可替换、可失效的 `checkpoint_snapshot`，不进入 provider-visible messages。
2. 显式 request plan
   - transport send 前生成 `StatefulIncremental(previousResponseId,newItems)` 或 `StatelessReplay(fullNativeWindow)`。
   - Stateful eligibility：配置为 stateful、transport 支持、previous id 存在、baseline epoch/context digest 一致、checkpoint 与当前 materialized message prefix 匹配。
   - 任一条件不满足时不尝试修补旧 chain，直接 `previous_response_id=null/omit` 并发送 full replay。
3. Provider-native replay
   - transport 收集完整 `response.output` item；优先采用 `response.completed.response.output`，否则按 `output_item.done` 有序累积。
   - checkpoint 保存本次实际 request input + output，以及 materialized message fingerprint frontier。
   - 下一次 stateless request 在 prefix 匹配时发送 prior native window + canonical delta；失配则从当前 canonical messages 完整重建。
   - 不把 raw provider items强塞进 ChatMessage 或 semantic stream；executor 在 stream 消费完成后从显式 provider output 读取并写 checkpoint。
4. Continuation 生命周期
   - 删除 transport 模块级 Map；per-call adapter 不拥有跨 turn 真源。
   - executor 成功消费 response 后原子式推进本地 baseline（response id/context digest），并 upsert replay checkpoint。
   - projection revision/source delivery、compaction、system/profile/model/tool schema 变化导致 epoch 或 digest 不匹配，旧 continuation 自动不可达。
   - WS→HTTP fallback 使用同一 request planner 生成 stateless full body，不从 WS 增量 body做临时反向修补。
5. Cache-friendly materialization
   - 从同一次 materialized provider messages 中提取所有 system-role 文本；该有序列表是 Responses system context 的单一输入，不为 TaskTree、Skill、Read 或 mission 分支。
   - Responses wire instructions 顺序固定为 transport instructions → sandbox instructions → provider-configured instructions → materialized system messages；精确重复的非空 section 只保留首个。
   - 同一次 instruction assembly 同时产出完整 wire instructions 与 stable instructions：完整值供 request plan/context digest、request observation 与 wire body 使用，稳定值只供 prompt cache key 使用，禁止分支自行重建。
   - 固定 transport/sandbox/provider-configured instructions 构成稳定前缀；work-context 与 mutable projection 虽处于 instructions 后部，仍是 provider-visible system context。
   - work-context 与 mutable projection 放在固定 conversation boundary；不随“最后 user”移动。
   - `prompt_cache_key` 由 provider/model/stable instructions/tool schema fingerprint 派生并稳定复用；不包含 work-context、mutable projection、动态对话、API key 或 session 随机 UUID。
6. Native completeness 与 lineage closure
   - transport 只收集 `completed.output`、indexed `output_item.added/done` 与 function-call deltas 的原始证据；typed contract 表达 evidence 与 completeness decision。
   - pure logic 重建候选 native output，并比较 completed/done/added+deltas 的顺序、索引、item id 与 call id。空或冲突的 completed output 不得覆盖已观测到的 function call。
   - call-id 闭包按完整 lineage 校验：stateful 增量可引用 previous response/checkpoint 中的 function call；stateless native replay 校验 native window；canonical rebuild 校验当前完整 canonical input。
   - 旧版本或没有 completeness proof 的 checkpoint 自动失效。不完整 provider outcome 不写 checkpoint、不推进 continuation baseline；native lineage 无效先 canonical rebuild，canonical 仍存在 orphan/duplicate/out-of-order/empty call id 时在 observation 与 transport I/O 前本地失败。
   - 兼容上游 `completed.output=[]` 不改变上述门槛：只有 indexed added/done/delta evidence 自身具备完整 index、terminal done、item/call identity、稳定顺序，且完整 call lineage 闭合时，pure logic 才能发布 `reconstructed_event_items` proof。
7. Request/outcome observability
   - send-before request observation 显式携带 plan kind、replay source、previous-id 采用/拒绝及 reason；`fallback_used` 只在真实 fallback 后由 outcome 事实表达。
   - response-after outcome 是独立 append-only observation，按 session/provider-call/provider-attempt/transport-attempt identity 与 request row 关联，记录 transport terminal state、actual fallback 与 completeness decision。
   - immutable observation data/port 属于 cell contract，decision 由 cell logic 产生；`terminal/packages/organ-support` 独占 `bun:sqlite` effect 与 schema migration，`terminal/organ` 只绑定 port/lifecycle。sink 始终 fail-open，不反向参与 planner 或 live loop。

## 影响范围与修改点（Impact）

- `cell/packages/ai-core-contract/src/LlmTypes.ts`：provider continuation/output 的通用数据面。
- `cell/packages/ai-organ-contract/src/llm/ProviderRuntime.ts`：Responses request-plan/runtime contract。
- `cell/packages/ai-organ-contract/src/conversation/LocalConversationContextAsset.ts`：provider replay checkpoint fact。
- `cell/packages/ai-organ-logic/src/llm/{ResponsesInputItems,ResponsesContinuation,OpenAIResponsesNodejsFetchAdapter,ProviderRuntimeAdapter}.ts`：纯 planning、transport capture 与显式 runtime wiring。
- `cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts`：context digest、checkpoint read/write、baseline advance。
- `cell/packages/ai-support/src/conversation/local/LocalConversationRuntime.ts`：固定动态锚点与 checkpoint persistence round-trip。

## 决策摘要

- Local canonical context 是唯一真源；stateful continuation 不是 recovery 输入。
- response id 和 replay checkpoint 分属 baseline pointer 与 vendor checkpoint，不用模块级共享 Map。
- provider-native replay 是 Responses adapter 的一般机制，不改变其他 provider 的 message replay。
- system-role 文本与普通物化文本共用同一 message assembly 输入；Responses 只在 provider adapter 边界把 system role 编译为 wire instructions，不在 terminal 注入新 prompt。
- full replay 永远是 fallback；stateful 失败不会继续发送截断的 tool-only body。
- 当前代理的 HTTP previous-id 限制只作为 capability 处理，不上升为 OpenAI API 通用规则。

## 风险 / 权衡

- 原生 output items 可能较大 → checkpoint 单 actor/current revision 覆盖写，不追加历史；compaction/epoch reset 后不再使用。
- checkpoint 与 actor baseline 分步写入 → eligibility 同时校验 epoch/digest/frontier，任一不一致即 full replay，不冒险续链。
- provider terminal event 可能自相矛盾或缺项 → 保留原始 evidence，经单一 pure decision 判完整性；不得让 adapter/executor/SQLite 各自猜测。
- system content 合并可能影响 exact-prefix cache → 固定 section 顺序，仅对精确重复去重，动态 section 放在稳定 instructions 之后；测试断言稳定值是完整 wire instructions 的精确前缀，并用 ledger 直接比对 observation/wire。
- 固定动态锚点改变当前 late placement → 加 materialization golden/pair tests，保证 system 在前、对话顺序与工具配对不变。
- 当前不复用长生命周期 WS → 保留已有正确性与 reasoning continuity，连接级 latency 优化后续用指标驱动。

## 兼容性设计

- 旧 session 无 replay checkpoint/context digest 时自动走 canonical full replay，并在下一次成功 response 后建立新 checkpoint。
- 非 Responses provider 忽略 provider replay contract，行为不变。
- 旧 provider options 未显式设置 continuation mode 时，WS 路径保持 stateful 优化；显式 stateless 时禁用 previous id。
- observation ledger 继续记录实际 send body，不读 checkpoint、不影响 request planning。
- provider 显式配置的 instructions 参与统一合并，不得被 Codex transport defaults 静默覆盖；非 Responses provider 不走该编译路径。

## 迁移计划

1. 先补纯 request-plan、native item capture、cache key 与 invalidation 失败测试。
2. 实现 transport 显式 provider output，删除模块级 response-id store 和重复 input builder。
3. 接入 Conversation replay checkpoint、actor baseline advance 与固定动态锚点。
4. 补齐 native completeness/lineage closure 与旧 checkpoint 失效，阻止孤立 function output 进入 provider body。
5. 扩展 request/outcome ledger schema 与 attempt identity 关联，显式保存 planner/outcome 事实。
6. 统一组装 Responses wire instructions，让全部 materialized system messages 与 configured instructions 进入实际请求，并与 digest/observation 同源。
7. 在严格 indexed evidence 与 lineage proof 下兼容空 terminal output，同时补齐旧 WS fixtures。
8. 跑 Responses/Conversation/executor/persistence/ledger 定向测试及 typecheck。
9. 使用 provider request ledger 有界恢复目标 session；直接比较 request plan/instructions/outcome/body，确认 mission 真正移入 archived 目录。

## 待解决问题

- 持久 WebSocket connection-local cache、`store:false`/ZDR 与连接重建策略需要单独 runtime effect/lifecycle 设计，不在本 track 混入。
