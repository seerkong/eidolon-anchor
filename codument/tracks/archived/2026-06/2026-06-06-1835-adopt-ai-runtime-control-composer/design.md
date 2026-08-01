## 上下文
当前 composer 已经具备最小 engine、file-store support 和历史问题集成测试，但还没有接管真实 runtime。替换旧实现的关键不是再写一个内存引擎，而是把真实 session 的文件事实源、运行态 effect 生命周期、actor/mailbox 调度事实和恢复分类全部映射到 composer 的 command/effect/head/cohort 模型中。

## 方案概览
1. 真实 durable head adapter
  - 为 snapshot、conversation、actor transcript、mailbox、control signals、ingress logs、diagnostics logs 定义 head id、sequence 来源和 buffer/commit 语义。
  - 第一阶段采用 shadow write：旧文件仍是 source of truth，composer 写 runtime-control evidence 和 commit marker。
  - 后续 readiness gate 通过后，composer cohort marker 成为 load/resume 前置一致性证明。

2. 真实 effect lifecycle adapter
  - 将 tool call、MCP call、bash call、permission wait、questionnaire parse/provider completion 建模为 effect request/result。
  - 长耗时、权限等待和异步 completion 必须进入显式状态，不依赖内存 Promise 作为唯一事实。
  - tool output 无 request、已删除 handler、重复 completion 等情况必须进入 orphaned/dirty classification。

3. recovery scanner
  - 扫描真实 session 目录，读取旧文件和 runtime-control 文件。
  - 生成 clean/pending/retryable/orphaned/dirty 分类和诊断报告。
  - 对历史现场建立 replay tests，特别覆盖 unpaired tool output、duplicate humanInput、stale removed tool、multi-head mismatch、late completion scheduling。

4. Runtime adoption path
  - 先在 `RuntimeSnapshots` save path 写入 composer shadow cohort。
  - 再接入 coordinator/cooperative execution，把关键事件通过 composer command 表达。
  - 最后在 recovery/load path 使用 composer classifier 阻止 dirty resume。
  - 已完成的第一阶段替换范围是 composer-owned checkpoint/evidence gate：save 在 safepoint 后生成 authoritative cohort marker，load/resume 验证 marker 与 effect evidence。
  - 新增 concrete writer ownership 阶段要求 `RuntimeSnapshots` 主流程不再直接编排 transcript、conversation、runtime snapshot、derived indexes、manifest 等多个 writer；主流程只能构造 concrete checkpoint payload 并交给 composer。旧 concrete writer API 可以继续存在，但只能作为 composer effect handler/support 的实现细节。

5. Concrete writer ownership
  - 定义 `runtime_concrete_checkpoint_write` effect handler，由 composer command engine 调度执行。
  - 当前实现通过 `runFileStoreAiRuntimeConcreteCheckpoint` 接收显式 checkpoint writer callback；callback 是 composer effect handler 的 support 实现细节，避免 composer 反向依赖 ai-organ-logic。
  - composer 执行顺序为：effect request -> support concrete writer -> read real session heads -> buffer durable heads -> cohort commit。
  - `RuntimeSnapshots` 只负责 safepoint 判定和纯数据快照构造；safepoint 后主流程只调用 composer concrete checkpoint API，不再直接顺序编排旧 concrete writers。

6. 持续 gap loop
  - 每完成一个主要 adoption phase 后，对照旧 runtime 职责清单和历史 incident 清单扫描 gap。
  - 新发现 blocker 追加到本 track 的 plan.xml 和 analysis/findings.md。
  - 只有 gap scan 明确“无替换 blocker”后，才允许把 composer 标记为可替换旧实现。

7. Control engine alignment
  - `ai-runtime-control` 的目标不是逐个替换 writer 函数，而是成为一致性边界 owner：业务流程提交 command/event，engine 决定 effect 顺序、evidence 写入、head buffer 与 cohort commit。
  - `RuntimeSnapshots` 只提交 checkpoint request 和纯数据 payload；conversation、transcript、snapshot、derived index、manifest writer 作为 support effect 被调用。
  - effect lifecycle evidence 是控制面事实，Executor 只能通过 composer/control facade 提交事件，不直接写 runtime-control 文件。
  - recovery/load 先通过 control gate 分类 session，再进入旧 repository 作为 support 读取细节。
  - derived indexes 是 projection refresh/cache：不作为 authoritative head，不参与 checkpoint cohort；缺失、过期、部分写入或损坏不应阻止 runtime recovery。
  - ingress/diagnostics 是 journal sink：append 侧通过 control facade/support 管理，但不纳入 checkpoint dirty 判定；需要定位时只能使用日志自身的逻辑事件数或显式事件序列，不能使用文件 byte offset。

