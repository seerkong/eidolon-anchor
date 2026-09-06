# 设计：可复用滚动控制器、独立原型与 Eidolon 接入

## 1. 核心方案
滚动能力是“有界、动态高度、有异步分页的数据窗口”，不是 AI 会话管理。以单个 ScrollController 拥有瞬态控制状态；真实几何由 renderer 观测，页面内容由外部数据源裁决。核心按 output = fn(runtime, input, config) 组织，runtime 承载显式依赖与状态引用，不能变成带业务方法的万能对象。

详细验收矩阵见 design/verification.md；事实/迁移盘点见 analysis/findings.md、design/depa-boundaries.md。

## 2. 包与可复用交付
拟用无 scope 的 depa-scroll-* 家族，role 放最后。不挪用组织领域的 holarchy 名称；以下是本仓库内部规划名，不宣称 npm 名称可用。

| 路径 / 包名 | 主职责 | 依赖 |
|---|---|---|
| shared/packages/depa-scroll-contract | Row、Window、Anchor、Intent、PageResult、Effect ports | 稳定类型，不依赖实现 |
| shared/packages/depa-scroll-logic | 状态转换、窗口计算、锚点校正、分页/live 策略 | contract、必要的现有 vendor 公开原语；不依赖 OpenTUI |
| terminal/packages/depa-scroll-opentui-support | 实现观测几何、监听原生滚动、应用布局后滚动、释放订阅的 effect ports | contract、OpenTUI/Solid |
| terminal/packages/depa-scroll-opentui-capsule | 选择并组合 logic/support、状态 owner 生命周期，提供稳定接入入口 | contract、logic、support |
| terminal/packages/scroll-prototype（private 应用） | 数据集、故障注入、脚本、交互面板、断言 | 同一个 capsule；不得导入 Eidolon runtime |
| 现有 tui 内 history adapter 模块 | Conversation 和消息卡片到通用 row/page 的映射 | 两侧公开契约与 capsule |

不为函数级适配额外建空 adapter 包。prototype 是应用，不是可发布库。四个能力包先 private/workspace 使用；后续发布另行授权，禁止通过业务应用的发布脚本带出原型。capsule 必须真正组合生命周期与依赖，不能只是空 re-export。

## 3. 数据与执行协议
- Row：稳定 id、顺序键、contentRevision、呈现状态（折叠/展开/流式等），内容泛型，不硬编码 assistant/tool。
- MeasurementKey：rowId + contentRevision + layoutEpoch；layoutEpoch 包含实际内容宽度及布局样式版本。记录完整 row 外框占用行高，间距只计一次。
- Geometry：actual viewport（不含 composer）、scrollTop、scrollHeight、row offsets、spacer；所有派生使用同一坐标系和高度表。follow 模式也不能丢弃测量。
- ReadingAnchor：rowId + row 内偏移 + viewport 内目标位置；行过高时保留行内位置。行被移除时按声明的相邻顺序策略回退并产生诊断。
- NavigationIntent：follow-latest / browse-anchor，与是否已缓存最新页分离；用户滚动、End、提交消息都是显式 intent。
- PageWindow：opaque 边界、snapshot、hasEarlier/hasLater、loading/error/stale/exhausted 状态。不得把异常当成到达历史起点。
- RequestIdentity：session/source、actor、snapshot、window generation、requestId；intentRevision 防止异步返回覆盖后来用户操作。

Effects 经 contract 注入：loadPage、observeViewport/rows、applyScrollAfterLayout、cancel、diagnostic sink。页面结果/布局观测作为输入进入同一 owner，输出只读投影。同步纯转换使用 command；跨异步协作采用现有 actor 原语的 message/mailbox，不另写微型消息总线。P1 先定位现有 vendor 的实际可用入口并形成最小映射，禁止依赖完整 AI kernel 才能启动原型。

## 4. 关键闭环
1. 原生滚动（包含 scrollbar、wheel、键盘、sticky 或布局 clamp）进入同一几何观测入口；不能只在自定义键盘 handler 更新虚拟 viewport。
2. Processor 根据实际 viewport 和统一高度表计算挂载区；布局结束后再接收观测、校正锚点。effect 标识防止程序滚动被误判为用户意图，且不能忽略其真实坐标变化。
3. prepend/resize/展开/流式增长校正基于当前锚点，不基于请求发起时保存的像素。用户中途移动会推进 intentRevision，旧校正不得强拉回。
4. 初始加载最新页；缓存围绕可见锚点淘汰，页与测量缓存都有上限。大卡片占满屏幕是合法的，“只看见一条”本身不是错误；不可见内容必须能继续滚动抵达，卡片底边最终可达。
5. 浏览旧页时 live tail 仍被登记并保持有界，只更新最新位置/未读指示，不抢视口。End 或提交新消息先执行 jump-to-latest，恢复最新页、合并 durable/live ID，再 follow；不是只滚旧缓存到底。
6. stale cursor 保留可读窗口并显示恢复入口；End 无论原 atLatest 值如何都可以重新取得尾页。翻页失败显式可重试、可取消，不能卡死全局 loading 标志。
7. 前期契约只有 before。若向上阅读时淘汰了较新的页面，向下必须可重新读取相邻页面，而不是突然跳最新或保留全部正文。P4 补齐只读 after/anchor 读取边界：沿用 opaque cursor、active actor/generation 验证和字节预算；不将文件定位规则放进通用包。
8. session/actor 切换或 dispose 使旧响应、测量、排队滚动全部失效，并释放 renderer listener。list controller 不影响 AI 执行或 canonical message 保存。

