## ADDED Requirements

### Requirement: Presentation-Oriented Terminal TUI Shell

系统应当（SHALL）将 `terminal/packages/tui` 重构为以展示和交互编排为主的 TUI shell，而不是继续承担外部 SDK 兼容层和运行时真相来源。

#### Scenario: Prototype-only entry replaces the legacy route shell

- **GIVEN** 新的 prototype TUI 已具备继续会话、提交 prompt、渲染消息与流式状态的主链路
- **WHEN** 本次重构进入旧壳清退阶段
- **THEN** 系统仅保留新的 `src/prototype-main.ts` 作为 terminal TUI 的目标入口
- **AND** 旧的 route-based TUI app / session shell 不再作为长期维护目标
- **AND** 旧壳中的必要能力必须先迁入新的 prototype-first 目录后，旧壳代码才允许被删除

### Requirement: Single Official Flat Fluent Theme

系统应当（SHALL）提供一个新的单一官方主题，采用扁平 + Fluent 风格，并移除遗留的多主题默认资产和历史品牌主题。

#### Scenario: Launch TUI with the new default theme

- **GIVEN** 用户启动 TUI
- **WHEN** TUI 加载默认视觉主题
- **THEN** 系统使用唯一的官方主题作为默认主题
- **AND** 该主题体现统一的 surface、stroke、text、accent、status token 体系
- **AND** 该主题在深色模式下 `surface-1=#0f1114`、`surface-2=#14181c`、`surface-3=#1f242a`、`line=#2a3138`、`line-strong=#39424b`、`accent=#55d16a`、`focus/info=#71b7ff`

#### Scenario: Key shell panels use the same flat fluent chrome language

- **GIVEN** 用户浏览 TUI 的 header、sidebar、prompt、question prompt 与 message/tool cards
- **WHEN** 这些区域以默认主题渲染
- **THEN** 系统使用一致的 flat panel 分层、0 圆角、细描边与低透明 hover/focus 语言
- **AND** 交互焦点优先使用 Fluent 风格的蓝色 focus ring 或描边，而不是与参考 palette 脱节的临时颜色

### Requirement: Message Card Compatibility

系统应当（SHALL）在重构后保留现有结构化消息卡片能力，尤其是编辑前后、diff、文件、工具和问题类卡片的表达能力。

#### Scenario: Render existing structured message cards after refactor

- **GIVEN** 会话历史中包含编辑前后、diff、文件引用、工具输出等结构化消息 part
- **WHEN** TUI 渲染这些消息
- **THEN** 用户仍能看到对应类型的结构化卡片
- **AND** 不因 shell 重构或主题重构丢失这些卡片能力

### Requirement: Terminal Runtime Consumers Prefer Runtime-First Context Views
系统应当（SHALL）让 terminal/TUI 相关消费面优先使用 runtime-first 的 work context / prompt truth 视图，并仅在 runtime 不可用时回退持久化读取。

#### Scenario: TUI and terminal runtime prefer runtime-first context state
- **GIVEN** runtime 中已经存在有效的 work context、prompt truth 或 session context raw state
- **WHEN** terminal/TUI 需要展示当前会话的上下文状态或模型输入相关视图
- **THEN** 系统 SHALL 优先读取 runtime-first 视图
- **AND** 仅在 runtime 不可用或无状态时才回退 `.eidolon` persistence-first loader

#### Scenario: Legacy card behaviors are extracted instead of keeping the old shell alive

- **GIVEN** 旧 TUI 中的消息卡片还带有点击查看、复制、revert、fork 等配套动作
- **WHEN** 团队清理旧的 session route shell
- **THEN** 系统应将这些卡片和动作迁移为新 TUI 可复用的 message feature 素材
- **AND** 不要求旧 session route 自身继续作为产品形态存在

### Requirement: Bilateral Busy Status Beacons

系统应当（SHALL）保留当前会话进行中的循环色块扫描动画，并将其增强为左右角双侧忙碌信标，以便在多终端窗口层叠时快速识别会话状态。

#### Scenario: Show active conversation status in both corners

- **GIVEN** 当前会话处于进行中、重试中或其他非 idle 状态
- **WHEN** 用户观察输入区或底部状态区域
- **THEN** 系统显示保留扫描感的忙碌动画
- **AND** 左右角均提供可感知的状态信标
- **AND** 当会话停止或进入 idle 时，动画按状态收敛而不是误导性地继续滚动


### Requirement: Prefer Shared Terminal And Cell Capabilities Over TUI Duplication

系统应当（SHALL）优先复用 `terminal/` 与 `cell/` 中已存在的 runtime、contracts、配置加载与投影能力，而不是在 TUI 中维持平行实现。

