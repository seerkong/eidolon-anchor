# 设计：AI Semantic Spine 与 Conversation 三域主干

## 上下文

前置已交付：DataSubgraphContract（含 History/LlmContext/Session 等 10 组件 owner 声明）、控制面边界契约与三集群 capsule 化。本 track 把数据面从"声明"推进到"真源"：三域成为会话期间的内存唯一真相，providerMessages 成为纯投影，恢复成为单向交接，transcript 彻底退出。

## 目标态总览

### 图 A：事实真源与衍生投影

```text
provider 流(经 lexical/syntactic)   用户输入·工具结果   childDone·问卷
        │                                │                │
        ▼                                ▼(语义级入流)     ▼
┌──────────────── semantic 事件流 · 规范时间线 · 唯一扩展点 ─────────────────┐
        │(唯一写入者: Reducer + MessageAssembly 归约)    │只读        │只读
        ▼                                     [流级 TUI 投影]  [流级可观测]
┌─────────────────────────────────────────────────────────────────┐
│            Conversation 三域 · 内存唯一真源                        │
│  [History 域]            [LLM Context 域]        [Session 域]    │
│  committed 消息·世代头     basis·变换·overlay      绑定·heads·谱系 │
└─────────────────────────────────────────────────────────────────┘
   │ materialize(三阶段纯投影)      │只读(域级)
   ▼                              ▼
[providerMessages → LLM]     [域级投影·可观测: committed 历史·世代级·衍生索引]
   ┆
   ┆ 仅 safepoint 单向写入（虚线）
   ▼
┌─ 持久化观察者 · 永不回写 live ───────────────────────────────────┐
│ [会话文件 history/prompts/index] [runtime snapshot] [journals]   │
└─────────────────────────────────────────────────────────────────┘
```

### 图 B：恢复单向交接

```text
进入显式恢复 → 恢复分类(heads·cohort·effect WAL) ─dirty→ 拒绝静默恢复
     → 读取唯一恢复源（会话文件；无任何 fallback）
     → 一次性水合内存三域
     → 水合 VM/actor/fiber + durable 信号重放
     → 切换点：文件退出 live 路径（此后仅内存真源生效，不再回读）
     → live 循环恢复（三阶段 build → providerMessages）
```

### 图 C：与流式 pipeline 的关系

```text
provider 流 → [ingress → lexical → syntactic] ─┐
用户输入·工具结果·childDone（已结构化，语义级入流）─┤
                                              ▼
                          semantic 事件流（规范时间线·唯一扩展点）
                              │                    └→ 流级 TUI/观测（只读订阅）
                              ▼
            ConversationReducer + MessageAssembly（唯一写入者·归约）
                              ▼
                    三域真源 ──→ 域级投影/可观测（committed·世代级）
                              ▼
                    三阶段 materialize → 下一轮请求
```

修正记录（decisions.md 决策 6）：用户输入与工具结果不直写 History 域，而是以 semantic 事件入流；三域唯一写入者是消费流的 Reducer/MessageAssembly。这保住了 semantic 流作为扩展衍生唯一入口的原则，TUI 的工具卡片/actor 消息功能继续从流级投影获得数据。可观测性显式分两层：流式输出关注从 semantic 流衍生；committed/世代级关注从 MessageAssembly 产物或 History 域衍生。

## 方案概览

### 1. Stage 组件契约

为 `ingress_stage`、`lexical_syntactic_stage`、`semantic_event` 三组件补 DataSubgraphContract 并加入既有 `createAiRuntimeDataSubgraphRegistry`（10→13）。semantic_event 的 owned facts 为规范语义事件流（domain_canonical_event 级）；上层 projector 不得直读 parser state（Not Owned Here + forbiddenLiveReads）。

### 2. conversationCapsule（全量 capsule 化，用户决策）

- 位置：`ai-organ-logic/src/conversationCapsule/`（coreLogic / adapterRegistry / adapters / internals）。
- ConversationDomainRuntime（约 1944 行）实现移入 internals；纯归约/投影函数提升为 derivation 实现；coreLogic 暴露稳定入口与命令 API；原模块路径保留为兼容 facade。
- LocalConversationRuntime / LocalFileConversationPersistenceRepository（ai-support）重构为该 capsule 的持久化 adapter 实现（writer/loader adapter 按枚举 id 注册，组装层布线）——与 engine file_store adapter 同模式。
- 三个 derivation contract（类型在 ai-core-contract）：
  - ConversationReducerDerivation：initializeConversationState / applyCommand（命令→三域状态 + 事件）/ projectVisibleHistory。
  - MessageAssemblyDerivation：initializeAssemblyState / reduceSemanticEvent（→{state, committed?}）——吸收 MessageHistoryGraph 归并语义。
  - MaterializationDerivation：materializeProviderContext(三域 state) —— 三阶段：Session 选择 → History active tail → Context 变换/overlay。
