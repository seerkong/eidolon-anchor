## 上下文

mission 005「Member / Holon / Delegate」「Data Governance Actor 类型」「Multi-Agent Profile」。scoping audit（`analysis/findings.md`）：多 agent 域已不写 conversation truth、完成经 mailbox + spine 单写管线，但状态所有权 ad-hoc、访问/分流未经显式 contract 治理。决策 1=B（含机制调整）：不止形式化，把 ad-hoc 所有权与访问路由经新显式 contract 面。决策 2=A：pin 既有 sync/detached wake-class 分流。约束：不 rewrite 已对齐的 mailbox 机制核心，不动 surfaces/lifecycle 内部。

## 方案概览

1. MemberHolonDataComponents DataSubgraphContract（`AiRuntimeDataSubgraphs.ts`）
  - owned fact nodes：`member.roster`（member 身份/角色/lane）、`holon.governance`（holon 治理状态）、`detached.tasks`（delegate/subagent 任务记录）。各自单一 owner。
  - writeCommands：声明 roster/holon/detached 的单写命令（如 upsertMemberRosterRecord / updateHolonGovernance / upsertDetachedTask）。
  - readViews：member/holon 读取 Conversation/LLM-Context 的只读视图引用（复用 conversation domain readViews）。
  - Not-Owned-Here：显式列 History / LlmContext / ToolCall / TurnState owned facts（不归本 contract）。
  - 注册进 data-subgraph 注册表；扩展 `ai_runtime_data_components` / `ai_runtime_not_owned_here` conformance。
2. 状态所有权收口（机制调整，Deliverable 1 enforcement）
  - `MemberManager` roster、holon governance（`actor.ts`）、`DetachedActorRegistry` tasks 的直写点改经 contract writeCommands（单写 owner）；调用方改 command 调用。
  - 保持运行时行为等价（命令是既有写逻辑的显式封装 + 单写收口），按基线 0 新增失败。
3. Conversation/LLM-Context 访问经 domain protocol（Deliverable 3）
  - member/holon 对 Conversation/LLM Context 的读取改经声明 readViews；贡献仍经 spine 单写语义管线（`eventBus.emit`）注入——审计确认已如此，本步把它**编码为规则 + conformance**，并把任何直达 runtime 内部的读路由经 readViews。
4. delegate/subagent 完成 mailbox 注入 + wake-class 分流（Deliverable 2）
  - 为完成→mailbox 注入加 named conformance：断言完成 enqueue `childDone`/`semantic_background_result`，sync_wait→`mandatory_completion`、detached→`low_priority_continuation`，且不调用 conversation writer。
  - 机制本身已对齐；若发现非 conforming 完成路径，路由经 mailbox 注入契约。

## 影响范围与修改点（Impact）
- 新增 `MemberHolonDataComponents` contract + 注册（`AiRuntimeDataSubgraphs.ts`）。
- `MemberManager.ts` / `CoordinationEngine.ts` / `DetachedActorRegistry.ts` / holon governance（`actor.ts`）：状态写收口到 writeCommands。
- `AiAgentExecutor.ts`：member/holon 注入/读取点对齐 readViews / spine 注入。
- `ai-runtime-control-logic`（wake-class 表）+ conformance 测试。

## 决策摘要
- 详见 `decisions.md`。关键：D1 含机制调整（路由经显式 contract 面）；D2 pin 既有 sync/detached wake-class 分流；D3 沿用前两 track 模式。

## 风险 / 权衡
- **风险**：状态所有权收口触及 member/holon/detached 多个运行时写点，回归面较大（决策 1=B 已接受）。→ 缓解：分阶段（先 contract，再逐组件收口写命令，再访问/完成 conformance），每阶段对 cell + terminal 基线按名比对 0 新增；writeCommands 是既有写逻辑的显式封装，行为等价。
- **风险**：把读路由经 readViews 可能与既有 member/holon 直读耦合。→ 缓解：readViews 复用 conversation domain 既有只读视图，不新建第二来源。
- **风险**：wake-class conformance 误把 detached 当高优先。→ 缓解：明确 pin sync→mandatory_completion / detached→low_priority_continuation（决策 2）。

## 兼容性设计
- writeCommands 封装既有写逻辑、单写收口，调用方语义不变。
- 完成 mailbox 机制不变，仅加 conformance pin。

## 迁移计划
- P1 MemberHolonDataComponents contract + Not-Owned-Here + 注册（先红 conformance）。
- P2 member/holon/detached 状态所有权收口到 writeCommands（单写）。
- P3 member/holon Conversation/LLM-Context 访问经 readViews + 规则 conformance。
- P4 delegate/subagent 完成 mailbox 注入 + wake-class 分流 conformance。
- P5 全量回归（cell + terminal 按名比对基线）+ spec 覆盖 + 收尾。
- 回滚：contract + commands 是新增显式面，可逐阶段 git revert。

## 待解决问题
- owned-fact 粒度（roster/holon/detached 各自单写 owner 的精确边界）——P1 定。
- holon governance 状态当前归属（`actor.ts:161` holonState）与新 contract owner 的映射——P2 视实现定。
