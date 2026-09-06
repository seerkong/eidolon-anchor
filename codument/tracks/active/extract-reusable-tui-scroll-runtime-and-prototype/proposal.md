# 变更：独立验证并沉淀可复用 TUI 滚动能力

## 背景与动机
历史会话恢复后反复出现大片空白、只显示一张卡片、上滚不加载及新消息不可见。之前的分页改造已建立只读 cursor 和有界读取能力，但分页、测量、原生滚动与 live follow 分散在视图中，缺少同一状态边界及真实交互验收。

本 Track 是用户明确要求的新架构变更，不撤销既有分页行为，不重开已归档 Track。前期代码证据与复现实验的适用范围见 analysis/findings.md。

## 目标
- 用 DEPA 分离滚动数据契约、纯处理器、OpenTUI 副作用与组合入口，形成不依赖 Eidolon AI 领域的库级能力。
- 建立可单独运行的交互原型，直接消费最终功能包；原型验证通过后才能接入 Eidolon。
- 恢复长会话的连续浏览、尾部显示、动态尺寸、live 消息、异常重试和有界资源使用。
- 保留持久会话、Prompt、fork/rewind 的 authority 边界；滚动包只能消费只读投影。
- 沉淀公共 API、接入示例、可执行交互测试与性能证据，后续项目能够复用。

## 非目标
- 不重写 OpenTUI 渲染器，不自建 actor/mailbox/响应式框架。
- 不改 provider、Prompt、workflow 或 Holon 的产品语义。
- 不迁移用户现场数据，不把真实会话正文提交到仓库。
- 不在本次规划中改业务代码、build、local:install 或 commit。
- 不创建外部仓库；原型与业务应用始终 private，滚动库先 workspace 内验证。2026-09-06用户追加授权：将阻断宿主接入的必要上游依赖版本对齐、发布及上游提交纳入P4-T0；不扩大到无关上游变更或发布滚动库。

## 变更内容
- 新增 depa-scroll 契约、逻辑、OpenTUI support 与 capsule；宿主通过一个组合包接入。
- 原型覆盖通用日志列表和聊天形状卡片两个消费者，共用算法、测量、分页控制链路。
- Eidolon 仅保留 Conversation 页面/卡片语义转换，移除平行滚动状态和旧计算实现。
- 必要的只读 forward/anchor 页面恢复契约补齐，使有界缓存淘汰后仍能向下连续浏览；不以全量重读代替。
- 新增独立原型、真实 renderer、Eidolon 只读现场副本三层验证与硬集成门槛。

## 影响范围
- 行为：terminal-tui-shell、runtime-projection-surfaces。
- 通用库拟放 shared/packages；OpenTUI 实现及原型放 terminal/packages。
- 主要接入点：terminal/packages/tui/src/app/tui_a1/view.tsx、features/message/cards.tsx、perf/virtual-history-window.ts、perf/scroll-history.ts、runtime/client/TuiRuntimeClient.ts。
- 分页补齐只触及 ConversationProjectionReadPort 及其本地文件实现的只读路径。

## 执行策略
用户已确认 manual 提交、每阶段 GapLoop、verify_round=true 和最终 coding 架构审查。五个阶段均配置 max_rounds=5、on_exhausted=block；最后阶段在 GapLoop 后执行 AttractorCheck。原型门槛始终有效。当前P1–P3已完成，P4新增上游依赖交付前置任务后继续；不回滚已通过的阶段。
