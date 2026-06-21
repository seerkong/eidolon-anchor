# 变更规范：AIAgent `.eidolon` Conversation Domain Persistence

## ADDED Requirements

### Requirement: 系统必须在 semantic 之上建立 conversation domain graph family
系统 SHALL 在现有 semantic canonical source 之上建立正式的 `conversation domain graph family`，用于承载 history、prompt、session 三域真相，而不是继续把这些聚合语义散落在 transcript、runtime snapshot、bridge cache 与压缩副作用里。

#### Scenario: conversation domain graph 不直接回退为 ad-hoc bridge state
- **Given** runtime 已经产生 lexical / syntactic / semantic canonical events
- **When** 系统需要聚合消息历史、压缩上下文或 session lineage
- **Then** 系统 SHALL 在 semantic 之上构造 conversation domain events
- **And** SHALL 使用 `depa-data-graph` 的 append-only event log、reducer projection 或 signal 建模这些状态
- **And** SHALL NOT 继续把正式真相停留在 bridge 内部的命令式 `messages` list 或 cache

#### Scenario: conversation domain projection 不能只停留在离线 helper
- **Given** 系统已经定义了 history / prompt / session 的 domain event 与 reducer projection
- **When** runtime 执行 compaction、recovery 或 session load
- **Then** 这些主链 SHALL 正式消费 conversation domain projection 或等价 raw state
- **And** SHALL NOT 只在测试或 debug helper 中使用 projection，而在正式路径继续手工拼写 heads / lineages / bindings

#### Scenario: runtime/history/session 视图由同一份 conversation raw state 派生
- **Given** 系统已经从 `.eidolon` conversation persistence 读取 history、prompt、session 三域索引与 generation
- **When** runtime prompt view、visible history view 或 session metadata view 需要被消费
- **Then** 它们 SHALL 从同一份 conversation raw state 派生
- **And** SHALL NOT 各自独立重新读取并拼接 history/prompt/session truth

#### Scenario: recovery 将 persisted raw state 注入 runtime conversation domain
- **Given** 某个 session 已经拥有 `.eidolon` conversation persistence
- **When** `recoverAiAgentRuntime(...)` 恢复 VM 与 actors
- **Then** 系统 SHALL 将 persisted session raw state 与 actor raw state 注入 conversation runtime 的常驻 signals
- **And** 后续 runtime prompt/history/session 消费 SHALL 优先读取这些 runtime raw state
- **And** SHALL NOT 把 conversation raw state 仅作为一次性 loader 的临时返回值

#### Scenario: live committed messages 持续推进 conversation runtime
- **Given** semantic canonical events 正在经由 message assembly 形成 committed messages
- **When** 新的 transcript record batch 被归并成正式 message
- **Then** 系统 SHALL 将新增 committed messages append 到 conversation domain runtime
- **And** SHALL 让 runtime history truth 在 session 进行中持续前进
- **And** SHALL NOT 只在 reload 或 persistence 回读后才修正 runtime conversation truth

#### Scenario: runtime conversation domain 提供正式 stream family API
- **Given** conversation domain runtime 已成为 history / prompt / session 三域的常驻宿主
- **When** 运行时或上层编排需要订阅、tee 或旁路持久化这些领域流
- **Then** runtime SHALL 提供正式的 subscribe / tee / persist-hook 入口
- **And** SHALL NOT 仅暴露 event array 作为唯一流式消费接口

#### Scenario: 领域事件在主链中优先携带正式对象
- **Given** conversation domain event 会驱动 reducer、runtime state 与持久化编排
- **When** 主链产生 history、prompt 或 session 领域事件
- **Then** 这些事件 SHALL 优先携带 generation、head、transform、binding、selection、lineage 或 session object
- **And** reducer SHALL 优先消费这些正式对象而不是大量依赖运行时猜默认值
- **And** 仅保留最小 id-only 兼容路径，不再把薄事件作为首选主链形态

#### Scenario: message assembly state 作为 live ingress 的正式运行时状态
- **Given** semantic 事件需要被聚合为完整 committed message 后再进入 conversation domain
- **When** runtime 接收新的 transcript record batch
- **Then** 系统 SHALL 在 conversation runtime 内维护正式的 message assembly state
- **And** SHALL 使用该 state 推进后续 committed-message append
- **And** SHALL NOT 继续只依赖散落的临时 Map 或长度差比较作为唯一桥接方式

### Requirement: `.eidolon` 文件系统必须成为第一版 conversation persistence 权威实现
系统 SHALL 以 `.eidolon/sessions/<session>/` 为第一版正式 conversation persistence 根目录，并在其中建立 history、prompt、session、artifact refs 的独立权威索引和 generation 存储。