#### Scenario: Replace duplicated TUI responsibilities with shared package capabilities

- **GIVEN** `terminal/packages/core`、`terminal/packages/organ`、`terminal/packages/organ-support` 或 `cell/` 中已存在稳定能力
- **WHEN** TUI 重构这些相关功能
- **THEN** 系统优先复用或下沉到共享包中的实现
- **AND** 不再在 TUI 中保留第二套等价的协议翻译、provider catalog 拼装或 runtime 辅助逻辑

### Requirement: Prototype TUI State Uses Depa Data Graph Projection

系统应当（SHALL）让基于 OpenTUI + Solid 的新 prototype TUI 使用 `depa-data-graph` 组织会话消息、流式状态和选择状态，从而与 terminal/cell 的 data graph 方向保持一致。

#### Scenario: Runtime events are projected into graph-backed TUI state

- **GIVEN** prototype TUI 已连接本地 runtime，并持续收到 `session.status`、`message.updated`、`message.part.updated` 等事件
- **WHEN** TUI 聚合当前会话的可视状态
- **THEN** 系统通过基于 `depa-data-graph` 的 timeline / projection / signal 节点产出 `messages`、`busy`、`selection` 和 `sessionID`
- **AND** 不再依赖 `createStore + Map + 手动 sync` 作为这些状态的唯一真相来源

#### Scenario: Solid view consumes graph projection while keeping local UI mechanics local

- **GIVEN** OpenTUI + Solid 组件需要渲染消息卡片、底栏和输入区
- **WHEN** 组件读取当前会话状态
- **THEN** 它们应消费 graph projection 暴露的响应式状态
- **AND** `scrollbox` / `textarea` 实例、滚动副作用、焦点和草稿文本仍保留在组件本地管理

#### Scenario: Graph-backed state remains compatible with current prototype message cards

- **GIVEN** 用户在 prototype 中继续真实会话，且 assistant 产生 thinking / content 流式片段
- **WHEN** TUI 渲染消息卡片和底栏状态
- **THEN** 系统继续正确区分 `THINKING` 与 `ASSISTANT`
- **AND** 每条 assistant 消息和底栏仍能显示对应的 agent、provider id 和 model id
- **AND** 现有滚动行为与紧凑卡片布局不因状态层 graph 化而退化

### Requirement: Legacy Prompt And Approval Interactions Survive Shell Retirement

系统应当（SHALL）在删除旧 TUI 壳层前，保留并迁移旧输入框中的结构化交互能力，包括 `/`、`@` 补全、文件/图片注入、extmark 绑定，以及 permission / question 流程。

#### Scenario: Structured composer interactions continue in the prototype-first TUI

- **GIVEN** 用户在新 TUI 的输入框中使用 `/`、`@`、粘贴文件或图片等交互
- **WHEN** 新 TUI 处理这些输入
- **THEN** 系统继续支持 slash command、agent/file 引用、结构化 prompt part 与虚拟文本占位
- **AND** 这些能力来自新的 composer / approval 目录，而不是继续依赖旧 session shell

#### Scenario: Permission and question flows block composer until answered

- **GIVEN** runtime 发出 permission request 或 questionnaire request
- **WHEN** 新 TUI 展示当前会话的输入区
- **THEN** 系统优先显示相应的 permission / question 交互
- **AND** 在请求处理完成前，不允许普通 prompt 提交链路误继续执行

### Requirement: Legacy System Dialogs Become Reusable Materials

系统应当（SHALL）将旧 TUI 中的 `session list`、`theme`、`provider`、`agent`、`MCP`、`status` 等 dialog 打散为新 TUI 可继续吸收的素材目录，而不是将旧 dialog 栈整体原样保留。

#### Scenario: System dialogs are reorganized by responsibility

- **GIVEN** 旧 TUI 中仍有可复用的管理型 dialog 与辅助交互
- **WHEN** 团队为新的 prototype-first TUI 规划目录结构
- **THEN** 系统按职责将这些资产归入新的 materials / system 分组
- **AND** 后续实现可以按需吸收其中单个能力，而不需要携带旧 app / route / sync 壳层

### Requirement: Selective Performance And Stability Helpers Are Preserved

系统应当（SHALL）保留旧 TUI 中已验证有效的事件批处理、滚动定位、防抖、frecency 与终端兼容性小件，并将其迁入新的基础设施目录。

#### Scenario: Useful infra helpers survive the old-shell deletion

- **GIVEN** 旧 TUI 中存在事件 batching、搜索 debounce、消息滚动定位、文件选择 frecency 等稳定性或性能辅助逻辑
- **WHEN** 旧壳层被删除
- **THEN** 这些 helper 应迁入新的 infra / perf 分组并继续服务新 TUI
- **AND** 不因为删除旧 session shell 而一并丢失这些已验证有效的细节

