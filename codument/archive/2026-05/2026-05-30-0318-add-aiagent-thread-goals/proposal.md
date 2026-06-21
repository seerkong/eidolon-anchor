# 变更：为 AIAgent 增加 thread goal runtime

## 背景

当前项目已有 slash 命令、工具注册、会话持久化和 runtime 编排基础，但还没有与 Codex 同等级的 thread goal 能力：用户不能通过统一的 `/goal` 入口设置或维护长期目标，模型也没有可调用的 goal 读写工具，更缺少基于 turn 生命周期的自动计费、自动续跑和严格的 complete/blocked 审计闭环。

## 变更内容

- 新增持久化的 thread goal 数据模型与 storage/repository。
- 新增 `/goal` 用户入口，并支持查看、设置、编辑、暂停、恢复和清除目标。
- 新增 `get_goal`、`create_goal`、`update_goal` 模型工具，并收口模型可写状态。
- 新增 goal accounting、budget/usage 限制、idle continuation 和 hidden prompt 注入机制。
- 新增 goal completion / blocked 审计约束，确保模型只能在证据充分时完成或阻塞目标。
- 新增 goal 状态事件和用户可见状态同步。

## 不做什么

- 不重写整个 actor orchestration 模型。
- 不修改与 goal 无关的工具 surface。
- 不引入不必要的新外部依赖。
- 不把 goal 做成只靠用户手工维护的静态标签；目标必须参与 runtime 生命周期。

## 影响范围

- 受影响的规范：新增 goal 能力相关 track spec。
- 受影响的代码：
  - `cell/packages/mod-ai-kernel/src/slash.ts`
  - `cell/packages/mod-ai-kernel/src/index.ts`
  - `cell/packages/ai-organ-logic/src/composer/AIAgent/ToolFuncBuiltin.ts`
  - `cell/packages/ai-organ-logic/src/composer/AIAgent/tools/`
  - runtime/session/state/persistence 相关实现
  - 与 goal 状态展示相关的 UI / status surface