#### Scenario: `.eidolon` session root 拥有正式 conversation persistence 目录
- **Given** 某个 session 需要持久化消息历史、压缩结果与可恢复的 conversation state
- **When** 系统写入本地持久化
- **Then** 系统 SHALL 在 `.eidolon/sessions/<session>/conversation/` 下维护独立的 conversation persistence
- **And** 第一版 SHALL 至少包括 `history.index.json`、`prompt.index.json`、`session.index.json` 与 `artifact-refs.index.json`
- **And** SHALL 为 history generation 与 prompt generation 提供独立存储目录

### Requirement: `.eidolon` 本地读写实现必须作为 `@cell/ai-support` 的 support backend 落地
系统 SHALL 将 `.eidolon` conversation persistence 的本地文件读写、store/repository factory 与 serializer 作为 `@cell/ai-support` 的正式 support backend 实现，而不是继续散落在 runtime entry、`mod-ai-kernel` 或 `ai-organ-logic` 中。

#### Scenario: ai-support owns local conversation persistence implementation
- **Given** 系统需要读写 `.eidolon/sessions/<session>/conversation/*` 下的索引与 generation 文件
- **When** 本轮 conversation persistence 落地完成
- **Then** 这些本地文件副作用实现 SHALL 由 `@cell/ai-support` 提供
- **And** 应包括 local store、repository、path layout helper、serializer 或等价 support backend 组件
- **And** `ai-organ-logic` SHALL 只负责 orchestration、recovery/load 接线与 domain-level 调用

#### Scenario: ai-organ contract and logic keep orchestration ownership rather than file-side-effect ownership
- **Given** conversation persistence 同时涉及 domain contract、reducer 语义、runtime recovery 与本地文件副作用
- **When** 系统划分 package ownership
- **Then** `ai-organ-contract` SHALL 持有 AI-specific persistence contract 与 domain data
- **And** `ai-organ-logic` SHALL 持有 persistence orchestration 与 recovery 逻辑
- **And** `.eidolon` 本地读写副作用 SHALL NOT 以正式 ownership 的形式落在 `ai-organ-logic`

#### Scenario: actor transcript 与 runtime snapshot 不再单独承担 conversation truth
- **Given** `.eidolon/sessions/<session>/actors/*/transcript.txt` 与 `.eidolon/sessions/<session>/runtime_state/*` 已存在
- **When** 新的 conversation persistence 生效
- **Then** transcript SHALL 作为 append-only 原始消息证据与迁移/bootstrap 输入
- **And** runtime snapshot SHALL 作为 actor/vm/fiber durable state
- **And** 系统 SHALL NOT 再只依赖 transcript 或 runtime snapshot 推断唯一 conversation truth

### Requirement: 消息历史必须以 history generation/head/lineage 表达
系统 SHALL 用 history generation、head 与 lineage 表达 actor message history，而不是继续把当前可见历史等同于单个 actor transcript 或压缩后 `messages` 数组。

#### Scenario: history truth 包含 sealed predecessors 与 active tail
- **Given** 某个 session 中的 actor 已发生多轮消息提交与压缩
- **When** 系统重建其消息历史
- **Then** 系统 SHALL 把历史表示为 sealed predecessor generations 与一个 active tail generation
- **And** SHALL 显式维护当前 history head
- **And** history 恢复 SHALL 可以从 `.eidolon` conversation persistence 独立完成

#### Scenario: committed actor messages 进入 history domain
- **Given** semantic 链路已经把用户输入、assistant 输出或 tool 结果提交为完整 message
- **When** 系统将这些提交持久化为正式历史
- **Then** 系统 SHALL 追加 history 域事件
- **And** SHALL 把对应 generation 物化到 `.eidolon` conversation persistence
- **And** SHALL 保持 actor transcript 作为原始消息证据可追溯

#### Scenario: history generation 持久化 committed message 而不是 transcript-style stream record
- **Given** 系统要把已提交消息写入 formal history persistence
- **When** history generation 被 materialize 到 `.eidolon`
- **Then** generation 内部 SHALL 保存 committed message 级别的正式 DTO
- **And** 每条 committed message SHALL 持久化消息级 `startAt` 与 `endAt`
- **And** 对流式 assistant message，`startAt` SHALL 对齐首个 start/delta 边界，`endAt` SHALL 对齐对应 delta 完结后的 end 边界
- **And** transcript-style stream / payload 只能作为 evidence source 或兼容 fallback
- **And** runtime / TUI 恢复 SHALL 优先读取 committed message DTO，而不是先反向经过 transcript reducer

### Requirement: 压缩必须拆分为 history compaction 与 prompt truth 更新
系统 SHALL 将当前压缩逻辑重构为正式 conversation compaction，而不是继续只把 summary + ack 写回当前 `messages`。

