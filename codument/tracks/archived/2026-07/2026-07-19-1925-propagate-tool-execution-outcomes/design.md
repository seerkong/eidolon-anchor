# Tool Execution Outcome Design

## 上下文

当前工具执行的控制面失败事实最终被压成 `outputText`，多个消费者再用 `startsWith("Error:")` 推断。这个约定无法表达“普通输出 + 非零退出码”，也与 ToolCallDomain 已定义的显式 `failureKind` 相冲突。

## 方案概览

1. 通用数据契约
   - `ToolExecutionOutcome = { status: "completed" } | { status: "failed"; failureKind }`。
   - `ToolExecutionResultEnvelope` 增加可选 `outcome`；缺省表示旧工具，继续走 legacy inference。
   - outcome 与 output 正交：output 给模型观察，outcome 给 runtime 控制面。
2. 单一规范化点
   - `resolveToolCallOutput` 解包 output/context effects/outcome，产出 normalized `isError` 与 `failureKind`。
   - 显式 outcome 优先；仅 envelope 未声明 outcome 或纯字符串时才兼容 `Error:` 推断。
3. 两条路径一致传播
   - streaming 与 cooperative 使用 normalized result 写 ToolCallDomain、event bus、effect evidence。
   - cooperative `tool_done` 携带 outcome；replay 从 ToolCallDomain terminal record 恢复，不重新猜文本。
4. Bash adapter
   - sandbox effect 返回结构化 process result；Bash 将 `ok/exitCode/signal/timedOut/error` 纯映射为 generic outcome。
   - 非零退出保留 stdout/stderr，并追加明确退出诊断；不伪装成 effect exception。

## 影响范围与修改点（Impact）

- `cell/packages/ai-core-contract/src/types.ts`
- `cell/packages/ai-core-contract/src/runtime/ToolCallDomain.ts`
- `cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts`
- `cell/packages/ai-organ-logic/src/runtime/ToolCallDomainRuntime.ts`
- `cell/packages/ai-organ-logic/src/persistence/RuntimeSnapshots.ts`
- `cell/packages/ai-organ-logic/src/composer/AIAgent/tools/Bash/`
- `cell/packages/ai-organ-logic/src/sandbox/SandboxBackendRuntime.ts`
- 对应定向测试与 headless E2E

## 决策摘要

- outcome 使用通用 envelope，不在 executor 按工具名分支。
- 保留 legacy string compatibility；显式 outcome 优先。
- 通用层只持有 status/failureKind/output，process-specific 诊断保留在 Bash output。

## 风险 / 权衡

- 兼容路径仍保留文本推断 → 通过测试确保已迁移工具不回退使用推断，后续可逐步迁移其它工具。
- cooperative/recovery 字段遗漏可能造成 live/replay 不一致 → 同时覆盖 live 两路径与 snapshot recovery。
- 当前相关文件已有大量未提交改动 → 只做窄补丁并用 `git diff --check` 与定向测试审查，不执行任何清理命令。

## 兼容性设计

- `outcome` 为可选字段，现有 envelope 和纯输出工具无需同步迁移。
- 旧 snapshot 没有 outcome 字段时继续由 ToolCallDomain status 或 legacy output 推断。

## 迁移计划

1. 先写 normalized outcome 与 Bash nonzero 的失败测试。
2. 扩展 contract 和共享 executor leaf。
3. 贯通 live/cooperative/recovery。
4. 迁移 Bash，运行定向回归与 fresh coding smoke。

## 待解决问题

- 无。
