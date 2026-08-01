# Decisions

## Usage
- 记录需用户确认的决策问题、选项、最终结论与理由
- 问题标题不用字母前缀；字母仅用于选项
- 后续执行中出现的新决策继续追加本文件

### 1. 【P0】框定：formalization-only vs 含机制调整
- 背景：scoping audit 发现 member/holon/delegate/subagent 已对齐（零 conversation-truth 写入、零 non-goal 残留）；残留是 3 项形式化缺口（缺 contract / 缺 conformance / 缺 access 规则编码）。
- 选项：
  - A) Formalization-only（只加 contract + conformance + 规则编码，不改机制）
  - B) 含机制调整（除形式化外，把 ad-hoc 的 member/holon/detached 所有权与 Conversation/LLM-Context 访问**路由经新显式 contract 面**——writeCommands 单写、readViews 经 domain protocol）
- 用户答复：B（2026-06-20）
- 最终决策：B — 真正的 refactor（贴合 track id）：声明 `MemberHolonDataComponents` DataSubgraphContract 后，把当前 ad-hoc owned 的 member roster / holon governance / detached tasks 状态收口到该 contract 的单写 writeCommands；把 member/holon 对 Conversation / LLM Context 的访问显式经 domain-protocol readViews/commands（而非直达 runtime 内部）。接受更大回归面。
- 决策理由：用户要求不止形式化；把 ad-hoc 集成路由经显式 contract 面，使「member/holon/delegate 不拥有 conversation truth」从「事实上成立」升为「类型化 contract 强制」，与 W1-W3 其它域一致。
- 边界：仍**不** rewrite 已对齐的 completion/mailbox 机制核心；不创建临时 member id/name 兼容；不让 delegate/subagent 成为 conversation-truth owner；不把 observability 流迁入 conversation truth。
- 状态：accepted

### 2. 【P0】delegate/subagent 完成 mailbox 注入的 wake-class 语义
- 背景：audit 发现「高优先级注入」对应 sync_wait 完成的 `mandatory_completion` wake-class（高优先）；detached 完成故意走 `low_priority_continuation`（低优先，不打断主循环）。
- 选项：
  - A) 钉住现有 sync/detached 分流（conformance 断言 sync_wait→mandatory_completion、detached→low_priority_continuation）
  - B) 强制全部高优先
- 用户答复：A（2026-06-20）
- 最终决策：A — conformance 钉住既有分流；不强制全高优先。
- 决策理由：sync/detached 优先级分流是 lifecycle 已确立的有意语义（同步等待才需高优先注入，后台完成不应打断主循环）；强制全高优会改变 detached 语义并与 lifecycle 设计冲突。
- 状态：accepted

### 3. 【P1】提交/校验/方向审查模式
- 背景：与已归档的 backplane / surfaces track 保持一致。
- 选项：A) 沿用前两 track；B) 自定义
- 用户答复：A（2026-06-20）
- 最终决策：A — CommitMode=manual；终态 phase 挂 `<cdt:GapLoop max-rounds="5" on-exhausted="block"/>`；每个第一层 phase 挂 `<cdt:AttractorCheck use="coding"/>`。
- 状态：accepted