#### Scenario: history compaction 会 seal predecessor 并移动 history head
- **Given** session 触发当前已有的 compact 行为
- **When** 系统执行正式 compaction
- **Then** 系统 SHALL 生成新的 history generation 边界
- **And** SHALL seal 被压缩的 predecessor generation
- **And** SHALL 移动 history head 到新的 active generation

#### Scenario: compaction summary 进入 prompt truth 而不是伪装成唯一历史真相
- **Given** `ContextCompressor` 产生了 `state_snapshot` summary
- **When** 系统将该 summary 纳入后续模型上下文
- **Then** 系统 SHALL 在 prompt 域记录新的 prompt generation 或 transform
- **And** SHALL 为当前 prompt head 建立可恢复的物化信息
- **And** SHALL NOT 再把 summary + ack 直接视为唯一正式历史真相

#### Scenario: prompt runtime view 需要通用解释 prompt transform chain
- **Given** prompt generation 中存在 `history_compaction_summary` 之外的 transform
- **When** runtime 组装后续模型输入
- **Then** 系统 SHALL 通过通用 prompt transform interpreter 解释已知 transform kind
- **And** 至少 SHALL 对 `micro_compact`、`context_asset_attach`、`context_asset_extract_text`、`context_asset_select_fragment`、`context_asset_bind_summary` 与 `overlay` 提供稳定的解释入口
- **And** SHALL NOT 把 prompt runtime view 永久写死为只认识 compaction summary 的特例逻辑

#### Scenario: prompt runtime ops 正式拥有 request overlay 与 context block 生命周期
- **Given** prompt truth 不仅来自 compaction，还来自 request build、overlay 与上下文资产
- **When** runtime 需要记录 prompt request、prompt overlay、context block attach 或 detach-all
- **Then** 系统 SHALL 提供正式的 prompt runtime ops
- **And** 这些操作 SHALL 通过 conversation domain runtime 更新 prompt generation / transform chain
- **And** SHALL NOT 只把 prompt 域停留在 persistence materializer 或 compaction 特例逻辑

#### Scenario: full compaction summary 不进入 formal history generation
- **Given** full compaction 产生了 `state_snapshot` summary 与兼容 ack
- **When** 系统把 compaction 结果持久化到 `.eidolon`
- **Then** formal history generation SHALL 只包含 active tail 的真实 committed messages
- **And** `state_snapshot` summary 与 ack SHALL 仅进入 prompt generation / transform / artifact refs
- **And** recovery 与 prompt runtime view SHALL 通过 prompt head 重建这些上下文，而不是从 history generation 读取它们

### Requirement: 历史 session 加载必须优先从 conversation persistence 恢复
系统 SHALL 让历史 session 加载和恢复优先读取 `.eidolon` conversation persistence，而不是继续只从 runtime snapshot、pending-question 辅助逻辑或 transcript 拼装可见历史。

#### Scenario: TUI 或 headless session load 使用 conversation heads 恢复历史
- **Given** 用户浏览并打开一个已存在的本地 session
- **When** runtime 需要恢复该 session 的会话历史与当前上下文
- **Then** 系统 SHALL 优先读取 history head、prompt head 与 session index
- **And** SHALL 使用 generation 持久化结果恢复可见历史
- **And** transcript 与 runtime snapshot 只作为补充 bootstrap、audit 或兼容迁移输入

#### Scenario: TUI `/resume` 打开可滚动 session 列表并恢复目标会话
- **Given** 用户位于 TUI composer，且本地 `.eidolon/sessions/` 下存在历史 session
- **When** 用户输入 `/resume`、`/continue` 或 `/session` 并按 Enter
- **Then** TUI SHALL 打开 session list surface，而不是把该输入当作普通 runtime turn 发送
- **And** 该 surface SHALL 提供可滚动列表，并支持上下选择目标 session
- **And** 每个 session 项 SHALL 显示三行摘要：create/update 时间、初始用户问题、最新消息预览
- **And** 当用户按 Enter 选择目标 session 后，系统 SHALL 恢复该 session
- **And** 恢复后的历史展示 SHALL 优先消费 runtime-first conversation views，并仅在 runtime view 不可用时回退 `.eidolon` conversation persistence

#### Scenario: runtime prompt view 与 session history view 消费不同的 conversation truth 视图
- **Given** 某个 session 已发生过 compaction，并同时拥有 prompt head 与 history head
- **When** runtime 需要恢复后续模型输入
- **Then** runtime SHALL 消费 prompt head + active history tail 的 prompt view
- **And** TUI 或 headless 需要浏览历史
- **Then** 它们 SHALL 消费 predecessor + active tail 组成的 visible history view
- **And** 两种消费面 SHALL NOT 误用同一份 `actor.messages` 或同一份降级 cache 作为唯一真相