### Requirement: Prototype Scroll And Focus Recovery Mechanics

系统应当（SHALL）在 prototype TUI 中提供稳定的历史浏览、手动滚动恢复与显式焦点切换机制，特别是在 composer 保留草稿时仍维持一致行为。

#### Scenario: History scrolling remains recoverable while composer still has draft text

- **GIVEN** composer 中仍保留未提交草稿
- **WHEN** 用户点击历史区，或通过显式焦点切换控件激活历史区后继续滚动
- **THEN** 系统允许历史区恢复为活跃浏览目标
- **AND** 鼠标滚轮、触摸板和键盘滚动行为与无草稿时保持一致

#### Scenario: Manual history browsing is not overridden by streaming updates

- **GIVEN** 用户已主动滚离历史底部浏览旧消息
- **WHEN** assistant 继续流式输出或 runtime 更新消息
- **THEN** 系统不会错误强制将视口拉回底部
- **AND** 只有当用户明确回到底部时才恢复自动跟底

#### Scenario: Bottom bar focus controls stay consistent with real interaction targets

- **GIVEN** 用户通过 bottom bar 中的 `History` 或 `Composer` 按钮切换交互目标
- **WHEN** 焦点区域发生变化
- **THEN** 底栏按钮状态、区域下方提示线和真实滚动 / 输入行为保持一致
- **AND** 不出现“视觉已切换但真实交互目标未切换”的分叉状态

### Requirement: Status And Guidance Surface

系统应当（SHALL）继续打磨 prototype TUI 的状态与指引界面，包括状态展示、忙碌信标和使用提示。

#### Scenario: Provide clear status and system guidance

- **GIVEN** 用户需要了解当前系统状态或下一步可做的操作
- **WHEN** TUI 渲染状态与指引区域
- **THEN** 系统提供清晰的状态信息和使用提示
- **AND** 这些信息不应干扰主消息区与输入区
- **AND** 不破坏底栏 `History` / `Composer` 焦点切换与历史滚动恢复

#### Scenario: Guidance remains aligned with the actual feature surface

- **GIVEN** TUI 的能力边界发生变化
- **WHEN** 指引界面展示帮助和 tips
- **THEN** 系统展示与当前真实能力一致的提示
- **AND** 不继续暴露已经删除或不存在的旧 shell 入口

#### Scenario: Busy beacons and status copy reflect actual runtime state

- **GIVEN** 当前会话处于 busy、idle、retry、error 或其他可感知状态
- **WHEN** 用户观察底栏或相关状态界面
- **THEN** 系统以一致的视觉语言表达这些状态
- **AND** 不继续使用与实际状态脱节的硬编码描述

#### Scenario: Bottom bar polish preserves real focus-switch behavior

- **GIVEN** 底栏同时承担状态摘要和 `History` / `Composer` 焦点切换入口
- **WHEN** 后续对底栏布局、文案或 busy beacon 做 polish
- **THEN** 系统仍保留显式焦点切换控件
- **AND** 不出现“视觉状态更新了，但真实输入/滚动目标被破坏”的回归

#### Scenario: Selection summary moves into the composer chrome while the bottom bar shows compact metrics

- **GIVEN** 当前会话已有 agent/provider/model 选择信息，且用户需要持续看到基础会话指标
- **WHEN** TUI 渲染 composer 标题区和底栏
- **THEN** 系统在 composer 左上角显示当前 `agent · provider/model`
- **AND** 底栏中部改为显示 token usage、turn count 和当前 turn 运行时间等紧凑指标
- **AND** 当 prototype local mode 暂无精确 token usage 时，系统明确使用可识别的估算值而不是伪装成精确统计
- **AND** 底栏不再用中部文案重复表达焦点激活状态
- **AND** 不破坏右侧 `History` / `Composer` 按钮的真实焦点切换语义

#### Scenario: Tips remain optional guidance rather than noisy chrome

- **GIVEN** prototype 已接入更多功能与快捷入口
- **WHEN** 系统展示 tips 或帮助信息
- **THEN** 提示内容应帮助用户理解真实可用能力
- **AND** 不喧宾夺主或干扰消息区与输入区的主流程

### Requirement: Structured Coding Tool Part Cards In Prototype TUI

系统应当（SHALL）将 coding 主链中的工具调用投影为专用消息卡片，而不是继续使用摘要型 tool message。

#### Scenario: Render dedicated cards for coding tool parts

