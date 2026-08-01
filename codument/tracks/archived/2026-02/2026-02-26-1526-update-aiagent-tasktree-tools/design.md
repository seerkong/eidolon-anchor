## 上下文

本次变更属于已完成代码改动的规范化补建，涉及 `core`、`organ`、`composer`、`terminal` 多模块协同。关键目标是将 TaskTree 工具链的命名、契约和 schema 来源统一，并通过 codument 形成可验证、可归档的追踪资产。

约束：
- 本 track 仅追踪已完成改动，不扩展新能力。
- 不包含 vfs 相关文件改造。
- terminal 仅要求 minimal 与基础映射可用。

## 方案概览

1. 工具命名统一
  - `TodoWrite` 统一为 `TaskTreeWrite`
  - `RunSubTask` 统一为 `RunSubAgent`
  - 以新命名作为标准入口，不保留旧名兼容作为规范要求

2. 任务树读取契约稳定化
  - 新增 `TaskTreeRead` 工具
  - 输出定义为完整 `TaskTree` JSON（包含 `root` 与 `nextId`）

3. Tool schema 来源去重
  - `ToolDefinitions` 不再重复维护同名手写 schema
  - 基于 builtin tool defs 组装 `BASE_TOOLS`，动态工具仅注入描述与枚举

4. 终端最小对齐
  - minimal system prompt 使用新命名
  - terminal 工具映射与基础展示支持 `tasktreewrite`/`tasktreeread`

## 影响范围与修改点（Impact）

- 受影响模块：
  - `backend/packages/core/src/modules/AIAgent/plan/TaskTree.ts`
  - `backend/packages/core/src/modules/AIAgent/runtime/actor.ts`
  - `backend/packages/organ/src/AIAgent/plan/TaskTreeManager.ts`
  - `backend/packages/composer/src/modules/AIAgent/ToolFuncBuiltin.ts`
  - `backend/packages/composer/src/modules/AIAgent/ToolDefinitions.ts`
  - `backend/packages/composer/src/modules/AIAgent/tools/TaskTreeWrite/`
  - `backend/packages/composer/src/modules/AIAgent/tools/TaskTreeRead/`
  - `backend/packages/composer/src/modules/AIAgent/tools/RunSubAgent/`
  - `backend/packages/organ/tests/AIAgent/runtime/tool_registry_builtin_behavior.test.ts`
  - `terminal/packages/minimal/src/app.ts`
  - `terminal/packages/tui/src/support/tool/todo.ts`
  - `terminal/packages/tui/src/cli/cmd/agent.ts`
  - `terminal/packages/tui/src/cli/cmd/run.ts`
  - `terminal/packages/tui/src/cli/cmd/github.ts`
  - `terminal/packages/tui/src/cli/cmd/tui/routes/session/index.tsx`

## 决策

- 决策：旧工具名不作为兼容层保留，规范层面直接升级到新命名。
  - 原因：降低认知分叉与长期维护成本，避免双命名漂移。

- 决策：`TaskTreeRead` 返回完整 `TaskTree` JSON 而非精简数组。
  - 原因：便于调试、状态对账与后续扩展（如 nextId 连续性校验）。

- 决策：`ToolDefinitions` 从 builtin tool defs 派生 schema。
  - 原因：消除重复定义，避免 tool-dir 与聚合层 schema 不一致。

- 考虑的替代方案：
  - 方案 A：保留旧名兼容别名
    - 放弃原因：提高维护负担并延长迁移窗口。
  - 方案 B：TaskTreeRead 返回 `root.children` 精简结构
    - 放弃原因：丢失 `nextId` 与完整上下文，不利于排障。

## 风险 / 权衡

- 风险：旧命名调用方可能在外部脚本中仍被使用
  - 缓解：在 spec/proposal 中明确迁移，测试覆盖新命名链路。

- 风险：terminal 侧仅做最小对齐，TUI 深度体验不完整
  - 缓解：本 track 明确范围；后续可独立开 track 做体验增强。

- 权衡：不保留别名可换取更低长期复杂度，但短期迁移成本上升
  - 缓解：通过命名映射说明与目标测试降低回归风险。

## 兼容性设计

- 工具命名属于行为变更：规范仅保证 `TaskTreeWrite` / `RunSubAgent` / `TaskTreeRead`。
- 不要求向后兼容 `TodoWrite` / `RunSubTask`。

## 迁移计划

1. 清理旧命名导入、注册、测试调用。
2. 完成 `TaskTreeRead` 工具接线并纳入 builtin tools。
3. 同步 minimal 与 terminal 基础映射。
4. 运行目标测试与 `codument validate --strict`。

## 待解决问题

- 是否需要在后续 track 中补齐 TUI 对 `RunSubAgent`/`Skill` 的专用渲染体验。