- capsule 不含 types；全部类型在 contract 包（既定决策同构）。

### 3. 真源切换（风险核心）

- drain 收口：executor 十余处 `messages.push` 改为发射 semantic 事件入流（user/tool/childDone 在语义级注入，不经 lexical/syntactic）；三域写入只发生在 Reducer/MessageAssembly 消费流处。
- assistant 收口：MessageAssembly 提交即写 History 域；executor 不再持有平行 assistant 副本。
- compress 收口：走域 compaction 命令（compact generation + summary transform），域命令是唯一真相落点；压缩闸门与策略上下文评估域物化产物；汇总（compressHistory）的输入读自域 history tail 物化；**不存在数组原地重写**。（实施偏差记录：T4.2/T4.3 曾以"汇总输入读成对同步镜像 + 原地重写仅作镜像同步"的中间态交付，round-2 gap-loop 曾改写本条迁就实现；用户裁定目标不降级，P7 按本条原始目标收口。）
- provider build：`buildProviderPromptForActorTurn` 的消息输入改为 MaterializationDerivation 产物；work context overlay 成为 Context 域 transform 的一种（既有 recordPromptPlan 路径自然归位）。
- `actor.messages`：切换后降级为 **History 域投影的兼容只读视图（facade getter，冻结数组），任何写入路径删除**。不存在任何从该视图进入 provider 组装的路径——包括 prompt-plan 系统通道快照：系统提示来源是 `actor.systemPrompts` + identity reinjection（经域命令记入 Context 域 Stage-1 后物化），不读消息数组。fiber/delegate/恢复链等既有消费者读取的是同一只读投影（域写入间引用稳定）。（实施偏差记录：T4.2/T4.3 曾以"可写兼容镜像 + 成对同步写 + 系统通道快照读数组"的中间态交付；round-1/round-2 gap-loop 曾两次改写本条迁就实现。用户裁定该降级无效——track 要求唯一事实真源，actor.messages 是被治理的关键对象；P7 Mirror Elimination 按本条原始目标收口。）
- 等价性闸门：新旧路径并行影子对比测试（同一脚本化输入序列 → providerMessages 逐消息等价）通过后才允许删除旧路径。

### 4. 恢复单向交接

- 唯一恢复源：会话文件（history/prompts/session.index）。**无 transcript fallback**。
- 水合：文件→三域一次性；删除 `bootstrapConversationHistoryFromMessages` 反灌；`loadConversationRuntimeMessages` 的双源选择逻辑删除。
- 切换点显式化：恢复完成标记后，任何 live 代码路径读会话文件即违例（conformance 断言）。
- dirty/悬挂 effect 在水合前由既有 `decideRecovery` 拒绝（已交付，不动）。

### 5. transcript 彻底删除（用户决策：含 upgrade 读取）

删除清单：`ActorTranscript` contract（ai-core-contract）、`LocalFileActorTranscriptStore`（ai-support）、transcript 写入效应与调用点、恢复 fallback、`VmRecoveryReport.actorTranscriptSources`、session-upgrade 内 legacy transcript 读取（composer/file-store-logic）、相关测试与 fixtures。仅含 transcript 的旧 session：升级与恢复返回显式错误（不静默、不转换）。

### 6. Mirror Elimination 收口（P7，用户裁定补入）

T4.2/T4.3 交付的"成对同步可写镜像"中间态与决策 1 的唯一真源模型冲突（靠写入纪律而非结构保证一致；round-2 自证的"压缩侧门回流"理论风险即其证据）。P7 在本 track 内按原始目标收口，步骤按风险递增：

