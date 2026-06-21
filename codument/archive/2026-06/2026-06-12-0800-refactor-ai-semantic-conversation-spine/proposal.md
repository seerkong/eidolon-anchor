# 变更：AI Semantic Spine 与 Conversation 三域主干

## 背景和动机 (Context And Why)

当前传给大模型的消息列表来自 `actor.messages` 裸内存数组：drain 阶段十余处直接 push、compress 原地重写、provider build 从数组组装。已存在的 Conversation 三域 runtime（History/LLM Context/Session）只是"账本"——prompt generation 记账与实际发送内容平行计算，无结构性一致保证；恢复时数组与三域靠一次 bootstrap 双向对齐后再分头演化，且存在 conversation→transcript 双源 fallback。这是"重复读文件"类事故的核心边界。

本 track 把三域升格为**会话期间的内存唯一真源**：所有会话输入以 semantic 事件入流、**vm.eventBus 是 semantic 事件的唯一传输、MessageHistoryGraph 是 vm 上唯一的 commit 入口**，providerMessages 改为三阶段 materialize 的纯投影，恢复改为"文件→一次性水合→切换点后文件退出 live"的单向交接，**actor.messages 降级为 History 域投影的只读 facade getter**，并**彻底删除 actor transcript（含 session-upgrade 的读取）**。流式加工 pipeline（ingress→lexical→syntactic→semantic）保持不变，其提交边界形式化为 MessageAssembly capsule。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**

- 为 Ingress / LexicalSyntactic / SemanticEvent 三个 stage 组件补 DataSubgraphContract（加入既有 registry）。
- ConversationDomainRuntime + LocalConversationRuntime **全量 capsule 化**（conversationCapsule；类型全部在 contract 包），含三个 derivation contract：ConversationReducerDerivation（命令→三域状态）、MessageAssemblyDerivation（semantic→committed 消息）、MaterializationDerivation（三阶段投影）。
- **semantic 流保持枢纽地位**：所有会话输入以 semantic 事件入流，流仍是 TUI/观测/扩展衍生的唯一规范入口；可观测性显式分层（流级 vs 域级）。
- **Single-writer pipeline**（P8，方案 X，用户裁定）：vm.eventBus 是 semantic 事件的唯一传输，MessageHistoryGraph 是 vm 上唯一的 commit 入口（消费 eventBus → 归约 → 写 History 域）；graph 常驻 attach（不挑 actor 类型）；非流式来源（childDone / member chat / coordination / heartbeat / 种子 / effect 回放）改为在 eventBus 上发完整 semantic 事件序列；删除 injectSemanticEventsIntoConversationDomain 及三个 fence 标记（deliveredViaSemanticStream / emittedOnSemanticStream / committedViaSemanticStream）。
- **真源切换**：executor 的 drain push 收口为 semantic 事件发射（用户输入/工具结果/childDone 语义级入流）；三域唯一写入者为消费流的 Reducer/MessageAssembly；compress 改走域内 compaction；provider build 的输入改为 materialize(Session 选择 → History tail → Context 变换) 的纯投影；`actor.messages` 裸数组退出 provider 真相角色。
- **恢复单向化**：显式恢复阶段唯一恢复源为会话文件；一次性水合三域后到达切换点，文件退出 live 路径；删除"数组反灌三域"的 bootstrap 双向同步。
- **transcript 彻底删除**（用户决策）：`LocalFileActorTranscriptStore`、`ActorTranscript` contract、transcript 写入效应、恢复 fallback、recovery report 的 transcript 来源字段、**以及 session-upgrade 工具内的 legacy transcript 读取**全部删除；仅含 transcript 的旧 session 升级/恢复时显式拒绝。
- 行为等价验收：同一输入序列下新旧路径产出的 providerMessages 等价；既有失败基线不增。

**非目标:**

- 不修改流式加工 pipeline 的 stage 逻辑（lexical/syntactic/semantic 算法不动）。
- 不处理 tool result truth 与 turn state 的归属（ToolCall 域语义与 supervisor 移除归 Track-5：refactor-ai-turn-tool-provider-lifecycle）。
- 不迁移 persistence backplane（checkpoint/journal 机制不动；只改它们观察的对象）。
- 不做旧 session 数据修复——transcript-only session 直接拒绝，不造转换 shim。
- 不改 TUI 渲染逻辑（其输入改为正式投影 view，渲染不动）。

## 变更内容（What Changes）

- 新增 stage 三组件与 conversation 三 derivation 的 contract（ai-core-contract / platform 已有机制复用）。
- ai-organ-logic 新增 conversationCapsule（吸收 ConversationDomainRuntime）；ai-support 的 LocalConversationRuntime 重构为 capsule 的持久化 adapters。
- AiAgentExecutor：drain 推送改命令、provider build 改 materialize 输入、compress 走域命令。**BREAKING（内部）**：`actor.messages` 不再是 provider 真相；对外导出经兼容 facade 维持。
- RuntimeSnapshots / 恢复链：单源水合 + 切换点；删除 bootstrapConversationHistoryFromMessages 的反灌路径。
- **BREAKING**：删除全部 transcript 代码与文件格式支持；transcript-only 旧 session 不可升级、不可恢复（显式错误）。
- **P8 Single-Writer Pipeline**（决策 8）：graph 常驻 attach；非流式来源迁移到 eventBus emit；删除 injectSemanticEventsIntoConversationDomain、conversationCommitGraphAttachCount、deliveredViaSemanticStream/emittedOnSemanticStream/committedViaSemanticStream；appendLiveHistoryMessageToConversationDomainRuntime 全仓只有 graph commit 旁路一处调用。
- spec 同步：`aiagent-persistence-recovery` 中 transcript 相关恢复语义删改。

## 影响范围（Impact）

- 受影响的功能规范：`ai-semantic-conversation-spine`（新增）；`aiagent-persistence-recovery`（transcript 语义删改）；`runtime-data-subgraph-contracts`（stage 组件加入 registry，追加不冲突）。
- 可能影响的代码区域：
  - `cell/packages/ai-core-contract`（stage/conversation derivation 与 capsule 类型；ActorTranscript contract 删除）
  - `cell/packages/ai-organ-logic`（conversationCapsule、AiAgentExecutor、MessageHistoryGraph→MessageAssembly、RuntimeSnapshots 恢复链）
  - `cell/packages/ai-support`（LocalConversationRuntime capsule 化、LocalFileActorTranscriptStore 删除）
  - `cell/packages/ai-runtime-control-composer`（session-upgrade 的 transcript 读取删除）
  - `cell/packages/ai-file-store-logic`（legacy transcript 迁移读取删除）
  - `terminal/packages/*`（recovery report 显示字段、相关测试）
