# 变更：AI 多 agent 域集成（ai-multi-agent-domain-integration）

## 背景和动机 (Context And Why)

runtime-evolution mission Track-8（W3，AI extension 面）。前置全部满足并归档：semantic conversation spine、turn/tool/provider lifecycle；required gates `G-control-depa-actor` / `G-ai-turn-state` / `G-ai-tool-result` 均 pass。

独立 scoping audit（见 `analysis/findings.md`）确认：member / holon / delegate / subagent **已对齐**最关键的边界——**零 conversation-truth 写入**（完成与跨 agent 消息都经 actor mailbox + spine 单写语义管线），**零 non-goal 残留**（`member:` 前缀 key + resolveMember 是永久身份模型，非临时 shim）。但多 agent 集成仍是 **ad-hoc / 未受 data-subgraph 模型治理**：member roster、holon governance、detached tasks 状态由分散的运行时点直接持有/改写，没有声明的单写 owner 与 Not-Owned-Here；member/holon 对 Conversation/LLM Context 的访问没有显式经声明的 domain-protocol 面；delegate/subagent 完成的 mailbox 注入分流（sync→高优先 / detached→低优先）没有 pinned conformance。

本 track 把多 agent 域集成从「事实上正确但 ad-hoc」**refactor 为「类型化 contract 强制」**：声明 `MemberHolonDataComponents` DataSubgraphContract，把 ad-hoc 状态所有权收口到其单写 writeCommands，把 Conversation/LLM-Context 访问路由经 domain-protocol readViews，并 pin delegate/subagent 完成的 mailbox 注入分流。这是 mission 把 member/holon/delegate/subagent 作为 **AI domain extension** 正式接入主干、与 W1–W3 其它域一致治理的收口。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**
- 声明 **MemberHolonDataComponents DataSubgraphContract**：member roster / holon governance / detached tasks 的 owned fact nodes + 单一 owner + writeCommands；Not-Owned-Here 显式声明不拥有 History/LlmContext/ToolCall/TurnState 真源。
- 把 ad-hoc 的 member/holon/detached 状态所有权**收口到该 contract 的单写 writeCommands**（机制调整，决策 1=B）。
- 把 member/holon 对 **Conversation / LLM Context 的访问路由经 domain-protocol readViews**（只读视图 + spine 单写注入），不直达 runtime 内部。
- pin **delegate/subagent 完成 → mailbox 注入**的 conformance，钉住 sync_wait→mandatory_completion / detached→low_priority_continuation 的 wake-class 分流（决策 2=A）。
- 扩展既有 `ai_runtime_data_components` / `ai_runtime_not_owned_here` conformance 覆盖新 contract。

**非目标:**
- 不 rewrite 已对齐的 completion/mailbox 机制核心（只治理 + 路由 + pin）。
- 不创建临时 member id/name 兼容能力（本就没有）；不让 delegate/subagent 成为 conversation-truth owner（经 Not-Owned-Here 固化）。
- 不把 `vm.effects.orchestrationHistory` 的 member/holon observability 流迁入 conversation truth。
- 不改 actor-surface projection（surfaces track 已做）与 Track-5 lifecycle 内部。
- 不强制把所有完成改高优先（保留 detached 低优先语义）。

## 变更内容（What Changes）
- 新增 `MemberHolonDataComponents` DataSubgraphContract（`AiRuntimeDataSubgraphs.ts`）+ 注册 + Not-Owned-Here。
- **BREAKING（内部）**：member roster / holon governance / detached tasks 的直写点收口到 contract writeCommands（单写）；调用方改经 command。
- member/holon 的 Conversation/LLM-Context 读取改经声明的 readViews。
- 新增 delegate/subagent 完成 mailbox 注入 + wake-class 分流的 conformance。
- 扩展 data-components / not-owned-here conformance 测试覆盖新 contract。

## 影响范围（Impact）
- 受影响能力（behaviors）：`ai-multi-agent-domain-integration`（新）；对齐 `runtime-data-subgraph-contracts` 的组件清单。
- 受影响代码：`cell/packages/ai-core-contract/src/runtime/AiRuntimeDataSubgraphs.ts`（新 contract）、`cell/packages/ai-organ-logic/src/organization/MemberManager.ts`、`coordination/CoordinationEngine.ts`、`detached/DetachedActorRegistry.ts`、holon governance（`actor.ts`）、`AiAgentExecutor.ts`（member/holon 注入点）、`ai-runtime-control-logic`（wake-class 表）+ 相关 conformance 测试。
- 相邻 track：`complete-runtime-evolution-migration`（W4 收口，依赖本 track）。
