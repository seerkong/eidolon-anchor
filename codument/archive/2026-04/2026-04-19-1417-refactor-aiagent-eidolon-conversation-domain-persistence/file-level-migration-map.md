# File-Level Migration Map

本文档将当前与 `.eidolon`、message history、compaction、session load/recovery 相关的实现，拆分为：

- 应迁入或新增到 `@cell/ai-support` 的本地文件副作用实现
- 应保留在 `@cell/ai-organ-logic` 的 orchestration / recovery / runtime 接线
- 应新增到 `@cell/ai-organ-contract` 的 contract 与 interface

目标不是立即逐文件改名，而是为实现阶段提供清晰的 ownership 清单。

## 1. 当前代码盘点

### 已在 `ai-support` 的本地文件实现

- `cell/packages/ai-support/src/runtime/LocalFileActorTranscriptStore.ts`
- `cell/packages/ai-support/src/runtime/LocalFileMessageHistoryEffects.ts`
- `cell/packages/ai-support/src/runtime/LocalFileOrchestrationHistoryEffects.ts`
- `cell/packages/ai-support/src/runtime/LocalFileRuntimeSnapshotRepository.ts`
- `cell/packages/ai-support/src/persistence/LocalFileRuntimeDerivedIndexesStore.ts`
- `cell/packages/ai-support/src/runtime/LocalFileRuntimeConfigLoader.ts`

结论：

- 这些文件已经符合“support backend side effects”定位。
- 新的 conversation persistence 本地实现应沿用这一风格和包归属。

### 当前仍在 `ai-organ-logic` 的持久化编排

- `cell/packages/ai-organ-logic/src/persistence/RuntimeSnapshots.ts`
- `cell/packages/ai-organ-logic/src/runtime/ShellRuntimeBootstrap.ts`
- `cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts`
- `cell/packages/ai-organ-logic/src/compression/ContextCompressor.ts`

结论：

- 这些文件应继续承担 orchestration、runtime recovery、domain 调用接线。
- 但它们不应继续正式拥有新的 `.eidolon/conversation/*` 本地文件读写细节。

### 当前缺失的 conversation persistence contract

`ai-organ-contract` 里当前只有：

- `agent/*`
- `organization/*`
- `permissions/*`
- `persistence/RuntimeDerivedIndexes.ts`

结论：

- 还缺少 conversation persistence 的正式 contract 文件组。

## 2. 目标归属

### A. 应新增到 `@cell/ai-organ-contract`

建议新增目录：

```text
cell/packages/ai-organ-contract/src/conversation/
cell/packages/ai-organ-contract/src/persistence/conversation/
```

建议新增 contract 文件：

- `conversation/ActorHistoryGeneration.ts`
  - `ActorHistoryGenerationData`
  - `ActorHistoryHeadData`
  - `ActorHistoryLineageData`
- `conversation/ActorPromptGeneration.ts`
  - `ActorPromptGenerationData`
  - `ActorPromptBasisData`
  - `ActorPromptTransformData`
  - `ActorPromptHeadData`
- `conversation/LocalConversationSession.ts`
  - `LocalConversationSessionData`
  - `LocalConversationSessionHeadData`
  - `LocalConversationSessionLineageData`
- `conversation/ConversationDomainEvents.ts`
  - history / prompt / session 域事件定义
- `persistence/conversation/ConversationPersistence.ts`
  - repository/store interface
  - path-neutral persistence contract
- `persistence/conversation/ConversationArtifacts.ts`
  - artifact refs contract

这些文件的职责：

- 只定义 domain data、event、repository interface
- 不出现本地 JSON 文件路径和 `fs` 副作用

### B. 应新增到 `@cell/ai-support`

建议新增目录：

```text
cell/packages/ai-support/src/conversation/
cell/packages/ai-support/src/conversation/local/
```

建议新增本地文件实现：

- `conversation/local/LocalConversationPaths.ts`
  - 统一 `.eidolon/sessions/<session>/conversation/*` 路径布局
- `conversation/local/LocalConversationHistoryStore.ts`
  - `history.index.json`
  - `history-generations/*`
- `conversation/local/LocalConversationPromptStore.ts`
  - `prompt.index.json`
  - `prompt-generations/*`
- `conversation/local/LocalConversationSessionStore.ts`
  - `session.index.json`
- `conversation/local/LocalConversationArtifactRefsStore.ts`
  - `artifact-refs.index.json`
- `conversation/local/LocalConversationBootstrap.ts`
  - transcript/snapshot -> conversation persistence bootstrap