- **GIVEN** runtime 发出 `bash`、`edit`、`write`、`read`、`grep`、`glob`、`list`、`patch` 等 coding 工具 part
- **WHEN** TUI 渲染对应 assistant turn
- **THEN** 系统使用专用工具卡片展示这些工具调用
- **AND** 不再退化为仅包含 `tool + summary` 的简化卡片

#### Scenario: Preserve live tool state updates in structured cards

- **GIVEN** runtime 先后发出同一个 tool call 的 pending、completed 或 error 更新
- **WHEN** prototype graph 持续接收 `message.part.updated`
- **THEN** TUI 保留该 tool part 的稳定身份并更新对应专用卡片状态
- **AND** 卡片可继续读取 `input`、`output`、`metadata` 等结构化字段

#### Scenario: Keep fallback for unsupported tools

- **GIVEN** runtime 发出当前未被专用卡片覆盖的工具调用
- **WHEN** TUI 渲染该工具 part
- **THEN** 系统继续保留 generic fallback card
- **AND** 不因新卡片接入而丢失未知工具的可见性

### Requirement: Research Tool Cards

### Requirement: Structured Composer Interactions

系统应当（SHALL）让新的 prototype composer 支持结构化输入交互，而不是仅保留纯文本 textarea。

#### Scenario: Compose slash, mention, file, and image prompt parts

- **GIVEN** 用户在输入区使用 `/`、`@`、文件引用或图片粘贴
- **WHEN** TUI 处理这些输入
- **THEN** 系统生成结构化 prompt part
- **AND** 使用虚拟文本 / extmark 保持输入区中的可视占位

#### Scenario: Preserve prompt history for structured inputs

- **GIVEN** 用户已提交包含结构化 prompt part 的输入
- **WHEN** 用户回看历史输入
- **THEN** 系统保留 prompt history
- **AND** 历史恢复后仍能还原对应的结构化 part

### Requirement: Material State Uses Depa Data Graph

系统应当（SHALL）将当前为了承接素材而保留的临时 state/navigation 桥收敛到 `vendor/depa-data-graph`。

#### Scenario: Materials consume graph projection instead of bridge contexts

- **GIVEN** 消息卡片、system materials、approval 历史和当前选择态都需要共享响应式状态
- **WHEN** TUI 为这些能力建立状态底座
- **THEN** 系统优先通过 `depa-data-graph` projection 提供这些状态
- **AND** 不继续把 `sync-context`、`sync-store`、`route-context` 作为长期状态真相

#### Scenario: Local preferences remain as adapters

- **GIVEN** TUI 仍需要保存 favorite、recent、theme mode 等本地偏好
- **WHEN** 状态层收敛到 graph
- **THEN** 系统仅将“当前选择态”并入 graph
- **AND** 将本地持久化偏好保留为 graph 外围 adapter

### Requirement: File Picker And Frecency

系统应当（SHALL）为 prototype composer 提供文件选择器，并利用 frecency 改善候选排序。

#### Scenario: Rank file candidates using frecency

- **GIVEN** 用户打开文件选择器
- **WHEN** 系统展示候选文件
- **THEN** 系统利用 frecency 对候选项排序
- **AND** 最近且高频使用的文件应优先出现

#### Scenario: File selection feeds structured composer parts

- **GIVEN** 用户在输入区选择某个文件
- **WHEN** 文件被插入到 composer
- **THEN** 系统生成结构化文件 prompt part
- **AND** 输入区保留对应虚拟文本占位

系统应当（SHALL）为 research 类工具调用提供专用卡片，包括 webfetch、codesearch 和 websearch。

#### Scenario: Render structured research tool cards

- **GIVEN** assistant 调用 `webfetch`、`codesearch` 或 `websearch`
### Requirement: Session Switcher Surface

系统应当（SHALL）为 prototype TUI 提供会话切换界面，以便浏览、切换和管理历史会话。

#### Scenario: Browse and switch sessions from a dedicated surface

- **GIVEN** 用户已有多个历史会话
- **WHEN** 用户打开会话切换界面
- **THEN** 系统展示可浏览的 session list
- **AND** 用户可以切换到目标会话

#### Scenario: Preserve session management actions

- **GIVEN** 用户正在浏览会话列表
- **WHEN** 用户触发重命名或删除等管理动作
- **THEN** 系统继续支持这些动作
- **AND** 不要求恢复旧 dialog 栈整体结构

### Requirement: Provider And Model Surface

系统应当（SHALL）为 prototype TUI 提供 provider 与 model 的管理和切换界面。

#### Scenario: Browse providers and select models

- **GIVEN** runtime 提供多个 provider 和 model
- **WHEN** 用户打开 provider/model 管理界面
- **THEN** 系统展示可选 provider 和 model
- **AND** 用户可以切换当前使用的模型

