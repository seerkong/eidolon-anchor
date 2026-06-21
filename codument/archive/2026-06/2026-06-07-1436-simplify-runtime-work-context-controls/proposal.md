# 变更：简化 Runtime Work Context 控制状态

## 背景和动机 (Context And Why)
当前 runtime work context 同时包含多个 work mode 和 task phase，并由用户输入、工具调用和历史状态自动推断。状态组合过多，容易产生不可解释的自动切换，也会增加 DeepSeek 等 provider 的动态 prompt 变化面。

## “要做”和“不做” (Goals / Non-Goals)
**目标:**
- 将 `WorkMode` 收敛为 `build | plan`。
- 将 `TaskPhase` 收敛为 `normal | answer`。
- 将 work mode 改为用户通过 `/work-mode build` 和 `/work-mode plan` 手动切换，默认 `build`。
- 将 task phase 改为模型通过内部 tool call 自主切换。
- 删除旧的用户文本自动推断 work mode/task phase 逻辑。
- 删除与 work mode/task phase 相关的调用次数、连续工具次数或轮次启发式逻辑。
- 保持 DeepSeek stable prefix 不受 work mode/task phase 动态状态影响。

**非目标:**
- 不重新设计完整 prompt plan 数据结构。
- 不改变 provider tool calling 协议本身。
- 不改变用户已有的普通输入语义，除 `/work-mode ...` slash command 外。
- 不把 task phase 变成用户 slash command。

## 变更内容（What Changes）
- **BREAKING**：旧 `general_execution/localized_repair/small_edit/focused_assignment/direct_lookup/docs_then_code/external_research/long_running_coordination` work modes 将被删除。
- **BREAKING**：旧 `context_build/context_build_then_code/implementation/verification/inspection_only` task phases 将被删除。
- 新增或收敛 `/work-mode build|plan` runtime command，命令不进入 LLM conversation history。
- 新增内部 task phase control tool，用于模型声明 `normal` 或 `answer`。
- Work mode 成为权限边界：`plan` 模式限制写入和破坏性命令；`build` 模式沿用常规工具权限。
- Task phase 成为响应形态边界：`answer` 表示模型准备直接回答，不再继续推进工具驱动任务。

## 影响范围（Impact）
- 受影响的功能规范：`ai-runtime-work-context-control`。
- 受影响的代码：`cell/packages/ai-core-contract` work context types；`cell/packages/ai-organ-logic` context control plane、executor/tool guidance、prompt overlay；`terminal/packages/organ` slash command bridge；相关 TUI 状态展示和 tests。
