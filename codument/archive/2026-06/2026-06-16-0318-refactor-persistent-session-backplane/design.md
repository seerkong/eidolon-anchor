## 上下文

mission 001 的事实边界论：storage / checkpoint / journal / projection 可观察 live execution，但正常运行中不得修改或 gate live agent loop；recovery 每事实单源。spine + lifecycle + XNL 已把 conversation/tool/provider 的 truth 模型与 live-loop 读取做硬（`G-data-no-live-storage` 复评 pass）。剩下的是**存储侧 I/O 与逻辑包的耦合**——本 track 把它硬化为单向端口 + 专用包。约束：本 track 只搬 I/O 与建端口，不改既有 truth 语义；surface 接线另线负责。

## 方案概览

1. 专用 persistence 包（data/persistence 层）
  - 把 `RuntimeSnapshots.ts` 拆为 **writer**（safepoint-gated 快照写）+ **reader**（recovery 读）+ derived-index I/O + conversation-persistence 适配，迁入新包。
  - 包对外只暴露两个端口接口，不泄漏 repository/文件细节。
2. 单向端口契约
  - **PersistenceWritePort**：`writeSnapshot` / `appendEffectEvidence` / `persistCompaction` 等，语义为 write-behind（排队 + fire-and-forget），失败非致命、不阻塞 turn；storage 关闭时为 no-op。
  - **PersistenceReadPort**：`recoverSession` / `loadConversationSource`，恢复期每事实单源，缺源硬失败（不降级混源）。
  - 注入：runtime 组装时显式注入端口实例；移除 `vm.outerCtx.metadata` 隐式 factory 传递。
3. executor 去内联 I/O
  - `persistConversationCompaction`、`appendRuntimeControlLifecycleEvidenceFromVm` 改调注入的 write port；热路径不再 await 文件 I/O。
4. fact-grade 对齐
  - `AiRuntimeDataSubgraphs.ts` 的 checkpoint_snapshot / runtime_control(effect_wal=append_only_journal) / derived index 分级与 Not-Owned-Here 复核对齐；append-only journal 不被 checkpoint 管理。
5. 005 recovery replay harness
  - 用 005 事故持久化产物（或其最小化等价 fixture）跑 recovery → 继续 turn，断言：下一轮 provider context 含完整配对工具结果、不重复读同一文件。

## 影响范围与修改点（Impact）

- 新建 persistence 包；`ai-organ-logic/src/persistence/RuntimeSnapshots.ts` 拆分迁出。
- `ai-organ-logic/src/exec/AiAgentExecutor.ts`：去内联 compaction / evidence I/O。
- `ai-core-contract/src/runtime/AiRuntimeDataSubgraphs.ts`：fact-grade/边界对齐。
- runtime 组装与 `ShellRuntimeBootstrap.ts` recovery 入口：端口注入。

## 决策摘要
- 详见 `decisions.md`。关键：D1 完整拆包 + 单向端口；D2 005 replay harness 本 track 内建；D3 surface 读取器改接推给 surfaces track。

## 风险 / 权衡
- **风险**：拆包 + 端口注入触及 recovery/snapshot 脆弱面，回归面大（基线已有 recovery 相关失败）。→ 缓解：分阶段（先端口契约+注入，再迁包，再去内联，最后 harness），每阶段对基线按名比对 0 新增；保留 write-behind 失败非致命语义不变。
- **风险**：write-behind 改非阻塞后，快照/evidence 时序与既有 recovery 断言耦合。→ 缓解：保留 safepoint-gated 写时机不变，仅去掉热路径 await；recovery 读路径不变（单源）。
- **风险**：移除 outerCtx.metadata 隐式传递是 BREAKING，调用方需改注入。→ 缓解：集中在 runtime 组装点改；memory-only 走显式 in-memory 端口实现。

## 兼容性设计
- 旧快照（payload 未缩减）走 recovery read port 的 evidence-fallback 顺序兜底，不混源。
- storage 关闭时 write port 为 no-op，memory-only loop 不受影响（保持 `G-persist-profile`）。

## 迁移计划
- P1 端口契约 + DataSubgraphContract fact-grade 对齐（先红测试）。
- P2 新建 persistence 包，迁入 writer/reader/index I/O（行为等价）。
- P3 executor 去内联 I/O，改走注入 write port；显式注入替换 outerCtx.metadata。
- P4 recovery read port 单源化复核 + 005 replay harness。
- P5 全量回归 + 基线对照 + 收尾。
- 回滚：端口是新增间接层，git revert 可逐阶段回退。

## 待解决问题
- 新 persistence 包的确切包名/层级（ai-persistence-* 还是并入既有 data 层）——P1 开始时定。
- 005 用真实事故产物还是最小化 fixture——P4 视产物可得性定。