8. Session upgrade to owned checkpoint
  - 旧 session 进入 owned mode 前必须显式升级，升级会读取真实 heads、写入 runtime-control head files、提交 checkpoint cohort，并写入不可降级的 `runtime-control/upgrade.json`。
  - 升级后不可降级：缺失或删除 upgrade marker 不属于受支持路径；如果需要回退，应另开 repair/migration track，而不是让 runtime 静默按旧模式恢复。
  - 升级不修复 dirty/orphaned evidence；已有 checkpoint marker 但当前 recovery 分类为 dirty/orphaned 时，升级必须拒绝。

9. Session upgrade dry-run/apply entry
  - 迁移入口分为只读 dry-run 和显式 apply：`dryRunFileStoreAiRuntimeSessionUpgrade` 只读取 upgrade marker、checkpoint marker、真实 heads 与 effect evidence，输出 `classification`、`blockers`、`canUpgrade` 和 `plannedHeads`。
  - `applyFileStoreAiRuntimeSessionUpgrade` 必须先调用同一份 dry-run 规则；已经升级则返回 `already_upgraded`，不可升级则返回 `rejected`，只有 `canUpgrade=true` 才写 checkpoint marker 和 upgrade manifest。
  - CLI 使用 `eidolon session-upgrade --session-dir <path> --dry-run` 或 `--apply`，默认 dry-run，输出 JSON；`--dry-run` 与 `--apply` 同时出现是用法错误。

10. TUI session upgrade prompt
  - TUI 的 session list 不直接拼接文件路径，而是通过 runtime client session API 调用 `upgradeDryRun` / `upgradeApply`。
  - 用户点击加载旧 session 时，TUI 先 dry-run；已升级或 clean checkpoint 直接加载，缺 checkpoint 且 `canUpgrade=true` 时弹出确认，确认后执行同一套 composer apply，再进入 session route。
  - dry-run 返回 dirty/orphaned/pending effect blockers 时，TUI 显示阻断原因并停留在当前流程，不静默恢复旧 session。

11. Runtime effect pending recovery protocol
  - `runtime-control/effects.jsonl` 是 effect lifecycle evidence log，不是普通 checkpoint cohort head；它可以记录非 safepoint 时刻的 request/waiting/result/failed 证据。
  - checkpoint recovery 不能只按 effect evidence 是否存在 pending 来拒绝加载，而必须结合 persisted cooperative inflight 判断 pending 的语义。
  - pending effect 分为两类：
    - pending effect 不属于当前 persisted inflight：不可恢复，必须作为 dirty recovery blocker 拒绝。
    - pending effect 正好属于当前 persisted inflight opId：这是可恢复的中断等待态，允许 load，但恢复必须生成 failed evidence 闭合该 effect，并向 actor 注入错误 tool/LLM completion 继续执行。
  - composer 是该语义的 owner：`decideAiRuntimePendingEffectsRecovery` 判定 pending effect 是否与 recovered inflight 对齐，`buildAiRuntimeInterruptedInflightFailedEvidence` 构造恢复闭合 evidence。
  - `RuntimeSnapshots` 只能调用 composer 的 pending recovery protocol，不应在业务恢复路径中私有维护另一套 pending 判定。

