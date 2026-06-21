# 设计：Runtime Data Subgraph Contracts

## 上下文

项目采用数据优先、effect 显式化、processor/actor 原语优先的架构方向。当前 runtime 的数据图已经包含多个天然子图，但这些子图的 owner、事实等级、可读写边界没有足够硬的工程化表达。

本 track 不直接重写 runtime，而是先补数据契约，使后续改造有可测试的边界。

## 方案概览

### 1. Fact Grade

定义 runtime 数据等级：

- `authoritative_fact`
- `domain_canonical_event`
- `runtime_control_fact`
- `append_only_journal`
- `checkpoint_snapshot`
- `derived_projection_cache`
- `surface_view`
- `legacy_mixed`

规则：

- live AI loop 只能依赖明确授权的 authoritative/runtime/domain facts。
- append-only journal 只用于 audit/debug/replay candidate。
- checkpoint snapshot 只在 explicit recovery 阶段参与。
- projection/cache/surface view 不能反写上游。

### 2. DataSubgraphContract

每个 Data Component 声明：

- `id`
- `layer`
- `ownedFactNodes`
- `derivedNodes`
- `writeCommands`
- `readViews`
- `factStreams`
- `projectionSinks`
- `notOwnedHere`
- `allowedRecoveryReads`
- `forbiddenLiveReads`

### 3. 首批 Data Components

| Component | 角色 |
|-----------|------|
| ActorRuntimeDataComponent | actor registry、fiber registry、mailbox state、scheduler-visible state |
| AiTurnStateDataComponent | waiting/final/completed/failed、mandatory continuation、current turn |
| HistoryDomainDataComponent | formal committed messages、history generation head |
| LlmContextDomainDataComponent | LLM Context generation、basis、transform、overlay（含 work context overlay、compaction summary）、materialized provider context；必须对齐现有 conversation prompt domain 的 generation/basis/transform 概念，不另建平行描述 |
| SessionDomainDataComponent | session metadata、active actor binding、active history head、active LLM Context head、lineage/selection；session head 解析只能有一条声明的优先级规则 |
| ToolCallDomainDataComponent | assistant tool call、tool result attribution、tool protocol pairing |
| ProviderCallDomainDataComponent | provider request/wait/result lifecycle |
| RuntimeControlDataComponent | operation lifecycle、checkpoint cohort、effect WAL、recovery scan |
| CheckpointSnapshotDataComponent | recoverable snapshot 内容（VM durable subset、snapshot manifest、known-good marker）；最小 contract，声明 snapshot 内容的唯一 owner 与 Not Owned Here，不实现 writer |
| SurfaceProjectionComponent | TUI/CLI/diagnostics/read-only projections |

说明：AppendOnlyJournal 与 DerivedIndex 不在首批 component 之列，本 track 仅以 fact grade（`append_only_journal`、`derived_projection_cache`）和 Not Owned Here 断言约束它们；完整 component contract 留给 persistence backplane track（见决策摘要）。

### 4. Not Owned Here

必须显式表达反边界：

- `RuntimeControlDataComponent` 不拥有 conversation truth。
- `checkpoint_snapshot` 不拥有 formal history。
- `append_only_journal` 不拥有 live truth。
- `SurfaceProjectionComponent` 不拥有 domain truth。
- `ToolCallDomainDataComponent` 不拥有 effect IO result lifecycle；它只拥有 AI tool protocol pairing。
- `SessionDomainDataComponent` 不拥有 message 内容；它只拥有 binding/head/lineage 等 session 级事实。
- `CheckpointSnapshotDataComponent` 不拥有 formal history、LLM Context truth 或 control signal payload；snapshot 只承载声明过的 VM durable subset。
- `LlmContextDomainDataComponent` 不拥有 formal committed history；它通过 basis 引用 History Domain 的 active tail。

### 5. Conformance Tests

测试应优先放在 contract/logic 层，避免依赖真实 session：

- classify session files by fact grade。
- reject forbidden live reads。
- assert provider context cannot be materialized from effect journal。
- assert checkpoint snapshot cannot serve as history source。
- assert surface write command to domain truth is invalid。

## 决策摘要

- 先定义 contract，再迁移实现。
- contract 不读取真实文件，不调用 provider/tool/terminal。
- `depa-data-graph` 是后续实现候选；本 track 不强制一次迁移到 graph runtime。
- Runtime profile/capability boundary 是并列第一批 track，不阻塞本 track。
- 宿主包：通用 DataSubgraphContract shape 与 fact grade 机制放 `platform-contract`（领域无关）；首批具体 AI data components 放 `ai-core-contract`。不在 platform 与 AI 两侧平行维护两份 shape 定义。
- Provider context 合法输入必须可由 contract 表达为：LLM Context Domain + History Domain active tail + Session Domain active binding，三者之外的来源均属 forbidden live reads。
- CheckpointSnapshot 仅做最小 owner contract（声明 snapshot 内容归属与反边界），writer/safepoint/cohort 行为不在本 track；AppendOnlyJournal 与 DerivedIndex 的完整 component contract 显式推迟到 persistence backplane track。这是有意决策，不是遗漏。

## 风险 / 权衡

- 风险：contract 太大，难以落地。
  - 缓解：首批只覆盖关键 runtime data components。
- 风险：只定义 contract，短期不修复事故。
  - 缓解：这是后续修复的前置边界，避免继续补丁化。
- 风险：与已有 runtime-control 包重叠。
  - 缓解：本 track 定义数据 owner，不迁移 composer/control 实现。