## 5. 原实现到目标映射
| 原位置（大概行号） | 当前职责/问题 | 目标去向 |
|---|---|---|
| view.tsx:637–657 | pagedHistory、inFlight、viewport 分散；atLatest 控制 live 可见性 | contract 状态与 logic 的统一 owner transition |
| view.tsx:892–985 | 显式 sync、异步 prepend 像素校正、forced bottom | support 原生观测 + logic 锚点/intent + capsule 生命周期 |
| view.tsx:1889 | End 是否刷新依赖 atLatest | jump-to-latest，stale 与 browse 独立可恢复 |
| perf/virtual-history-window.ts | 消息特定估高、窗口和 spacer | 通用 logic 保留算法职责；消息估高留宿主 adapter |
| features/message/cards.tsx:289–347 | 仅 id 测量缓存；follow 忽略测量 | capsule 提供统一测量协议；卡片只渲染并报告占用高度 |
| perf/scroll-history.ts | wheel/page/edge 直接滚动 | 意图映射留 UI，实际 effect 统一由 support 应用 |
| runtime/client/TuiRuntimeClient.ts:1450 附近 | canonical page 转 surface 消息 | 保留为只读页面 adapter，不拥有滚动策略 |
| LocalFileConversationProjectionReadPort.ts | generation authority、预算、opaque cursor | 保留领域边界；只在此补齐 forward 页面能力 |

不把整个 cards.tsx 搬进通用库，不复制 Conversation authority；集成通过后移除旧状态变量和算法，禁止新旧实现同时裁决滚动位置。

## 6. 验证门槛与迁移
P1 固化可复现失败与基线，P2 核心测试红转绿，P3 使用真实 OpenTUI 的独立原型。
P3 必须形成 reports/prototype-verification.md：输入版本、依赖版本、命令、断言、帧/交互 trace、指标、失败清单及结论。只有 required cases 全部 PASS、无待处理 gap，才能进入 P4；SKIPPED/BLOCKED 不等于通过。
P4 才允许修改业务接线，同时补齐有界双向页面恢复。P5 以真实会话只读副本验证恢复到首条、返回尾部及发送后的显示。
测试依赖缺失必须修复真实导出/版本契约或明确阻塞，不能用 mock 掩盖最终集成失败。
迁移不改历史文件格式；有回滚需要时由版本化代码回退处理，不常驻双控制器。Eidolon build/local:install、提交及归档不自动执行。2026-09-06用户追加授权的上游依赖对齐、必要发布与上游提交作为P4-T0例外。

### 上游发布前置边界（2026-09-06 replan）
真实宿主静态导入`ai-workflow-logic/agent-code-execution`，npm 0.2.0缺少该入口。代码执行闭包由Halfcode拥有，Agent资源执行编译/恢复由depa-flows拥有，Eidolon只消费公开入口。先盘点传递导出、版本与dirty diff；复验上游原有实现，再发布最小必要库闭包，禁止复制到Eidolon或mock导出。
发布采用官方registry和`/Users/kongweixian/.npmrc_official`，记录tarball完整性、上游commit与独立消费者验证。上游author使用`kongweixian <kong_weixian@163.com>`。源码提交只纳入经审查的依赖交付闭包，不以整个dirty工作树作为默认范围。随后对齐宿主依赖及lock，真实导入通过后才进入P4-T1。滚动四包与原型仍保持private。

## P4接入期的源顺序澄清

真实文件已存有 HistoryMessage 的 generation 内 `sequence`，visibleGenerationIds 给出跨 generation 顺序；显示时间不具备顺序裁决权。只读页面额外携带按 message ID 索引的 `messageOrder`，SDK 转为 Message 的 `historyOrder`，元组为 `[generationOrdinal,messageSequence]`。宿主投影多卡时再添加局部卡片序号，不能按 createdAt/id 重排，也不能用文件 offset 充当领域序号。

通用 ScrollRow 的 order 保持数值消费者兼容，并允许有限非空数字元组，统一字典序比较；不使用任意倍率压平，也不保留随历史增长的 ID→rank 表。缺少源 sequence 的旧数据只声明兼容的页面顺序证据，不伪装成 canonical sequence。实时事件与持久页面的对齐在宿主 source adapter 内完成；通用核心仍不认识 Conversation/Generation。