12. Effect evidence WAL and checkpoint logical cursor
  - 修正原设计错误：`runtime-control/effects.jsonl` 不是 `logs/diagnostics.xnl` 那样的普通诊断日志，也不能作为不受 safepoint 管理的全量恢复事实直接参与 checkpoint clean/dirty 判定。
  - `effects.jsonl` 是 runtime-control WAL。每条 append-only 记录必须是 event envelope，包含单调递增的逻辑 `sequence` 与 effect lifecycle event。
  - runtime reader 只接受 envelope 格式；旧 raw event JSONL 不属于新架构合法运行态输入，必须通过显式 session upgrade/repair 转换后才能加载。
  - checkpoint/upgrade 必须记录本次 checkpoint 覆盖到的 `effectEvidenceSequence`。这是事件序列游标，不是文件大小、byte offset、string index 或任意存储层位置。
  - recovery gate 只用 `sequence <= effectEvidenceSequence` 的 WAL prefix 重建 effects 并分类；checkpoint sequence 之后的 WAL tail 是“checkpoint 之后发生的运行证据”，需要后续 replay/reconciliation 或诊断使用，不能反向把已提交 checkpoint 判脏。
  - 这解决“一两轮对话后停下”的根因：运行中 LLM/tool completion append 到 WAL tail，不应让旧 checkpoint 的 snapshot/inflight 与新 tail evidence 直接比较。
  - 旧的 drift guard 只能止血，且仍把 evidence 当成必须同步的全局事实；新设计删除该 guard，改为 checkpoint logical cursor + prefix recovery。
  - composer/dry-run/apply/verification 都必须使用同一个 checkpoint prefix 分类函数；不能在某条路径上回退到读取全量 `effects.jsonl`。
  - checkpoint commit marker 只覆盖 `requiredForCheckpoint=true` 的 durable heads；`logs/ingress.xnl` 与 `logs/diagnostics.xnl` 是 journal sink，不纳入 checkpoint marker，也不参与 checkpoint dirty 判定。
  - Session upgrade 只迁移恢复事实源和 checkpoint-owned evidence。已有 `logs/*` journal sink（例如旧 `logs/orchestration_history.jsonl`）保留为诊断输入，不转换、不隔离，也不作为 legacy append-only residue 触发重复升级。
  - engine 内存 cohort marker 只是控制内核运行结果；file-store commit file 是 durable marker。upgrade marker 必须引用 file-store commit file 的 marker，避免内存 marker 与持久化 marker 分叉。
  - 对已经写成 envelope WAL 且 owned checkpoint、但缺少 `effectEvidenceSequence` 的中间迁移 session，不能回退到全量 WAL 分类；应从同一 `runtime_checkpoint` result evidence 推断 checkpoint WAL 边界。只有 checkpoint 覆盖的 prefix 参与 gate，推断边界之后的 pending LLM/tool evidence 仍是 tail。若 checkpoint 存在但边界无法推断，gate 使用空 prefix 并依靠 head marker 判定 checkpoint，而不是把全量 WAL 当作 checkpoint prefix。
  - state 与 append-only log 必须完全分离：state 文件全量读写，append-only log 逐条追加并按事件 envelope 的逻辑 sequence 定位；不允许同一个文件同时暴露 state 语义和 byte-position 语义。
  - 持久化层不得把 `stat().size`、Buffer byte length 或目录总字节数提升为 runtime-control domain sequence。若需要 sequence，必须来自领域数据字段、事件计数或显式事件序列。
  - runtime-control WAL append 必须串行分配逻辑 sequence；不能用“读最大 sequence + 1 + 并发 append”的非原子组合写出重复 sequence。

## 影响范围与修改点（Impact）
- `cell/packages/ai-runtime-control-contract`：补充真实 head/effect/recovery 数据结构。
- `cell/packages/ai-runtime-control-logic`：补充 reducer、scanner、classifier 纯逻辑。
- `cell/packages/ai-runtime-control-support`：补充 file-store 读写和 scan support。
- `cell/packages/ai-runtime-control-composer`：补充真实 runtime adapter 和 adoption composer。
- `cell/packages/ai-file-store-logic`：沉淀旧文件存储迁移所需的可复用文件逻辑。
- `cell/packages/ai-organ-logic`：在 runtime persistence/coordinator/load path 中接入 composer。
- `cell/packages/ai-organ-logic` 的旧 repository/transcript/index writer 仅作为 composer support handler 调用，不再由 `saveAiAgentRuntimeSnapshot` 主流程直接编排。
- `cell/packages/ai-organ-logic` 的 effect lifecycle、recovery gate、projection refresh、journal sink 需要逐步移到 composer/control facade，避免文件写入旁路。
- `terminal/packages/cli`：提供单 session dry-run/apply 升级命令，作为 owned mode 迁移前的工程入口。
- `terminal/packages/tui`：在 session list 加载旧 session 前提供升级确认入口，避免用户必须切换到 CLI 执行单 session migration。
- Tests：新增真实 session replay、shadow write、dirty recovery 和 readiness gap tests。

