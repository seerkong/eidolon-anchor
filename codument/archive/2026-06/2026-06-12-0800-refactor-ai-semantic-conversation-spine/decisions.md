# Decisions

## Usage
- 用于记录需要用户确认的决策问题、选项、最终结论与理由
- 问题标题不用字母前缀；字母只用于选项
- 后续执行过程中出现的新决策，也继续追加到本文件，不新建分散的决策记录

### 1. 【P0】真源模型
- 背景：现状 provider 消息真相是 `actor.messages` 裸数组，三域只是账本；恢复时数组与三域双向 bootstrap。
- 用户答复：会话过程用三阶段 context build 从内存唯一真源产出消息列表；恢复时文件加载完毕即切换到内存唯一真源；两者不应同时生效（2026-06-12）。
- 最终决策：三域为会话期内存唯一真源；providerMessages 为三阶段 materialize 纯投影；恢复单向交接（水合一次→切换点→文件退出 live）。
- 状态：accepted

### 2. 【P0】Conversation runtime capsule 化范围
- 选项：A) 仅新 spine 逻辑 capsule 化；B) 连同 ConversationDomainRuntime + LocalConversationRuntime 全量 capsule 化
- 用户答复：连同既有 conversation runtime 全量 capsule 化（2026-06-12）。
- 最终决策：B。持久化实现作为 capsule 的枚举注册 adapter（与 engine file_store 同模式）。
- 状态：accepted

### 3. 【P0】actor transcript 处置
- 背景：transcript 是演进遗留：store、contract、写入、恢复 fallback、recovery report 来源字段、session-upgrade 的 legacy 读取。
- 选项：A) 运行时全删但 upgrade 工具保留一次性转换读取；B) 连 upgrade 读取一起全删
- 用户答复：彻底删掉，不留演进兼容遗留；连 upgrade 读取一起全删（2026-06-12）。
- 最终决策：B。后果已确认接受：仅含 transcript 的旧 session 从此无法升级/恢复，返回显式拒绝错误。
- 状态：accepted

### 4. 【P0】与流式 pipeline 的关系
- 最终决策：ingress→lexical→syntactic→semantic 的 stage 逻辑保持不变并补 DataSubgraphContract；MessageHistoryGraph 的归并语义形式化为 MessageAssemblyDerivation，成为 assistant 消息进入 History 域的唯一提交边界；工具结果/用户输入走同步命令通道不经流式 pipeline；semantic 流中的 tool 事件仅服务投影，不充当 provider 可见 tool result 真相（后者归 Track-5）。
- 状态：accepted

### 5. 【P0】切换安全策略
- 最终决策：真源切换设等价闸门——新旧组装路径以同一脚本化输入序列影子对比，providerMessages 逐消息等价后方可删除旧路径；全程以既有失败基线对照，不允许新增失败。
- 决策理由：这是 mission 核心事故区，等价性是唯一可信的行为保持证据。
- 状态：accepted

### 6. 【P0】semantic 流的枢纽地位（用户纠正）
- 背景：初稿让用户输入/工具结果以同步命令直写 History 域，绕过 semantic 流——破坏了"semantic 事件流是规范时间线与扩展衍生唯一入口"的既有原则，也会切断 TUI 工具卡片/actor 消息的数据来源。
- 用户答复：过去 TUI 与可观测性监听 semantic 事件流，用户输入和工具结果也写入流；新设计不得改变这一点。同时可观测性应显式分层：流式输出关注从 semantic 流衍生；committed/世代级关注从 MessageAssembly 或 History 域衍生（2026-06-12）。
- 最终决策：所有会话输入以 semantic 事件入流（已结构化输入在语义级注入，不经 lexical/syntactic）；三域唯一写入者是消费流的 Reducer/MessageAssembly；可观测性按流级/域级两层显式声明衍生来源。
- 状态：accepted

