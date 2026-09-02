# Design：Conversation 原生 Session Rewind 与 Repair

## 现状证据与根因

- `terminal/packages/tui/src/runtime/client/TuiRuntimeClient.ts` 的 `revert()` 只截断 `SessionState.messages/parts`，并设置 `info.revert`。
- `prompt()` 随后调用 `TerminalRuntime.turn()`；provider message list 来自 Conversation runtime，而非 TUI 数组。
- 当前持久化 History head、Prompt head、Session actor binding 和 provider epoch 均未移动，所以目标后的消息仍是 canonical history。
- 既有 `message-list-dialog.test.tsx` 使用 mock mode，只验证界面列表，无法发现 fresh restart 和 provider wire 泄漏。

## 权威映射

| 原有成熟能力 | Rewind 映射 |
|---|---|
| `ConversationSessionFork.resolveConversationForkPoint` | 复用 canonical selector、source digest、Prompt basis 与 tool-pair proof；same-session 不接受 surface index |
| `ConversationProviderContextTransitionGeneration` | 作为 History/Prompt/Session/provider receipt 同时提交的 same-session transaction，不新增平行 store |
| Conversation authority lease + receipt CAS | 从 proof read 到 transaction publish 保持同一 writer 边界；并发 turn 或第二个 rewind 必须有且仅有一个成功 |
| `synchronizeConversationDomainActorFromPersistence` | commit 后刷新运行中 VM，确保同进程下一轮与 fresh recovery 一致 |
| `history_rewind_or_fork` epoch reason | 新 receipt 以前一 receipt 为 predecessor，绑定新 heads/frontier，清空 admissions/facts/checkpoint |
| TUI projection read port | commit 后重新 hydrate；commit 前和 rejection 后保持旧 UI |

## Contract

新增 path-neutral 的 `ConversationSessionRewindCommand/Result/Receipt/Port`：

- selector 首版只允许 `through_committed_message`；current head 没有状态变化，应返回 typed rejection。
- command 携带 session/actor、可选 expected authority digest、occurredAt；不携带 messages、路径、repository 或 VM。
- receipt 同时记录 source heads、rewound heads、cutoff proof、previous/next provider receipt与transaction id。
- rejection至少覆盖session/actor/head缺失、message缺失或歧义、tool pair开放、Prompt不可证明、authority changed与busy/conflict。

## Planner

纯 Processor 读取完整 `ConversationForkAuthoritySnapshot`：

1. 通过共享 fork-point resolver 定位 active generation 中的 cutoff。
2. 生成新的 History generation id；复制到 cutoff 的 committed records，保持 record/message id，从而保留事件身份；`parentGenerationId`/`predecessorGenerationIds` 指向旧 active head，`createdReason="rollback"`。
3. 新 lineage 的 `rolledBackFromGenerationId` 指向旧 head；旧 lineage 增加 successor，但不删除旧 generation。
4. 复制并重绑定可证明的 Prompt generation，使 History refs 指向新 generation；旧 Prompt 保留但 active head 移到新 generation。
5. Session binding 与 activeSelection 同步指向新 heads；与目标 actor 关联的 provider facts、admissions、replay checkpoint 和 transient delivery 状态被移除。
6. 新 provider receipt epoch +1，previous receipt 指向旧 receipt，reason 为 `history_rewind_or_fork`，frontier digest 严格绑定 retained messages。

如果 active Prompt 包含 cutoff 之后的 message ref/History transform，或 target 在历史 compaction generation，返回 `PROMPT_STATE_UNPROVABLE` 且不生成 transaction。

## 持久化与恢复

复用 `commitProviderContextTransitionGeneration` 的 immutable generation、journal、fsync、head-last 和 CAS：

- `expectedEpochReceiptDigest` 是 rewind 前 receipt；`nextEpochReceiptDigest` 是 rewind receipt。
- History/Prompt generation 正文先写入当前 XNL authority，index/session/provider head 最后发布。
- 崩溃恢复只能得到旧 authority 或完整新 authority；未完整发布的 transition 不可发 provider request。
- 同 transaction 重试幂等；相同 source 上的竞争写入返回 authority conflict。

## Runtime 与 Surface

- Conversation Actor mailbox 暴露 rewind typed command；Terminal runtime 在自身 coordinator lane 执行。
- commit 后调用 persistence-to-domain synchronization，使同一个 runtime 的下一轮立即使用新 head。
- TUI local-runtime `revert` 先等待 capability；仅 committed 后清空 projection cache并重新 hydrate。typed rejection通过现有 error event/toast通道呈现。
- `unrevert` 在 local-runtime 明确返回 unsupported；它不能继续以清除UI字段冒充领域恢复。真正redo留给独立的branch-restore设计。
- mock mode保留纯UI模拟，明确不作为产品验收证据。

## 验证矩阵

- Planner：active-tail成功、missing/ambiguous id、open tool pair、historical compaction、Prompt future basis、source digest CAS。
- Persistence：transaction commit、fault recovery、idempotency、concurrent writer、provider epoch/admission/context asset cleanup。
- Runtime/TUI：A/B/C -> rewind A -> 同进程输入 D -> captured provider request含 A/D且不含B/C；fresh process结果相同。
- Unrevert：local-runtime明确unsupported且不改authority；mock mode仅保留UI测试模拟。
- Incident fixture：复制真实消息形态，证明surface-only旧行为失败、domain rewind修复；不直接修改运行中的用户现场。

## 并发边界

共享工作树中另一个session正在修改context fact语义。本 Track 不改变这些事实的命名/投影，仅在transaction中按actor清除rewind后失效的事实，并对共享文件使用局部patch。若exact block冲突，以`.tmp/chat.jsonl`协商。