1. **读 API**：capsule coreLogic 暴露 `getConversationVisibleMessages(vm, actorKey)`——History 域 active tail 的 committed 消息只读投影；域写入 bump revision，按 revision 缓存冻结数组（域写之间引用稳定，fiber 持有引用不抖动）。
2. **parity golden（删除前录制）**：等价 harness 场景上断言"域投影 == 旧镜像内容"逐消息相等（含 `tool_calls`、anthropic `content_parts` shape 保真），绿了才允许删写入。
3. **杀写入点**：(a) prompt build 删 `messages` 入参，系统提示从 `actor.systemPrompts` + identity 直接计算；(b) 三条 compress 路径输入改读域 tail 物化、结果只落域命令、删全部原地重写（含 cheap compaction 镜像侧）；(c) 三个 append helper 删 mirror push；(d) 恢复链删 `splice` 反向投影；(e) 种子只走 semantic 注入，`createActor` 不再接收消息数组。
4. **getter 翻转**：`actor.messages` 改为绑定注入的只读冻结投影 getter（contract 类型 `readonly`，tsc 枚举残余写入者；冻结使漏网写入响亮失败而非静默分叉）；actor 在 ai-core-logic、capsule 在 ai-organ-logic，依赖方向用注入解决（actor 注册时绑定投影函数）。
5. **fiber 去数组**：fiber record / loop 签名的可变 `messages` 工作数组移除，loop 内一律读 actor 只读投影。
6. **读者迁移与 conformance**：全部读取点（fiber/delegate/恢复推断/organization/runtime-control/terminal compact 等约 12 处）迁移到域视图；源级禁写扫描 + 冻结写入负向测试 + spec case mirror-eliminated 覆盖；既有"系统通���受限例外"钉死测试反转为"路径不存在"。

### 7. Single-Writer Pipeline 收口（P8，方案 X，用户裁定补入）

P7 收口完 actor.messages 镜像之后，三域内仍有两条独立 commit 路径：① 经 vm.eventBus 的 MessageHistoryGraph（流式 token、emitUserInput、emitToolCallResult）；② executor 的 `injectSemanticEventsIntoConversationDomain`（childDone / member chat / coordination / heartbeat / 种子 / effect 回放，以及对 ① 已发事件的 fallback 兜底）。两者共享同一 `reduceHistoryProjection` 纯核心，但 commit 入口有二，靠引用计数 + 三个布尔标记（`deliveredViaSemanticStream` / `emittedOnSemanticStream` / `committedViaSemanticStream`）做 fence。该 fence 的失败形态（新增通道漏标、isHistoryTrackedActor 判定变化、嵌套 attach 漏 detach）无源级 conformance 守护——这与决策 6 字面的"唯一写入者"直接冲突。

P8 在 P7 之后按 mission 005 "rule 一：Provider LLM Context View 只有一个来源" 的同构语义把"事实写入入口"也收口到一处：

**Target 形态**：

```
所有 semantic 事件源（流式 + 非流式）
        │ vm.eventBus.emit*(...)
        ▼
   MessageHistoryGraph（常驻 attach，per-vm 单例）
        │ consumeSemanticEvent → reduceHistoryProjection
        ▼
   onCommittedMessage → appendLiveHistoryMessageToConversationDomainRuntime
        │
        ▼
   Conversation 三域（内存唯一真源）
```

**实施步骤**（风险递增，每步过 parity + 等价闸门）：

1. **非流式通道 emit 入口补全**：为 childDone / member chat / coordination / heartbeat / 种子 / effect 回放 在 vm.eventBus 上提供合法 semantic 事件 emit 入口（构造 inject 现有的 user_input / tool_call_result / content+tool_plan+turn_end 序列）；可复用既有 `emitUserInput` / `emitToolCallResult`，复合事件序列提供薄 emit 包装。
2. **graph 常驻 attach**：`attachMessageHistory` 改为在 vm 启动 / conversation runtime 初始化时常驻挂上，**不挑 actor 类型**（`isHistoryTrackedActor` 不再 gate attach 决策——它仍可保留作其它语义判断，但与 graph 写域解耦）；引用计数仍可保留作并发安全，但 fence 语义不再依赖它。要求 vm.eventBus 必须存在（无 eventBus 启动显式失败，给出清晰错误）。
3. **通道逐个迁移**（按风险递增）：heartbeat → member chat → member coordination → childDone → 种子 → effect 回放 → 最后切 user input/tool result（这两个 emit 路径已经存在，删除 append 助手内的 inject 兜底分支即可）；每步重跑 parity + 等价闸门 + 全量基线对照。
4. **删除 inject 实现与全部 fence**：删除 `injectSemanticEventsIntoConversationDomain`、`getConversationSemanticInjectionMap`、`ConversationSemanticInjectionState` 类型、`runtimeContext.conversationSemanticInjection` 字段；删除 `adjustConversationCommitGraphAttachment` / `isConversationCommitGraphAttached` / `conversationCommitGraphAttachCount`；删除三个 boolean 标记参数；`appendConversation*Message` 三个助手要么删除（调用点直接调 emit），要么保留为 pure-emit 薄包装。
5. **源级 conformance**：全仓 src 扫描 `appendLiveHistoryMessageToConversationDomainRuntime` 调用点，只允许 MessageHistoryGraph 的 `onCommittedMessage` 旁路一处；spec case `writes-via-eventbus-only` 可执行覆盖（任何 commit 必须前置一个 eventBus emit）。