### 7. 【P0】镜像中间态裁定与 P7 Mirror Elimination（用户纠正）
- 背景：T4.2/T4.3 以"成对同步可写兼容镜像 + prompt-plan 系统通道快照读数组"的中间态交付；round-1/round-2 gap-loop 发现文档与实现矛盾后，选择降级 design/plan 措辞迁就实现（"只读视图、任何写入路径删除"被改写为"兼容镜像、彻底移除留给迁移收口"）。
- 用户答复：gap-loop 修正不对。本 track 要求保留唯一一处事实真源，actor.messages 是要被治理的关键部分，必须"降级为 History 域投影的兼容只读视图（facade getter），任何写入路径删除"；不应该为了难做就把文档目标降低、把还没做的任务标记完成（2026-06-12）。
- 最终决策：恢复 design/plan 的原始激进目标，两轮 gap-loop 的降级改写记为实施偏差；本 track 内新增 P7 Mirror Elimination phase 收口：读 API（revision 缓存冻结投影）→ parity golden 先行 → 杀全部写入点（系统通道读、compress 重写、append push、恢复 splice、种子数组）→ actor.messages 翻转为只读 facade getter（contract 类型 readonly）→ fiber 工作数组移除 → 读者迁移 + 源级禁写 conformance。track 的 final confirm 闸门移至 P7 之后。
- 决策理由：成对同步镜像靠写入纪律而非结构保证一致，本质是第二份事实的活体（round-2 自证的"压缩侧门回流"风险即证据），与决策 1 的唯一真源模型直接冲突；文档目标应约束实现，而不是被实现反向改写。
- 状态：accepted

### 8. 【P0】Single-writer pipeline 收口与 P8 Inject 消除（用户裁定，方案 X）
- 背景：P7 收口完 actor.messages 镜像之后，三域内仍存在两条独立 commit 路径：① 经 vm.eventBus 的 MessageHistoryGraph（流式 token / emitUserInput / emitToolCallResult 等）；② executor 的 injectSemanticEventsIntoConversationDomain（childDone / member chat / coordination / heartbeat / 种子 / effect 回放，以及对 ① 已发事件的 fallback 兜底）。两者共享同一 reduceHistoryProjection 纯核心，但 commit 入口有二，靠 adjustConversationCommitGraphAttachment 引用计数 + 三个布尔标记（deliveredViaSemanticStream / emittedOnSemanticStream / committedViaSemanticStream）做 fence；fence 失败的具体 bug 形态（新增通道漏标、isHistoryTrackedActor 判定变化、嵌套 attach 漏 detach）无源级 conformance 守护，只靠运行时纪律。
- 用户答复：选方案 X——所有通道都过 eventBus，inject 消失。这是最近几次 track 重构前原本的核心设计，要所有事件都通过 semantic（2026-06-12）。
- 最终决策：本 track 内新增 P8 Single-Writer Pipeline phase。target 形态：MessageHistoryGraph 是 vm 上唯一的 commit 入口（commit 即写 History 域）；vm.eventBus 是 semantic 事件的唯一传输；非流式来源（childDone / member chat / coordination / heartbeat / 种子 / effect 回放）通过在 eventBus 上现场构造合法 semantic 事件序列进入；isHistoryTrackedActor 不再 gate graph attach，graph 在 vm 启动/conversation runtime 初始化时常驻；三个 fence 标记与 injectSemanticEventsIntoConversationDomain 全部删除。
- 决策理由：决策 6 字面要求"semantic 事件流是规范时间线与扩展衍生唯一入口、三域唯一写入者是消费流的 Reducer/MessageAssembly"，两条 commit 路径直接违反"唯一"二字；fence 是 P4 真源切换时为兜底非 eventBus 通道留下的过渡产物，P7 已收口镜像，single-writer 是同方向延续；该收口若留给 Track-5（refactor-ai-turn-tool-provider-lifecycle）会与 ToolCall 域语义重构 + supervisor 移除挤在同一 track 内，风险叠加。final confirm 闸门移至 P8 之后。
- 状态：accepted
