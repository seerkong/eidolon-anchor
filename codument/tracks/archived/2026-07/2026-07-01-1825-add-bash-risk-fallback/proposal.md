# 变更：Add Bash Risk Fallback

## 背景和动机 (Context And Why)

即使 normalization 覆盖常见情况，coding agent 仍会生成 shell parser 不支持的命令，例如 command substitution 读取最新 trace、here-string、复杂 pipeline 中嵌套 Python inspection。当前策略把 parser unsupported 默认转成人工审批，造成高频中断。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**
- parser unsupported 时先运行 deterministic risk fallback。
- 明确 low-risk readonly 命令可按权限规则放行，减少人工审批。
- high-risk 或 protected config 相关命令仍拒绝或审批。
- 用真实 session 近似样本覆盖 fallback 行为。

**非目标:**
- 不把所有 unsupported shell syntax 默认放行。
- 不解析完整 bash AST。
- 不改变 sandbox backend 或 tool execution。

## 变更内容（What Changes）

- 新增 unsupported bash risk classifier。
- `evaluateUnsupportedBashSyntax` 在 ask 前尝试 low-risk readonly allow。
- 扩充 tests，覆盖 command substitution readonly trace、dangerous substitution、protected permission config 和 unknown fallback。

## 影响范围（Impact）

- 受影响的能力（behaviors）：`bash-permission-approval`
- 受影响的代码：
  - `cell/packages/ai-organ-logic/src/permissions/LocalPermissionEvaluator.ts`
  - `cell/packages/ai-organ-logic/tests/AIAgent/local_permission_evaluator.test.ts`