**风险与缓解**：

- 风险：非流式事件被现场构造，可能与流式来源在语义形状上有差异（e.g. 没有 `delta` 阶段、turn boundary 不同）。
  - 缓解：现有 inject 已经在 emit 完整序列（start/delta/end + tool_plan + turn_end），P8 只是改派发去向；parity golden 钉死提交结果不变。
- 风险：graph 常驻 attach 意味着 detached / delegate actor 的事件也走 graph，而 graph 内部按 agentKey 分桶——`MessageHistoryGraph` 已支持此（attach 期间贯穿全部 actor），但需验证 detached actor 不触发 history persistence 副作用（appendMessage / recordTranscriptEvidence 应按 actor 类型 gate）。
  - 缓解：persistence/transcript 副作用的 gate 仍可读 `isHistoryTrackedActor`（与 commit 写域解耦），保留既有持久化语义。
- 风险：eventBus 缺失场景（headless 极简单测）。
  - 缓解：conversation runtime 初始化时断言或注入空 eventBus 默认实现；prod 路径（cli/tui/headless）今天都已挂 eventBus，无回归面。

## 影响范围与修改点（Impact）

见 proposal.md Impact。

## 决策摘要

- 详见 `decisions.md`。关键结论：内存唯一真源 + 三阶段 build + 恢复单向交接（用户定义的目标模型）；conversation runtime 全量 capsule 化；transcript 连 upgrade 读取一起全删，旧 transcript-only session 显式拒绝；流式 pipeline 不动，只形式化提交边界；镜像中间态被用户裁定无效，P7 按只读 facade getter 目标收口（决策 7）；inject 旁路被用户裁定无效，P8 按 vm.eventBus + MessageHistoryGraph 单写者收口（决策 8、方案 X）。

## 风险 / 权衡

- 风险：真源切换改变消息组装路径，等价性破坏即重复读类回归。
  - 缓解：影子对比测试先行（providerMessages 逐消息等价）；分阶段切换（先并行后删旧）；既有失败基线对照。
- 风险：transcript 全删使旧 session 不可用。
  - 缓解：用户明确接受；拒绝错误信息指明原因；删除集中一个 phase 便于审查。
- 风险：conversationCapsule 体量（约 3000+ 行跨两包）。
  - 缓解：沿用 driver capsule 的机械手术模式（facade + internals + 类型回引），逐包推进，每步基线对照。
- 风险：等价性测试本身的覆盖盲区（overlay 位置、compaction 时机）。
  - 缓解：用真实事故 session 的输入序列做 fixture（mission 资产）；gap-loop 对抗复核。
- 风险：P7 getter 翻转破坏持有 `actor.messages` 引用的既有路径（上次因此放弃）。
  - 缓解：翻转放在全部写入点收口**之后**（届时数组只被读，语义差为零）；parity golden 先行钉死内容等价；revision 缓存保证引用稳定；contract 类型改 `readonly` 让 tsc 枚举残余写入者；冻结数组让漏网写入在测试中响亮失败——基线破坏正是要捕捉的信号。
- 风险：P8 graph 常驻后 detached/delegate actor 的 history persistence 副作用触发面变化（appendMessage / transcript evidence）。
  - 缓解：写域路径与持久化副作用解耦，commit 写域无条件，appendMessage / transcript 副作用仍按 actor 类型 gate；新增 detached actor 不触发 persistence 副作用的源级与行为 conformance。
- 风险：P8 非流式 emit 序列与流式来源在 turn boundary、reasoning 段、tool_plan 顺序上不一致，导致 graph 内归约出与 inject 不同的 committed shape。
  - 缓解：inject 现有的序列就是合法 semantic 形状（assembly derivation 已基于它绿）；P8 改派发不改内容，parity + 等价 golden 钉死提交结果不变。

## 待解决问题

- 无；八个决策均已确认（见 decisions.md）。