#### Scenario: Support provider connection flows

- **GIVEN** 某个 provider 需要认证或 API key
- **WHEN** 用户尝试启用该 provider
- **THEN** 系统继续支持相应的认证或输入流程
- **AND** 完成后更新当前可用 provider / model 状态

### Requirement: Agent And MCP System Surface

系统应当（SHALL）为 prototype TUI 提供 agent 选择与 MCP 管理界面。

#### Scenario: Switch current agent from a dedicated surface

- **GIVEN** 用户需要切换当前 agent
- **WHEN** 用户打开 agent 管理界面
- **THEN** 系统展示可选 agent
- **AND** 用户可切换当前 agent

#### Scenario: Manage MCP status from a system surface

- **GIVEN** runtime 提供 MCP server 状态
- **WHEN** 用户打开 MCP 管理界面
- **THEN** 系统展示当前 MCP 状态与开关动作
- **AND** 用户可执行启用、禁用或重连等操作
- **WHEN** TUI 渲染对应工具调用
- **THEN** 系统展示专用 research tool card
- **AND** 用户可直接看到 URL、query 或结果数量等关键信息

#### Scenario: Research tools no longer fall back to generic cards

- **GIVEN** runtime 发出 `webfetch`、`codesearch` 或 `websearch` 的 `ToolPart`
- **WHEN** prototype message renderer 解析对应工具
- **THEN** 系统不再将这些 research 工具退化为 `GenericTool`
- **AND** 它们继续复用与 coding tools 相同的 structured tool part 主链

#### Scenario: Keep research cards secondary to coding flow

- **GIVEN** 当前会话以 coding 为主
- **WHEN** 系统接入 research tool cards
- **THEN** 不影响 coding 主链卡片的优先级与表现
- **AND** research 类卡片作为补充能力存在

#### Scenario: Keep generic fallback for unsupported tools

- **GIVEN** runtime 发出不属于 coding 或 research allowlist 的工具调用
- **WHEN** TUI 渲染该工具 part
- **THEN** 系统继续使用 generic fallback
- **AND** 不因 research cards 接入而丢失未知工具的可见性

### Requirement: Command Palette Surface

系统应当（SHALL）为 prototype TUI 提供统一的命令面板界面，以集中承载可触发动作。

#### Scenario: Show registered commands in a unified palette

- **GIVEN** 系统中存在多类可触发动作和快捷键
- **WHEN** 用户打开命令面板
- **THEN** 系统集中展示这些动作
- **AND** 支持按名称筛选和触发

#### Scenario: Palette exposes system surfaces through one shared entrypoint

- **GIVEN** prototype 已具备 session、provider/model、agent、MCP、status、help 等可触发能力
- **WHEN** 用户打开命令面板
- **THEN** 系统将这些能力作为统一 action surface 暴露出来
- **AND** 用户无需记忆每个 dialog 的独立入口

#### Scenario: Preserve keybind-based direct triggering

- **GIVEN** 某些动作已绑定快捷键
- **WHEN** 用户直接按下快捷键或从命令面板触发
- **THEN** 系统两种触发路径保持一致
- **AND** 不出现重复定义或行为分叉

#### Scenario: Palette remains the secondary entrypoint rather than replacing direct shortcuts

- **GIVEN** 某些高频动作已有直接快捷键或 slash command
- **WHEN** 系统接入命令面板
- **THEN** 这些快捷路径继续保留
- **AND** 命令面板作为统一发现和补充入口存在

### Requirement: Questionnaire History Center

系统应当（SHALL）在 prototype TUI 中为 questionnaire 提供独立的历史中心入口，用于展示已完成与待处理问卷，并通过 modal surface 查看历史与详情，而不是改写主消息历史。

#### Scenario: Show completed and pending questionnaire counts in the footer

- **GIVEN** 当前会话中存在 questionnaire 历史
- **WHEN** TUI 渲染底部状态栏
- **THEN** 状态栏显示 questionnaire 聚合入口
- **AND** 该入口同时表达已完成数量和待处理数量
- **AND** 当存在待处理 questionnaire 时，该入口有清晰的待处理提示

#### Scenario: Open questionnaire history without changing the transcript layout

- **GIVEN** 用户在状态栏点击 questionnaire 聚合入口
- **WHEN** 系统打开 questionnaire history
- **THEN** 使用独立弹窗展示 questionnaire 历史列表
- **AND** 主消息历史的布局、滚动锚点和可见消息顺序不被改写

#### Scenario: History modal prioritizes pending items and summary metadata

