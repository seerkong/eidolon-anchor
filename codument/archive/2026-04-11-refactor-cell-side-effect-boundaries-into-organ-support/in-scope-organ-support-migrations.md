# In-Scope Organ Support Migrations

本文档锁定本 track 第一批“高确定性应迁移到 `organ-support` 的部分”，供 `proposal.md`、`design.md`、`plan.xml` 引用。

## 宗旨

- 数据与接口定义放到 `*-contract`
- 副作用实现放到 `organ-support`
- 其他逻辑放到 `*-logic`
- 如果 `core-logic` 依赖某个副作用：先把接口定义到 `core-contract`，再在 `organ-support` 中实现

## 第一批纳入范围

### 1. 消息历史与编排历史的本地文件实现

- [cell/packages/core-logic/src/runtime/MessageHistoryEffects.ts](../../../cell/packages/core-logic/src/runtime/MessageHistoryEffects.ts)
- [cell/packages/core-logic/src/runtime/OrchestrationHistoryEffects.ts](../../../cell/packages/core-logic/src/runtime/OrchestrationHistoryEffects.ts)

处理原则：
- `appendMessage` / `backupHistory` / `appendEvent` / `backupHistory` 这类副作用接口进入 `core-contract`
- 当前 `LocalFile*` 具体实现迁入 `organ-support`
- `core-logic` 仅依赖 contract，不再持有 `fs` 本地文件实现

### 2. Actor transcript 与 runtime snapshot 的本地持久化边界

- [cell/packages/core-logic/src/runtime/ActorTranscript.ts](../../../cell/packages/core-logic/src/runtime/ActorTranscript.ts)
- [cell/packages/core-logic/src/runtime/snapshot/repository.ts](../../../cell/packages/core-logic/src/runtime/snapshot/repository.ts)
- [cell/packages/organ-logic/src/persistence/RuntimeSnapshots.ts](../../../cell/packages/organ-logic/src/persistence/RuntimeSnapshots.ts)

处理原则：
- 文件路径、目录布局、原子写、读取恢复等持久化副作用接口进入 `core-contract`
- 本地文件 repository / transcript store 实现迁入 `organ-support`
- transcript reducer、snapshot hydrate/serialize、recovery 编排等纯逻辑保留在 `*-logic`
- `RuntimeSnapshots.ts` 按职责拆分，避免整文件机械平移

### 3. 本地权限配置读写

- [cell/packages/organ-logic/src/permissions/LocalPermissionConfig.ts](../../../cell/packages/organ-logic/src/permissions/LocalPermissionConfig.ts)

处理原则：
- 配置数据结构与读写接口放入 `organ-contract`
- `~/.eidolon/permissions.json` 与 `workspace-access.json` 的本地文件实现迁入 `organ-support`
- 权限求值与协议逻辑继续留在 `organ-logic`

### 4. Agent / Skill / LLM 配置的目录与文件加载

- [cell/packages/organ-logic/src/agent/AgentLoader.ts](../../../cell/packages/organ-logic/src/agent/AgentLoader.ts)
- [cell/packages/organ-logic/src/skill/SkillLoader.ts](../../../cell/packages/organ-logic/src/skill/SkillLoader.ts)
- [cell/packages/core-logic/src/runtime/SkillRegistry.ts](../../../cell/packages/core-logic/src/runtime/SkillRegistry.ts)
- [cell/packages/core-logic/src/config/LlmConfigLoader.ts](../../../cell/packages/core-logic/src/config/LlmConfigLoader.ts)

处理原则：
- `core-logic` 若需要消费配置加载副作用，则接口定义进入 `core-contract`
- `organ-logic` 专属的 agent / permission 等目录扫描接口进入 `organ-contract`
- 从目录、文件、home 配置读取的实现迁入 `organ-support`
- 纯解析、合并、注册表内存逻辑保留在 `*-logic`

## 明确不在本次范围

- LLM HTTP adapter：
  - `cell/packages/organ-logic/src/llm/*`
- 本地文件 / 进程工具实现：
  - `cell/packages/organ-logic/src/composer/AIAgent/tools/Read/Logic.ts`
  - `cell/packages/organ-logic/src/composer/AIAgent/tools/Write/Logic.ts`
  - `cell/packages/organ-logic/src/composer/AIAgent/tools/Edit/Logic.ts`
  - `cell/packages/organ-logic/src/composer/AIAgent/tools/Bash/Logic.ts`
- MCP transport / client：
  - `cell/packages/organ-logic/src/mcp/McpSupport.ts`
- 次一级但仍然可疑的边界问题：
  - `cell/packages/symbiont-logic/src/stream/StreamLogger.ts`
  - 其他仅包含少量 `process.env` 或协议适配逻辑、但不构成第一批强约束环境 backend 的模块

## 当前直接调用链风险

- [terminal/packages/organ/src/AIAgent/TerminalRuntime.ts](../../../terminal/packages/organ/src/AIAgent/TerminalRuntime.ts) 当前直接装配：
  - `createLocalFileMessageHistoryEffects`
  - `createLocalFileOrchestrationHistoryEffects`
  - `AgentLoader`
  - `resolveActorModelConfig`

这意味着本次重构不能只改 `cell` 包内文件位置；还需要同步把 runtime entry 改为显式装配 `organ-support` 提供的实现。
