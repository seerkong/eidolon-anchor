## 上下文
本 track 是 `add-runtime-snapshot-safepoints` 的后续架构整理。前置 track 已经把 safepoint 判定从 persistence writer 中移出，但该 helper 仍留在 `ai-organ-logic`。为了符合 vendor 原语优先和双层微内核架构，需要先建立业务无关的 actor 控制面原语，再建立 AI runtime 领域控制面原语，最后让 `ai-organ-logic` 调用领域原语。

## 方案概览
1. Vendor 层：`vendor/depa-actor-control`
  - 只定义与业务无关的 actor 控制面机制。
  - 核心模型：
    - `ActorControlOperation`：带 causality、idempotency、target actor/fiber、expected barrier 的控制面操作描述。
    - `ControlSignalRecord` / `ControlSignalLedger`：pending、consumed、tombstone、delivery proof 和 replay metadata。
    - `MailboxWorkClassification`：`recoverable_input`、`mandatory_completion`、`interrupt`、`control_marker`、`low_priority_continuation`、`timer_wake`。
    - `ControlBarrier`：判断当前 actor control state 是否允许推进某类 boundary。
    - `DurableHeadCohort`：描述一组 durable head 在 barrier 后统一推进。
  - 不引入 AI、LLM、tool call、questionnaire、member/delegate/holon 字段。

2. AI contract 层：`cell/packages/ai-runtime-control-contract`
  - 定义 AI runtime 控制面 contract，不包含实现。
  - 核心模型：
    - `AiMailboxPolicy`：把 AI mailbox 和 cooperative state 映射到 vendor work classification。
    - `AiTurnBarrier`：用于 snapshot save、idle preemption、heartbeat eligibility、recovery scheduling、TUI settled 判断。
    - `AiControlOperation`：human input、questionnaire answer、cancel turn、heartbeat fire、actor surface selection 等领域操作描述。
    - `AiDurableHeadCohort`：runtime snapshot、conversation head、questionnaire table、scheduler state、actor surface projection 等恢复真相源的 cohort 描述。

3. AI logic 层：`cell/packages/ai-runtime-control-logic`
  - 实现 AI mailbox policy、AI turn barrier 和 safepoint checker。
  - 依赖 `depa-actor-control`、`@cell/ai-core-contract`、`@cell/ai-core-logic`，不依赖 `ai-organ-logic`。
  - 所有跨包依赖必须通过 package name 导入，不允许用相对路径导入其他 package 的 `src`。
  - 第一阶段只迁移 snapshot safepoint 热路径，保留 heartbeat/questionnaire/actor surface 的迁移 seam。

4. Organ 层：`cell/packages/ai-organ-logic`
  - 保留 orchestration binding、tool registry、profile overlay、runtime facade 和 support 组合职责。
  - `RuntimeSnapshots` 与 `AiAgentRuntimeCoordinator` 通过 `@cell/ai-runtime-control-logic` package surface 调用 safepoint API。
  - 不保留 `AiRuntimeSnapshotSafepoint` 旧路径 re-export、shim 或兼容 adapter；调用方必须迁移到新 package。

## 影响范围与修改点（Impact）
- Package / workspace:
  - 新增 `vendor/depa-actor-control/package.json`。
  - 新增 `cell/packages/ai-runtime-control-contract/package.json`。
  - 新增 `cell/packages/ai-runtime-control-logic/package.json`。
  - 根 workspace 需要包含 `vendor/*`。
  - `ai-organ-logic` 增加对 AI runtime control logic 的依赖。
- Contract:
  - 新增 vendor control types。
  - 新增 AI runtime control contract types。
- Logic:
  - 从 `ai-organ-logic/src/runtime/AiRuntimeSnapshotSafepoint.ts` 迁移 safepoint logic。
  - 更新 `RuntimeSnapshots`、`AiAgentRuntimeCoordinator` 的导入。
  - 删除 `ai-organ-logic/src/runtime/AiRuntimeSnapshotSafepoint.ts` 旧 shim，避免形成第二个 API surface。
- Tests:
  - vendor 原语分类和 barrier 数据模型测试。
  - AI mailbox policy 和 safepoint checker 测试。
  - 现有 snapshot safepoint / durable signal / recovery 测试保持通过。

## 决策摘要
- 详见 `codument/tracks/refactor-ai-runtime-control-primitives/decisions.md`。
- 当前关键结论：
  - `depa-actor-control` 放在项目根目录 `vendor/` 下。
  - AI 领域包名固定为 `cell/packages/ai-runtime-control-contract` 与 `cell/packages/ai-runtime-control-logic`。
  - 抽象顺序是 vendor primitive scaffold + AI contract/logic + 最小热路径迁移，不在本 track 中迁移所有控制面功能。
  - wake mailbox 投递、fiber 调度 step 和 durable signal 消费必须保持可恢复一致性：已投递但未 drain 的 wake mailbox 不是 snapshot safepoint，ready fiber 收到 wake/resume 后必须形成可执行 `agent_step`。

## 风险 / 权衡
- 风险：过早 vendor 化导致 AI 语义污染底层。
  - 缓解措施：vendor 类型只表达 actor control mechanics，所有 AI 语义留在 AI runtime control layer。
- 风险：新增包但只迁移 safepoint，会被误解为半成品。
  - 缓解措施：明确本 track 的成功标准是建立边界并迁移最小热路径，后续 heartbeat/questionnaire/actor surface 通过新 track 继续迁移。
- 风险：workspace/package 变动影响测试启动。
  - 缓解措施：先写 package surface smoke tests，再迁移调用方。
- 风险：兼容 shim 长期残留，形成多个事实来源。
  - 缓解措施：本 track 不保留兼容 API、shim 或 re-export adapter，所有调用方直接消费 package name surface。
- 风险：控制信号先于 mailbox work 消费而被 tombstone 化，异常停止后留下 `mailbox has work + no pending signal + no scheduled step` 的不可恢复状态。
  - 缓解措施：snapshot barrier 将未 drain 的 wake mailbox 视为 blocker；ready fiber 的 wake/resume 直接安装 `agent_step`，避免只依赖 pending resume 的异步边界。

## 兼容性设计
- 本 track 是架构边界收敛改造，不保留 `ai-organ-logic/src/runtime/AiRuntimeSnapshotSafepoint.ts` 旧路径。
- `RuntimeSnapshots` 不再 re-export safepoint 类型和函数；需要 safepoint checker 的调用方直接依赖 `@cell/ai-runtime-control-logic`。
- 跨 package 消费必须通过 `depa-actor-control`、`@cell/ai-runtime-control-contract`、`@cell/ai-runtime-control-logic` 等 package name，不允许用相对路径访问其他包的 `src`。
- 不改变 snapshot 文件格式、actor mailbox payload、durable control signal schema 或 `AiAgentVm` contract。

## 迁移计划
1. 建立 `depa-actor-control` vendor package 和最小测试。
2. 建立 `ai-runtime-control-contract` 和 `ai-runtime-control-logic` package。
3. 将 safepoint helper 迁移到 AI runtime control logic。
4. 将 `ai-organ-logic` 调用方切到 `@cell/ai-runtime-control-logic` package name，并删除旧 shim/re-export。
5. 跑相关 runtime recovery / safepoint / durable signal 测试与 Codument validate。

## 待解决问题
- `depa-actor-control` 是否后续发布为独立 npm 包，还是长期作为 repo vendor workspace 包。
- 第二批迁移优先级：heartbeat、questionnaire、actor surface、TUI actor operation 哪个先进入 AI runtime control layer。