- **GIVEN** 会话中同时存在已完成和待处理 questionnaire
- **WHEN** 用户打开 questionnaire history 弹窗
- **THEN** 待处理 questionnaire 排在已完成 questionnaire 之前
- **AND** 每条记录至少展示标题、状态、时间、answered/total 与摘要答案
- **AND** 列表默认不直接展开完整题目内容

#### Scenario: Rehydrate questionnaire center when reopening an existing session

- **GIVEN** 某个会话在当前 TUI 进程之外已经产生过已完成或待处理 questionnaire
- **WHEN** 用户重新打开该会话
- **THEN** footer questionnaire done/pending 计数会从已存在的 runtime questionnaire 记录中恢复
- **AND** questionnaire history modal 仍可列出这些已存在的 questionnaire 摘要与详情
- **AND** 待处理 questionnaire 仍保持优先展示

#### Scenario: Open a specific questionnaire detail from history

- **GIVEN** 用户已打开 questionnaire history 列表弹窗
- **WHEN** 用户选中某条 questionnaire 记录并执行查看详情
- **THEN** 系统打开该 questionnaire 的详情弹窗
- **AND** 详情弹窗展示完整题目、选项、用户原始回答与结构化结果
- **AND** 关闭详情后返回 questionnaire history 列表，而不是跳回主消息历史

#### Scenario: Escape from questionnaire detail returns to history list

- **GIVEN** 用户当前位于 questionnaire detail 弹窗
- **WHEN** 用户按下 `esc`
- **THEN** 系统返回 questionnaire history 列表
- **AND** questionnaire history 弹窗保持打开

#### Scenario: Reviewing questionnaire history does not compete with new assistant content

- **GIVEN** 某个 questionnaire 已完成且 assistant 继续生成新的内容
- **WHEN** 用户没有主动打开 questionnaire history modal
- **THEN** 主对话视图继续以最新 assistant 内容为主
- **AND** 已完成 questionnaire 不依赖在历史底部展开来维持可回看能力

#### Scenario: Message history stays stable while questionnaire history remains accessible

- **GIVEN** 用户会话中已经出现多个 questionnaire
- **WHEN** 用户继续普通对话或浏览主消息历史
- **THEN** 主消息历史保持稳定
- **AND** 用户仍可通过 questionnaire history modal 查看任意旧 questionnaire 的完整细节

### Requirement: Approval History And Summaries

系统应当（SHALL）在保留当前 approval pane 的同时，补充审批历史与摘要展示。

#### Scenario: Show structured approval summaries in conversation history

- **GIVEN** 会话中出现 permission request 或 questionnaire request
- **WHEN** 这些请求被用户处理完成
- **THEN** TUI 在消息历史中保留相应的结构化摘要
- **AND** 用户可以回看当时的审批或回答结果

#### Scenario: Approval pane and history stay consistent

- **GIVEN** 当前会话仍存在活动中的审批请求
- **WHEN** 用户查看 approval pane 和消息历史
- **THEN** 活动请求由 pane 展示
- **AND** 已完成请求由历史摘要展示
- **AND** 两者不出现重复或状态冲突

### Requirement: Interactive Approval And Questionnaire Replies

系统应当（SHALL）在新的 prototype TUI 中继续提供可直接操作的 permission / questionnaire 交互，而不是只显示阻塞提示或纯文本结果。

#### Scenario: Reply to permission requests from the approval pane

- **GIVEN** 当前会话存在活动中的 permission request
- **WHEN** 用户在 approval pane 中处理该请求
- **THEN** 系统提供 allow once、allow always 和 reject 等直接操作
- **AND** permission pane 展示足够的上下文信息，帮助用户做出决策

#### Scenario: Answer questionnaire requests with structured interaction

- **GIVEN** 当前会话存在活动中的 questionnaire request
- **WHEN** 用户在 approval pane 中回答问题
- **THEN** 系统支持选项选择、多题切换、自定义答案输入、提交和 reject
- **AND** 未明确选择的问题组保持为空，而不是自动填充默认选项

### Requirement: Delegation And Question Cards

系统应当（SHALL）为 delegation、question 和 task tree 类型工具调用提供结构化卡片，而不是仅保留摘要信息。

#### Scenario: Render delegation task cards

- **GIVEN** assistant 发起 delegated task
- **WHEN** TUI 渲染对应工具调用
- **THEN** 系统展示结构化 task card
- **AND** 用户可看到 delegated task 的摘要与当前进展

#### Scenario: Render question and task tree cards

- **GIVEN** assistant 产生 question、tasktreewrite 或 tasktreeread 类型工具调用
- **WHEN** TUI 渲染这些工具 part
- **THEN** 系统使用专用卡片展示问题答案或任务树内容
- **AND** 用户无需从原始输出文本中手动还原语义

