# 变更：将 cell 中确定性的副作用边界收敛到 organ-support

## 背景和动机 (Context And Why)

当前 `cell` 分层中，`core-logic` 与 `organ-logic` 仍直接持有多处本地文件、home 配置、目录扫描与 session 持久化实现；而 `cell/packages/organ-support` 目前仍是空壳。这使得“数据与接口定义”、“纯逻辑”、“环境实现”三类职责混在一起，`terminal` 运行时也直接把这些逻辑层中的本地文件实现当作默认 backend 使用。

本次 track 的目标不是一刀切迁移所有副作用，而是先收敛第一批高确定性、边界清晰、已经被默认运行时直接消费的副作用实现，建立后续可扩展到 SQLite / MySQL / 其他环境 backend 的正式分层模式。

高确定性纳入范围见 [in-scope-organ-support-migrations.md](./in-scope-organ-support-migrations.md)。

## “要做”和“不做” (Goals / Non-Goals)

**目标:**
- 明确并冻结 `*-contract` / `organ-support` / `*-logic` 的职责边界
- 将 `core-logic` 依赖的副作用接口先下沉到 `core-contract`
- 将 `organ-logic` 专属副作用接口下沉到 `organ-contract`
- 将第一批高确定性本地文件 / 配置加载实现迁入 `organ-support`
- 让 runtime 入口通过显式装配 `organ-support` 实现来驱动运行，而不是继续直接依赖逻辑层本地实现

**非目标:**
- 不在本次改造中处理 LLM HTTP adapter
- 不在本次改造中处理本地文件 / 进程工具实现
- 不在本次改造中处理 MCP transport / client
- 不在本次改造中一次性清理所有“次一级边界问题”
- 不在本次改造中引入 SQLite / MySQL 新 backend，只建立 contract 和本地文件实现边界

## 变更内容（What Changes）

- 新增一套正式分层规则：
  - 数据与接口定义进入 `*-contract`
  - 副作用实现进入 `organ-support`
  - 纯逻辑留在 `*-logic`
- 将消息历史、编排历史、actor transcript、runtime snapshot、权限配置、agent/skill/config loader 的第一批高确定性副作用实现从逻辑层迁出
- 对 mixed modules 做按职责拆分，而不是整文件机械平移
- 调整 `terminal` 等 runtime entry 的装配方式，使其显式使用 `organ-support` 提供的实现

## 影响范围（Impact）

- 受影响的功能规范：
  - `aiagent-persistence-recovery`
  - `local-coding-tool-permission-controls`
  - `cell-runtime-composer-and-mod-profiles`
  - 新增能力：`cell-contract-logic-support-layering`
- 受影响的代码：
  - [cell/packages/core-contract](../../../cell/packages/core-contract)
  - [cell/packages/organ-contract](../../../cell/packages/organ-contract)
  - [cell/packages/core-logic](../../../cell/packages/core-logic)
  - [cell/packages/organ-logic](../../../cell/packages/organ-logic)
  - [cell/packages/organ-support](../../../cell/packages/organ-support)
  - [terminal/packages/organ](../../../terminal/packages/organ)

另见范围锁定文件：[in-scope-organ-support-migrations.md](./in-scope-organ-support-migrations.md)。
