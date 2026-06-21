# Decisions

## Usage
- 用于记录需要用户确认的决策问题、选项、最终结论与理由
- 问题标题不用字母前缀；字母只用于选项
- 后续执行过程中出现的新决策，也继续追加到本文件，不新建分散的决策记录

### 1. 【P0】boundary declaration 的宿主包
- 背景：控制面 boundary declaration 是通用机制（任何领域的控制面组件都可声明），但首批三个集群是 AI runtime 语义。需与 DataSubgraphContract 的分层（通用 shape 在 platform-contract、具体 components 在 ai-core-contract）保持一致。
- 需要决定：通用类型与具体声明分别放哪。
- 选项：
  - A) 通用 boundary declaration 类型放 `platform-contract`，三个集群的具体声明放 `ai-core-contract`，engine 专属 conformance 放 `ai-runtime-control-logic/tests`
  - B) 全部放 `ai-runtime-control-contract`
  - C) 其他（可填写）
- 当前建议：A
- 用户答复：我选择选项 A（2026-06-11）。
- 最终决策：A
- 决策理由：boundary declaration 是与 DataSubgraphContract 平级的平台机制，应与之同构分层（通用 shape 在 platform-contract、具体声明在 ai-core-contract），保证组件的数据边界与行为边界落在同一对包、可互相引用同一组件 id；三个集群归属本就跨包，ai-core-contract 是共同上游；未来第二领域可直接复用通用类型而不依赖 AI 控制包。选项 B 会让平台执行主线（OrchestratorDriver）的行为契约从属于 AI 领域控制包，且与"旧 runtime-control 不再主导新路线"的既定方向相悖。
- 状态：accepted

### 2. 【P0】范围切法：契约优先、渐进重构
- 背景：路线图 Track-3 要求三个控制面 logic 的 outer/inner 分层。完整重写触碰 OrchestratorDriver.ts、runtime-control engine、RuntimeSnapshots.ts 大量代码，风险大。
- 选项：
  - A) 契约+conformance 优先，三个集群只做通过 conformance 所需的最小重构；完整重构由本 track 完成后的新 track 承担
  - B) 本 track 内完整重构三个集群
- 用户答复：契约优先，渐进重构。然后本 track 完成后，再创建一个新的 track，完整重构三个 logic。
- 最终决策：A
- 决策理由：延续 W1 的"先 contract 后迁移"模式；完整重构在 conformance 保护下进行更安全。
- 状态：accepted

### 3. 【P1】相邻 track `adopt-ai-runtime-control-composer` 处置
- 背景：该 track 37/37 任务 DONE，覆盖 composer/persistence/control，与本 track 范围相邻，继续活跃会造成边界重叠。
- 选项：
  - A) 标记 completed 并归档，成果降级为输入
  - B) 保持活跃，在本 track decisions 中记录重叠风险
- 用户答复：先归档为输入（推荐）。
- 最终决策：A（已于 2026-06-11 执行归档）
- 决策理由：按既定处置表执行；其 engine/recovery/upgrade 成果已在使用中，归档不影响引用。
- 状态：accepted