### Requirement: TUI remains responsive under sustained runtime activity

The system SHALL keep the terminal UI responsive during long coding sessions with frequent runtime events, without unbounded synchronous logging or uncontrolled projection work in the hot path.

#### Scenario: Frequent runtime updates do not lock the UI

- **GIVEN** a session that continuously receives message and part updates
- **WHEN** the user keeps typing and the runtime continues emitting events
- **THEN** the UI SHALL continue to accept input and render updates without becoming unresponsive

#### Scenario: Repeated bootstrapping does not amplify overhead indefinitely

- **GIVEN** the runtime and sync layers emit repeated lifecycle and status events
- **WHEN** those events arrive over a long session
- **THEN** the system SHALL avoid runaway growth in per-event logging and projection cost

### Requirement: Non-state logs use append-only JSONL storage

The system SHALL store non-state diagnostic logs in append-only JSONL files, with one structured record per line and without rewriting prior log content in place.

#### Scenario: Diagnostic logs are appended, not rewritten

- **GIVEN** the UI emits a diagnostic log entry
- **WHEN** the log sink persists the entry
- **THEN** the sink SHALL append one JSON object line to the JSONL file
- **AND** the sink SHALL NOT require reading and rewriting the existing file contents

#### Scenario: State-bearing data stays in runtime/session stores

- **GIVEN** a runtime event or session update that is part of application state
- **WHEN** the system processes that update
- **THEN** the system SHALL keep the state in the existing runtime/session state path
- **AND** SHALL NOT reclassify it as a non-state JSONL log record

### Requirement: TUI source shall be organized by ownership and dependency direction

The system SHALL organize `terminal/packages/tui/src` so source files are grouped by stable responsibilities: entry/startup, runtime adapter, concrete TuiA1 app, reusable UI, providers, commands, support utilities, and types.

#### Scenario: Developer locates TuiA1 feature code

- **GIVEN** a developer needs to modify a concrete TuiA1 feature
- **WHEN** they inspect `terminal/packages/tui/src`
- **THEN** TuiA1-specific feature code is under an app-owned TuiA1 area rather than mixed with generic UI or support code

#### Scenario: Developer locates reusable UI code

- **GIVEN** a developer needs to modify a reusable dialog or primitive
- **WHEN** they inspect `terminal/packages/tui/src`
- **THEN** reusable presentation code is under a reusable UI area and does not import the concrete TuiA1 app implementation

### Requirement: TUI Dialog Visual Standardization

The TUI SHALL render dialogs with a consistent shell, border, spacing, title, and action style that follows the established dialog UI/UX standard.

#### Scenario: Dialog uses the standard shell

- **GIVEN** any TUI dialog is opened
- **WHEN** it is displayed on screen
- **THEN** it SHALL use the shared OpenTUI border style rather than relying only on background contrast
- **AND** it SHALL reserve approximately 5% horizontal outer space and 10% vertical outer space unless a specialized dialog explicitly documents tighter constraints
- **AND** it SHALL keep content visually separated from the border by the dialog category's specified inner spacing.

#### Scenario: Close action is consistent

- **GIVEN** any closable TUI dialog is opened
- **WHEN** the close action is rendered
- **THEN** the action SHALL be displayed as `[关闭(esc)]`
- **AND** clicking it or pressing Escape SHALL close the dialog.

### Requirement: TUI Dialog Action Labels

The TUI SHALL render clickable dialog actions with bracketed labels and readable hover/focus states.

#### Scenario: Dialog actions are visibly clickable

- **GIVEN** a dialog contains clickable actions such as delete, rename, confirm, cancel, clear, quit, or command navigation
- **WHEN** those actions are rendered
- **THEN** each clickable action SHALL use bracketed text such as `[删除]`, `[重命名]`, `[确认]`, `[取消]`, or `[清空]`
- **AND** hover and focus colors SHALL preserve sufficient text contrast.

#### Scenario: Confirmation actions remain clear

- **GIVEN** a confirmation dialog is opened
- **WHEN** confirm and cancel actions are shown
- **THEN** the cancel action SHALL render as `[取消]`
- **AND** the confirm action SHALL render as `[确认]` or a specific bracketed verb when configured.

### Requirement: TUI List Dialog Density And Stability

The TUI SHALL render list dialogs with stable dense rows, usable search controls, and no accidental multiline overflow.

#### Scenario: List rows do not wrap

- **GIVEN** a list dialog displays user-generated text, paths, session names, messages, model names, commands, or status values
- **WHEN** an item contains long text
- **THEN** the visible item text SHALL be truncated to the available single-line region
- **AND** it SHALL NOT wrap into additional rows
- **AND** it SHALL NOT overlap right-aligned metadata or actions.