## 决策摘要
- 本 track 默认采用 shadow adoption 先行，避免一次性替换旧 runtime source of truth。
- composer 可以成为替换目标；checkpoint/evidence gate 已完成，concrete writer ownership 已在 P6 中通过 composer effect handler 接管具体文件写入触发点。
- P7 对 P6 后发现的偏差做收敛：移除 checkpoint 前 direct write，support 化 concrete handler，evidence 写入改走 composer facade，recovery gate 前置；projection/journal 先明确一致性分域。
- Derived indexes 明确保持为可重建 projection/cache，不升级为 durable head；若 VM/runtime state 与 derived index 冲突，以 VM/runtime state 为准。
- Session 文件升级采用不可降级策略：升级写入 owned checkpoint marker 与 upgrade manifest，后续迁移流程以 runtime-control checkpoint 为恢复一致性凭证。
- Session 文件升级入口必须默认只读诊断，显式 apply 才能写入；apply 不提供修脏数据兼容逻辑，只拒绝并暴露 blockers。
- TUI 与 CLI 共用 composer upgrade facade；TUI 只承担交互确认，不引入独立迁移语义。
- 不为脏历史数据添加静默兼容；dirty 必须被诊断、拒绝或经显式 repair 变 clean。
- effect lifecycle evidence 是 append-only 运行证据；pending evidence 本身不等同于脏数据，只有与 persisted inflight 无法配对的 pending 才是不可恢复状态。与 persisted inflight 配对的 pending 必须在恢复时闭合为 failed evidence。
- effect lifecycle evidence 是 runtime-control WAL；clean/dirty recovery 以 checkpoint 覆盖的 WAL prefix 为准，checkpoint 之后的 WAL tail 不反向污染 checkpoint。
- append-only WAL 的边界采用逻辑事件 sequence，不采用 byte offset；state 文件采用全量读写，不采用 append-only 定位；journal sink 的 progress 语义采用事件数或日志自带事件序列。
- Session upgrade 跳过 journal sink conversion：旧 `logs/*` 审计/诊断日志不是恢复事实源，不参与迁移结果统计，也不因存在而阻止 already-upgraded session 的 clean verification。

## 风险 / 权衡
- 风险：同时迁移太多旧文件路径导致行为回归。
  - 缓解措施：先 shadow write，再 recovery gate，最后切换 ownership。
- 风险：composer 与旧 persistence 并存期间产生双事实源。
  - 缓解措施：明确 shadow 阶段的 source of truth 和 readiness gate，所有 commit marker 带 cohort/head sequence。
- 风险：历史 session 现场无法自动修复。
  - 缓解措施：分类为 dirty/orphaned 并生成诊断，修复工具作为后续显式任务，不静默恢复。

## 兼容性设计
- 旧 runtime 文件格式初期保持不变。
- 新增 runtime-control evidence 文件作为 shadow metadata。
- load/resume 在 gate 开启前不强制要求 runtime-control marker；gate 开启后缺 marker 的旧 session 必须走迁移或 recovery classifier。

## 迁移计划
1. 建立真实 head/effect adapter 和 scanner 测试。
2. 接入 RuntimeSnapshots shadow save。
3. 接入 effect lifecycle 和 coordinator command emission。
4. 接入 recovery/load classifier。
5. 运行真实历史 incident replay。
6. 进行 replacement-readiness gap scan，追加并完成新发现任务。
7. 无 blocker 后切换 composer-owned checkpoint/evidence gate。
8. 已通过 P6 将 concrete runtime writer 编排下沉为 composer effect handler/support，实现 `RuntimeSnapshots` 主流程到 composer concrete checkpoint API 的替换。
9. 通过 P7 将 control engine 对齐为一致性 owner：业务代码只提交 command/event，具体文件写入留在 support effect 或 projection/journal sink 内。
10. 通过 P8 提供显式 session 文件升级逻辑，为 owned mode 迁移做准备，升级后不支持静默降级。
11. 通过 P9 提供 dry-run + 单 session apply CLI：先用 dry-run 检查 blockers，再对单个 session 显式 apply。
12. 通过 P10 在 TUI session list 恢复旧 session 前接入同一套 dry-run/apply，并让用户在 TUI 内确认升级。
13. 通过 P11 补齐 runtime effect pending recovery protocol：composer 覆盖 checkpointed waiting tool effect 与 recovered inflight 的配对判断，并由 runtime recovery 调用 composer 生成 failed evidence 闭合中断 effect。
14. 通过 P12 修正 effect evidence WAL 设计：checkpoint/upgrade 记录 effect WAL logical sequence，recovery gate 只按 checkpoint WAL prefix 分类，tail 留给 replay/diagnostics。

## 待解决问题
- 真实 session 的 sequence 来源是否统一由 runtime-control 分配，还是按各旧文件 head 推导。
- 是否需要在更深层 load path 增加统一 upgrade gate，防止绕过 TUI/CLI 的内部调用直接恢复旧 session；当前 P10 覆盖 TUI session list 入口。