#### Scenario: 历史 session 可加载压缩后的早期历史
- **Given** 某个本地 session 已经发生过 compaction
- **When** 用户重新加载该 session
- **Then** 系统 SHALL 能恢复压缩后的 active history 与 prompt context
- **And** SHALL 保留访问 predecessor generation 的能力
- **And** SHALL 不因旧 transcript 被压缩而丢失该 session 的正式历史结构

### Requirement: session domain 必须表达本地 session lineage 与 active heads
系统 SHALL 为 `.eidolon` 本地 session 建立正式 session domain，用于表达 session metadata、active actor/head 选择、lineage 以及后续可扩展的 branch/fork 信息。

#### Scenario: session index 维护 conversation 恢复所需的正式入口
- **Given** 某个 session 已持久化到 `.eidolon`
- **When** 系统写入或恢复其 conversation state
- **Then** `session.index.json` SHALL 记录恢复 conversation truth 所需的正式 session-level metadata
- **And** SHALL 能关联当前 active actor、history head 与 prompt head
- **And** SHALL 不要求调用方从多个非正式文件中重新猜测这些关系

#### Scenario: session raw state 作为 actor/head 选择的统一入口
- **Given** session domain 已维护 active actor、actor bindings 与 context asset registry
- **When** TUI、headless runtime 或 debug helper 需要解析当前 actor/head 选择
- **Then** 它们 SHALL 优先消费 session raw state
- **And** SHALL NOT 重复散落地直接读取多个 index 文件后自行推断 active actor/head 关系

#### Scenario: session raw state 为 selection 与 asset runtime 预留正式槽位
- **Given** 当前分支已经开始对齐参考设计的 session runtime truth
- **When** session raw state 被恢复、注入或由 domain event 更新
- **Then** 它 SHALL 正式包含 `activeSelection` 与 `contextAssets` 槽位
- **And** selection / binding / asset 相关事件 SHALL 可以驱动这些槽位进入 runtime session state
- **And** 即使更高级的宿主机制暂未全部实现，这些槽位也 SHALL 不再缺失

#### Scenario: session lifecycle 语义在 runtime 中拥有正式入口
- **Given** session domain 不仅要承载恢复索引，还要承载 fork close 与 lineage 生命周期
- **When** runtime 需要表达 session fork、selection 更新、asset 注册或 close
- **Then** conversation domain SHALL 为这些 session lifecycle 语义保留正式 runtime 入口
- **And** 即使某些宿主流程暂未全面接通，也 SHALL 不再把它们留作未命名的隐式行为

#### Scenario: 上层消费面在可用时优先使用 runtime raw state
- **Given** 某个本地 session 对应的 runtime bridge 仍然可用，且 conversation runtime 已拥有最新 raw state
- **When** TUI 或其他上层消费面需要读取 active actor、visible history 或 runtime prompt
- **Then** 它们 SHALL 优先读取 runtime conversation raw state
- **And** 仅在 runtime 不可用或没有对应 state 时才回退到 `.eidolon` persistence loader
- **And** SHALL NOT 在 runtime 可用时仍默认先走 repository-first 读取路径

### Requirement: 对暂未具备宿主机制的能力必须先落定义再落实现
系统 SHALL 对当前尚无完整宿主机制的能力采用 “contract first” 策略：先定义 domain object、event、transform kind、storage slot 与 reducer 入口，再按决策分阶段接入 runtime 或 UI。

#### Scenario: rollback/fork 等延后能力先有正式定义
- **Given** 某个 conversation 机制对未来模型必要，但当前并非本次必须交付
- **When** 系统本轮不直接实现该 runtime surface
- **Then** 系统 SHALL 仍为其建立正式 contract、event kind、storage slot 或 head/lineage 语义
- **And** SHALL 在 track 中明确其延后边界
- **And** SHALL NOT 再把这些能力留作未命名的隐式行为

## 非功能需求

1. 正式 conversation truth 必须能够从 `.eidolon` conversation persistence 重建，而不是依赖进程内 cache。
2. `depa-data-graph` 与 `depa-actor` 的使用必须保持 AI-specific 语义留在 `cell/*` 和更高层。
3. conversation persistence 切换后，历史 session 加载、压缩恢复与 actor transcript 兼容迁移都必须有 focused tests。
4. migration 期间允许 transcript / snapshot 继续存在，但它们不得再作为唯一正式 conversation truth。
5. `.eidolon` 本地文件实现的正式 ownership 必须与已归档 package topology 约束一致，收口到 `@cell/ai-support`。
