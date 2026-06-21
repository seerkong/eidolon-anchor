# Decisions

## Usage
- 用于记录需要用户确认的决策问题、选项、最终结论与理由。
- 问题标题不用字母前缀；字母只用于选项。
- 后续执行过程中出现的新决策，也继续追加到本文件，不新建分散的决策记录。

### 1. 【P0】Work mode 状态空间与切换方式
- 背景：当前 work mode 自动推断且枚举过多。
- 需要决定：work mode 是否继续自动推断。
- 选项：
  - A) 保留自动推断
  - B) 改为用户手动 slash command 切换
  - C) 其他
- 当前建议：B
- 用户答复：选择 `type WorkMode = "plan" | "build"`，并通过 `/work-mode build`、`/work-mode plan` 手动切换，默认 `build`。
- 最终决策：B
- 决策理由：work mode 是权限和控制边界，应由用户显式控制，避免 runtime 自动推断导致状态不可解释。
- 状态：decided

### 2. 【P0】Task phase 状态空间与切换方式
- 背景：当前 task phase 过多且混入验证、上下文构建等策略状态。
- 需要决定：task phase 如何收敛。
- 选项：
  - A) 保留多个 phase
  - B) 收敛为 `normal | answer`，由模型 tool call 切换
  - C) 改为用户 slash command
- 当前建议：B
- 用户答复：选择 `type TaskPhase = "normal" | "answer"`，并通过 toolcall 让大模型自主切换。
- 最终决策：B
- 决策理由：task phase 是模型当前响应形态，不应成为用户手动权限状态。
- 状态：decided

### 3. 【P0】旧自动推断和调用次数逻辑
- 背景：旧逻辑包含用户文本推断、工具 progression 和调用次数相关启发式。
- 需要决定：是否保留旧逻辑作为兼容。
- 选项：
  - A) 保留兼容 shim
  - B) 删除旧推断和次数相关逻辑
  - C) 仅保留部分旧逻辑
- 当前建议：B
- 用户答复：完全去掉过去和 work mode、task phase 有关的调用次数相关逻辑。
- 最终决策：B
- 决策理由：新控制模型要求状态切换来源显式，调用次数不应成为控制状态事实源。
- 状态：decided