- `conversation/local/LocalConversationJson.ts`
  - serializer / parser / schema version helper
- `conversation/index.ts`
  - export support backend

这些文件的职责：

- 负责 `.eidolon` 本地路径、JSON 读写、目录初始化、serializer、bootstrap side effects
- 不承担 domain-level compaction policy 或 runtime orchestration

### C. 应保留在 `@cell/ai-organ-logic`

建议保留并改造的文件：

- `persistence/RuntimeSnapshots.ts`
  - 继续负责 snapshot/recovery orchestration
  - 新增 conversation persistence recovery orchestration
  - 通过 `ai-support` store/repository 读写 conversation heads/generations
- `runtime/ShellRuntimeBootstrap.ts`
  - 继续负责 sessionDir 初始化与 runtime support 装配
  - 不直接定义 conversation 文件格式
- `exec/AiAgentExecutor.ts`
  - committed message -> conversation domain 触发点
  - compaction orchestration 触发点
- `compression/ContextCompressor.ts`
  - 保持压缩策略与 summary 生成逻辑
  - 不直接承担 prompt persistence 文件写入

### D. 可保留原位，但需重新定位的现有 `ai-support` 文件

- `runtime/LocalFileActorTranscriptStore.ts`
  - 保留
  - 重新定位为 transcript evidence / bootstrap input
- `runtime/LocalFileRuntimeSnapshotRepository.ts`
  - 保留
  - 继续只负责 `runtime_state/*`
- `persistence/LocalFileRuntimeDerivedIndexesStore.ts`
  - 保留
  - 继续只负责 derived indexes，而不是 conversation truth

## 3. 逐文件动作建议

### P0: 直接新增，不搬旧文件

- 新增 `ai-organ-contract` 下的 conversation contract 文件组
- 新增 `ai-support` 下的 conversation local store 文件组

理由：

- 这是新语义，不适合硬塞进 `RuntimeDerivedIndexes` 或旧 transcript/snapshot 文件

### P1: 改造现有 orchestration 文件

- `cell/packages/ai-organ-logic/src/persistence/RuntimeSnapshots.ts`
  - 增加 conversation support 配置入口
  - recovery 顺序改为 conversation heads 优先
- `cell/packages/ai-organ-logic/src/runtime/ShellRuntimeBootstrap.ts`
  - 在 runtimeSupport.persistence 中装配新的 conversation persistence support
- `cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts`
  - 接入 committed message -> history persistence
  - 接入 compaction -> history/prompt persistence

### P1: 保留旧 support 文件，但修改用途说明和调用关系

- `cell/packages/ai-support/src/runtime/LocalFileActorTranscriptStore.ts`
  - 保留原有 transcript store
  - 禁止被重新提升为唯一正式 history truth
- `cell/packages/ai-support/src/runtime/LocalFileMessageHistoryEffects.ts`
  - 如继续用于 transcript append，可保留
  - 但其结果应视为 evidence，而不是 conversation domain head

### P2: 兼容迁移辅助

- 新增 `LocalConversationBootstrap.ts`
  - 当旧 session 没有 `conversation/*` 时：
    - 从 transcript
    - 从 snapshot
    - 从 runtime_state/indexes
    - 保守生成第一版 conversation persistence

## 4. 不应做的迁移

- 不应把新的 conversation JSON 文件实现放进：
  - `cell/packages/ai-organ-logic/src/persistence/RuntimeSnapshots.ts`
  - `cell/packages/ai-organ-logic/src/runtime/ShellRuntimeBootstrap.ts`
  - `cell/packages/mod-ai-kernel/*`
  - `terminal/*`

- 不应把 conversation domain data 定义放进：
  - `ai-support`
  - `ai-organ-logic`

- 不应把 transcript / snapshot 文件直接改名后继续充当正式 conversation truth

## 5. 实施顺序建议

1. 先加 `ai-organ-contract` conversation contract
2. 再加 `ai-support` local conversation stores
3. 然后改 `RuntimeSnapshots.ts` 的 recovery orchestration
4. 再改 `AiAgentExecutor.ts` 的 committed message / compaction 持久化
5. 最后补 session load bootstrap 与 focused tests

## 6. 验收清单

- 新增的 `.eidolon/conversation/*` 本地文件实现全部位于 `ai-support`
- `ai-organ-logic` 只通过 interface 调用 `ai-support` repositories
- 历史 session load 不再绕过 conversation heads
- compaction 不再只靠 summary + ack 作为唯一正式历史
- transcript / runtime_state 保留，但降级为 evidence / snapshot / bootstrap