#### Scenario: Search controls are compact and resettable

- **GIVEN** a list dialog provides a search input
- **WHEN** the search row is displayed
- **THEN** the search input SHALL align with the dialog content column
- **AND** a `[清空]` action SHALL appear right-aligned on the same row when supported
- **AND** activating `[清空]` SHALL reset the search input and refresh the visible list.

#### Scenario: List area uses available height

- **GIVEN** a list dialog is displayed
- **WHEN** the dialog has unused vertical content space
- **THEN** the list area SHALL expand to fill the available height
- **AND** the footer or close row SHALL stay anchored according to the dialog category instead of floating above unused blank space.

### Requirement: Sessions Dialog Remains A Specialized Dense List

The Sessions dialog SHALL preserve its specialized three-line dense record layout and reliable session operations.

#### Scenario: Session item layout is stable

- **GIVEN** the Sessions dialog displays a session record
- **WHEN** the record is rendered
- **THEN** line 1 SHALL show session id, compact session name, and right-aligned actions `[分叉会话] [重命名] [删除]`
- **AND** line 2 SHALL show the initial user question and right-aligned created time
- **AND** line 3 SHALL show the latest message or `-` and right-aligned updated time
- **AND** each line SHALL remain a single line regardless of content length.

#### Scenario: Session item actions update real data

- **GIVEN** the user clicks `[删除]`, `[重命名]`, or `[分叉会话]` on a session item
- **WHEN** the operation succeeds
- **THEN** the underlying session source of truth SHALL be updated
- **AND** reopening the Sessions dialog SHALL show the updated state
- **AND** the visible list SHALL refresh without stale `no message yet` placeholders when message data exists.

### Requirement: TUI Form, Alert, Confirmation, And Information Dialogs

The TUI SHALL standardize non-list dialogs while preserving their existing functional behavior.

#### Scenario: Prompt or form dialog uses standard layout

- **GIVEN** a prompt or form dialog is opened
- **WHEN** its input and actions are rendered
- **THEN** it SHALL use the standard dialog border, readable content spacing, bracketed actions, and stable focus styling
- **AND** async confirm actions SHALL avoid duplicate submission.

#### Scenario: Alert and information dialogs use standard layout

- **GIVEN** an alert, shortcut help, status, provider-auth, or informational dialog is opened
- **WHEN** it is rendered
- **THEN** it SHALL use the shared dialog shell and readable border/foreground colors
- **AND** any footer instructions or close actions SHALL use the standard bracketed action style.

### Requirement: Final TUI source shall not rely on local import aliases

The system SHALL remove TUI-local import alias usage from final TUI source code and SHALL not leave alias-based compatibility code after migrations complete.

#### Scenario: Alias scan after refactor

- **GIVEN** the refactor is complete
- **WHEN** source code under `terminal/packages/tui/src` is scanned for TUI-local aliases such as `@tui/` and `@/`
- **THEN** no import statements use those aliases

#### Scenario: Compatibility shim scan after refactor

- **GIVEN** the refactor is complete
- **WHEN** old compatibility barrel files or migration-only re-export files are reviewed
- **THEN** no migration-only compatibility code remains

### Requirement: Potentially unused or inactive TUI features shall be inventoried before deletion

The system SHALL collect code paths that appear unused, inactive, or future-scaffolded into a track-local inventory before deciding whether to remove, retain, or relocate them.

#### Scenario: Inactive feature scaffold is discovered during refactor

- **GIVEN** feature-related code exists in TUI but may not be actively implemented
- **WHEN** the refactor evaluates feature ownership
- **THEN** the files and call paths are recorded in the inventory with a recommendation to keep, move, or delete

#### Scenario: Unused code is removed

- **GIVEN** a code path is recorded as unused or inactive
- **WHEN** the implementation removes it
- **THEN** the decision and validation evidence are recorded in the track artifacts

### Requirement: TUI module structure refactors shall preserve existing behavior

The refactor SHALL preserve current user-facing TUI behavior, including streaming output, composer behavior, system dialogs, session list, message list, runtime selection, and command entry behavior.

#### Scenario: TUI tests run after structural moves

- **GIVEN** files have been moved or split
- **WHEN** the TUI package tests run
- **THEN** the tests pass without regressions caused by missing imports or behavior changes

#### Scenario: Runtime entry still launches TUI

- **GIVEN** the package entry commands are updated
- **WHEN** the existing dev or CLI startup flow launches the TUI
- **THEN** it reaches the same TuiA1 app behavior as before the refactor