该公共契约演进必须先取得核心 RED→GREEN，再重跑完整原型门槛，之后才修改生产 view/cards 接线。P3 原报告保留为历史证据，不自动当作新契约已验证。

## 7. 决策与待确认
用户已选择“DEPA + 可复用包 + 独立原型先验收后接入”；见 decisions.xnl。
执行 hook 策略已获用户确认：manual + 每阶段 GapLoop（max_rounds=5、on_exhausted=block、verify_round=true）；最后阶段 GapLoop 后执行 coding AttractorCheck。只配置 phase hook，不在 Track 根重复挂 GapLoop。
当前截图对应的准确 workspace/session 未提供；P1 可先用合成数据复现，P5 不得在缺少现场证据时声称现场问题已修复。
modeling/engineering registry 当前显式关闭，本 Track 不生成空 delta。

## P5 现场纠偏：逻辑历史与显式索引准备

用户已确认原始 session `20260831145910__01M1BV03BCJMESX76FBEP5EF2E`，只对隔离副本验证。`reports/p5-real-scene-data-red.md` 是失败证据；`reports/p5-replan-attractor.md` 为 revise:before 的 fresh coding 方向 PASS，不代表实现验收。

此前物理页游标不能表达重叠 compaction generation：8,047 条成员记录仅有 932 个逻辑消息身份。因此本节取代 P4 中“每个 generation 成员就是一个显示位置”的解释。可见 lineage 仍由领域 authority 决定；只读投影按先驱 generation、sequence 排序。同 generation 同 record ID 采用最后物理记录，同 sequence 以 record ID 决定稳定次序。逻辑 messageId（缺失时采用 recordId）首次出现的位置固定，后继可见版本提供最新正文。显式 messageId 与 fallback recordId 若发生歧义必须明确拒绝，不静默合并。provider Prompt/活跃 history materializer、fork/rewind 写入协议均不更改。

文件定位信息由 ai-support 的实例级可丢弃索引提供，不进入通用 scroll 包，不写回 source，也不持有正文。新增可选只读 `loadHistoryPageIndexProjection`：冷准备按最多 8 MiB 的有界 record batch 扫描，每批让出事件循环；返回实际准备字节数。最多两个来源、合计 100,000 条 metadata，标识字符串最多 4,096 字符；单条记录超 8 MiB、超限、不前进、取消、来源变化均返回明确错误码，不扩张缓存或无限积累 parser carry。

正文页继续遵守 authority lookup + 所选正文合计 8 MiB，不将准备成本藏入缓存命中率。SDK `session.messages` 保持已有调用形态，内部先显式准备，再读逻辑页，并返回 preparation 字节/耗时。低层大文件冷调用必须先准备，否则明确 `prepare_required`；这项低层例外显式取代原 before-compatibility 的无准备假设。小文件可内联准备，但其全部扫描字节计入当前页预算。旧物理 cursor 明确 stale，不解码后冒充逻辑位置。

索引按文件 signature 失效，不用 mtime 裁决领域版本；logical cursor 同时绑定领域 snapshot 和文件 signature。准备结束、正文读取结束均复核来源，变化不得混合返回。实例终止/AbortSignal 清理索引，淘汰或取消后的异步完成不得复活缓存；无持久 index 权威。源切换后的 UI 回包仍由既有 request identity fence 裁决。

验收新增独立预期的小型 retained-tail/positional-rewrite fixtures、反序物理写入、跨页去重、版本值与模型/工具/思考转换对齐。现场完整往返必须得到相同唯一逻辑序列；同时记录冷准备、分页、事件循环及原始/副本指纹。P1 原型 SLO 和现有资源/预算上限不降低；真实现场冷扫描指标单列，不冒充原型首屏指标。

### P5 fork/rewind 纠偏范围（用户追加授权）

2026-09-06用户要求继续定位修复 `PROMPT_STATE_UNPROVABLE`。本节取代上述“fork/rewind写入协议均不更改”对修复实现的限制，但不改变跨compaction无法证明时拒绝的安全语义，不授权迁移原现场或build/install/commit。

现场 `visibleGenerationIds` 是成员集合顺序，active位于第一个，index.lineages为空；已加载的19个History generation envelope具有完整predecessor链。旧resolver将集合顺序当成时间顺序截断，误删18个实际存在的Prompt依据。修复在Conversation领域边界使用只读纯lineage解析：envelope提供predecessor边，有index lineage时核对一致性，缺失、环、身份冲突拒绝。parentGenerationId仅作为provenance，不自动成为可见边，避免rollback重新引入已移除消息。

保持Prompt basis、provider receipt、tool pair与CAS验证；不得为通过现场测试删除这些guard。补充独立小型失败用例和副本真实提交/恢复/分页隔离证据。任何新的不一致继续保留为失败，不通过修改期望数量或伪造proof掩盖。
