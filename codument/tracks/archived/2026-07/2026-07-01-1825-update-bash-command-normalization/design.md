# Bash Command Normalization Design

## 上下文

当前 parser 先尝试把多行命令 collapse 成单行；仍含换行时只接受很窄的 Python heredoc。其他多行命令会直接进入 unsupported fallback，默认 ask。

## 方案概览

1. 顶层换行命令分段
   - 在没有 heredoc 且每行都可独立 tokenized 时，把换行连接为 `;`。
   - 后续沿用现有 `SEGMENT_OPERATORS` 和 per-segment permission rule。

2. Python heredoc 兼容
   - 识别 `python3 <<EOF`、`python3 << 'EOF'`、`python3 - <<EOF`。
   - 对 Python stdin 脚本统一归一成 `python3 -`，继续由 `python3 *` rule 决定 allow / deny / ask。

3. 保守边界
   - 一旦行内出现 unsupported token，仍抛出 `Unsupported shell syntax for permission parsing`。
   - 不把 shell command substitution 伪装成普通换行分段。

## 影响范围与修改点（Impact）

- 仅改 permission parser 的 preprocessing / heredoc normalization。
- 不改 runtime sandbox、tool execution、workspace access grant。

## 决策摘要

- normalization track 只处理能安全落入现有 rule matching 的命令。
- unsupported risk fallback 留给下一 track，避免一次性放宽太多。

## 风险 / 权衡

- 风险：把带上下文依赖的换行脚本误拆成独立命令。
  - 缓解：每行必须通过现有 tokenizer；复杂 shell 仍 unsupported。
- 风险：非 Python heredoc 被误放行。
  - 缓解：只有 basename 以 `python` 开头且最终 command token 可归一为 `python -` 时接受。
