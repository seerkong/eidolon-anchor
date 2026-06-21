# 变更：重构 VM Snapshot 与 Control Signal 边界

## 背景和动机 (Context And Why)

当前 `runtime_state/vm.json` 名义上是 `AiAgentVm` durable subset，但实际会通过 durable control signals 保存完整 LLM/tool completion payload，包括 `reasoning_content`、assistant message、tool output、MCP output 等历史内容。这导致 `vm.json` 成为第二份消息历史和工具日志，和 actor transcript、conversation history、prompt generation、artifact/projection surface 发生重复。

这违反了项目吸引子中的 actor/mailbox/event log/projection 分层，也削弱了前序 durable actor control signals track 的核心原则：control signal 是控制真相，transcript/history 是投影或内容真相。

## “要做”和“不做” (Goals / Non-Goals)

**目标:**
- 明确 `vm.json` 只保存 VM durable subset。
- 让 durable control signals 只保存调度、唤醒、中断、幂等所需的小型结构化元数据。
- 将 LLM/tool completion 的完整 payload 从 VM control signal store 中移出，改由 actor mailbox、transcript、conversation history 或 artifact 引用承载。
- 为 consumed control signals 增加 checkpoint / tombstone / pruning 机制，避免无限增长。
- 保持旧 session 可恢复，并在新保存时逐步规范化旧 full-payload control signals。
- 增加 guard tests，防止 `reasoning_content`、完整 tool output、完整工具 schema 再次进入 `vm.json`。

**非目标:**
- 不重做整个 conversation persistence 主链。
- 不移除 actor mailbox durability；未消费 mailbox payload 仍必须可恢复。
- 不把 transcript/history 提升为控制真相源。
- 不为单个 workspace 或单个 MCP tool 写特例。
- 不在本 track 中解决所有 conversation history 文件过大的问题；本 track 聚焦 `vm.json` 和 control signal 边界。

## 变更内容（What Changes）

- 修改 `RuntimeSnapshotVm` / `serializeVM` / `hydrateVM` 的 control signal snapshot 表达，使 `vm.json` 不再保存 unbounded payload。
- 修改 `DurableControlSignalData` 或其 snapshot 形式，引入 bounded payload metadata、payload refs 或 tombstones。
- 修改 `emitFiberSignal`，避免将 mailbox payload 原样复制进 VM-level control signal store。
- 确保 async completion 的完整 payload 仍进入 actor mailbox，并由合适的 actor/conversation/artifact truth source 持久化。
- 添加 consumed control signal compaction/checkpoint 策略。
- 添加旧 snapshot 兼容读取和新格式保存迁移。
- 添加 regression tests 和 snapshot guard tests。
- 同步相关 docs/knowledge，因为 `knowledgeSync.enabled=true`。

## 影响范围（Impact）

- 受影响的功能规范：
  - `aiagent-persistence-recovery`
  - `aiagent-fiber-orchestration`
- 受影响的代码：
  - `cell/packages/ai-core-contract/src/runtime/DurableControlSignal.ts`
  - `cell/packages/ai-core-contract/src/runtime/RuntimeSnapshotTypes.ts`
  - `cell/packages/ai-core-logic/src/runtime/DurableControlSignals.ts`
  - `cell/packages/ai-core-logic/src/runtime/snapshot/vmSnapshot.ts`
  - `cell/packages/ai-organ-logic/src/OrchestratorDriver.ts`
  - `cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts`
  - `cell/packages/ai-organ-logic/src/persistence/RuntimeSnapshots.ts`
  - `cell/packages/ai-support/src/runtime/LocalFileRuntimeSnapshotRepository.ts`
  - runtime recovery and persistence tests
