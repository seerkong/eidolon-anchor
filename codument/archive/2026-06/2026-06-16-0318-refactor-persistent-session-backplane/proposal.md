# 变更：持久化会话背板（persistent-session-backplane）

## 背景和动机 (Context And Why)

runtime-evolution mission（`.theater/runtime-evolution-mission/{001,002,009}`）的 W3、P1 track。前序 W1+W2 全部归档完成：数据子图契约、profile/能力边界、conversation spine、turn/tool/provider lifecycle、append-only XNL 都已落地。

独立复评（见 `analysis/findings.md`）确认 `G-data-no-live-storage` 已从 partial 升为 **pass**：live agent loop 不读 storage、不被 storage gate；TUI/surface 不写 domain truth；recovery 单一来源；memory-only 能完成 turn。但仍有 5 项**存储↔运行时软耦合**——持久化/恢复 I/O 与 executor 逻辑耦合、隐式能力传递、写入器与恢复读取器同处一个逻辑模块。本 track 把这些软耦合**硬化为类型化的单向持久化端口 + 专用 persistence 包**，是 mission 001 事实边界论的**存储侧收口**。

同时，本 track 承接 lifecycle track 偏差 #3 标注的下游验证：对 005 真实事故 session 建 **recovery replay harness**，验证"根因修复后恢复不再重复读"。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**
- 把 persistence/recovery（snapshot 写入器、recovery 读取器、derived-index I/O、conversation persistence）从 ai-organ-logic 抽出为**专用 data/persistence 包**，建立单向契约。
- 暴露 **live→write port**（非阻塞 write-behind，失败非致命）与 **recovery→read port**（每事实单一来源）；持久化能力改为**显式注入**，移除 `vm.outerCtx.metadata` 隐式无类型传递。
- executor 主循环不再内联 `persistConversationCompaction` / effect-evidence WAL 文件 I/O，改走注入端口。
- 按 DataSubgraphContract fact-grade 显式分级：checkpoint_snapshot / append_only_journal / derived_projection_cache；保证 append-only journal 不被 checkpoint 管理、不当 live truth。
- 把 `G-data-no-live-storage`（storage 不 gate live loop、memory-only 完成 turn）固化为可执行不变量。
- 建 005 真实事故 session 的 **recovery replay harness**（恢复后 history 完整配对、不重复读）。

**非目标:**
- 不改 TurnState / ToolCall / ProviderCall domain 的事实语义（lifecycle track 已做）。
- 不重写 conversation 三域单写入模型（spine track 已做）；本 track 只搬 I/O，不动 truth 模型。
- 不做 surface 隔离接线（属 `isolate-runtime-projection-surfaces` / G-surface-readonly）；本 track 只提供 projection-read port 能力，TUI 读取器改接留给那条线（决策 3）。
- 不引入新的 runtime guardrail。
- 不做 W4 的全量迁移扫尾。

## 变更内容（What Changes）
- 新建专用 persistence 包，承载 snapshot writer / recovery reader / derived-index I/O / conversation-persistence 适配。
- 新增 **PersistenceWritePort**（write-behind）与 **PersistenceReadPort**（recovery 单源读）契约 + 注入点。**BREAKING**：移除经 `vm.outerCtx.metadata.conversationPersistenceRepositoryFactory` 的隐式持久化能力传递，改显式注入。
- executor（`AiAgentExecutor.ts`）热路径去内联 I/O：`persistConversationCompaction`、`appendRuntimeControlLifecycleEvidenceFromVm` 改走 write port。
- `RuntimeSnapshots.ts`（1727 LOC）按写/读拆分迁入新包。
- DataSubgraphContract（`AiRuntimeDataSubgraphs.ts`）补/对齐 checkpoint_snapshot / runtime_control(effect_wal) / persistence 的 fact-grade 与 Not-Owned-Here。
- 新增 005 事故 recovery replay harness 测试。

## 影响范围（Impact）
- 受影响能力（behaviors）：`persistent-session-backplane`（新）；并对齐 `runtime-data-subgraph-contracts` 的 checkpoint/journal fact-grade 声明。
- 受影响代码：`cell/packages/ai-organ-logic/src/persistence/RuntimeSnapshots.ts`、`exec/AiAgentExecutor.ts`（去内联 I/O）、新建 persistence 包、`cell/packages/ai-core-contract/src/runtime/AiRuntimeDataSubgraphs.ts`、runtime 组装/注入点、recovery 入口 `ShellRuntimeBootstrap.ts`。
- 相邻 track：`isolate-runtime-projection-surfaces`（共享 projection-read port，本 track 提供能力、不接 surface）。
