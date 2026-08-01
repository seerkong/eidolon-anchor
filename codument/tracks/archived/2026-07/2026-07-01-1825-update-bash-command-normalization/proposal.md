# 变更：Update Bash Command Normalization

## 背景和动机 (Context And Why)

真实 session 中，多次审批来自常见低风险 shell 写法被 parser 判为 unsupported：多条只读命令用换行串联、`python3 <<EOF` inspection 脚本、`python3 -c` 多行脚本。这些命令本应进入现有 segment rule 和 readonly safe-command 逻辑，而不是直接请求人工审批。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**
- 把顶层换行串联的命令作为 segment separator 处理。
- 支持 `python3 <<EOF` 与 `python3 - <<EOF` 这类 Python stdin heredoc 归一为 `python3 -`。
- 为常见 Python inspection 命令补测试，证明不再触发 unsupported approval。

**非目标:**
- 不实现完整 shell parser。
- 不放行 command substitution、process substitution、shell grouping 等复杂语法。
- 不实现 parser 失败后的 risk fallback；该能力由 `add-bash-risk-fallback` track 负责。

## 变更内容（What Changes）

- `LocalPermissionEvaluator` 的多行 sanitize 支持顶层换行命令分段。
- heredoc sanitizer 放宽 `python3 << 'EOF'` 这类仍等价 stdin script 的写法。
- permission evaluator tests 更新历史审批样本的 normalization 覆盖。

## 影响范围（Impact）

- 受影响的能力（behaviors）：`bash-permission-approval`
- 受影响的代码：
  - `cell/packages/ai-organ-logic/src/permissions/LocalPermissionEvaluator.ts`
  - `cell/packages/ai-organ-logic/tests/AIAgent/local_permission_evaluator.test.ts`
