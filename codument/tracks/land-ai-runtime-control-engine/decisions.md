# Decisions

## Usage
- 用于记录需要用户确认的决策问题、选项、最终结论与理由
- 问题标题不用字母前缀；字母只用于选项
- 后续执行过程中出现的新决策，也继续追加到本文件，不新建分散的决策记录

### 1. 【P0】本 track 暂停处置（2026-06-11）
- 背景：runtime evolution 路线（Plan-A/B/C，2026-06）确认旧 runtime-control 边界不应继续扩张补丁；本 track 的 landing/migration 范围将由后续控制面 track（`refactor-runtime-control-component-boundaries`，受 DataSubgraphContract 与 profile/capability 边界约束）取代。任务虽 16/16 标记 DONE，但多个 phase status 仍为 TODO，且 commit 199380f 留有未完成的 engine refactor。
- 选项：
  - A) 标记 cancelled 暂停，全部产物保留作为后续 track 的输入；不归档、不删除
  - B) 继续在旧边界上收尾 landing
- 最终决策：A（用户于 2026-06-11 确认"暂停处置"）
- 决策理由：plan.xml 规范无 paused 状态，cancelled 表示"当前边界内不再继续"，不影响产物作为输入被引用。已完成的 engine/recovery/upgrade 能力已在使用中（session upgrade 共享 capability 等），保留不回滚。
- 状态：accepted

### 2. 【P1】未接线代码 AiRuntimeTurnSupervisor 的处置
- 背景：`cell/packages/ai-organ-logic/src/runtime/AiRuntimeTurnSupervisor.ts`（约 352 行，重复观察跟踪/警告提示系统）随 commit 199380f 进入主干，但未接线到任何主流程，仅测试引用。mission 001 已判定"重复工具调用先视为表象，不应继续加 guardrail"，该文件所代表的方向与新路线冲突。
- 最终决策：保留现状（不接线、不扩展）；其删除或语义吸收归入后续 `refactor-runtime-control-component-boundaries` 或 `complete-runtime-evolution-migration` track 的清理范围。
- 状态：accepted
