# Headless Paused Progress Exit Design

## 上下文

可恢复 timeout 不应伪装成成功，也不应和 provider failure 混在同一个状态里。调用者需要知道这次 headless exec 没有最终 assistant message，但已有 completed progress 被 runtime seal，可继续 resume。

## 方案概览

1. Exec graph status
   - 扩展 `ExecRunStatus` 为 `idle | running | completed | failed | paused_with_progress`。
   - 新增 `pauseWithProgress(message)` 方法。
   - Snapshot 继续使用 `failureSummary` 存放暂停原因，避免新增破坏性字段。

2. Headless result/trace
   - `HeadlessExecResult.status` 增加 `paused_with_progress`。
   - Trace `session_end.status` 增加同名枚举。
   - Result `finalMessage` 保持 null；last-message 文件不写。

3. Error mapping
   - `runtime_turn_unsettled:*` -> paused.
   - `runtime_turn_not_checkpoint_safe:*` 和 provider failures -> failed.

## 风险 / 权衡

- Existing callers checking only `failed` need to handle the new status. CLI still treats any non-completed status as non-zero, preserving shell automation safety.

## 待解决问题

- Historical end-to-end replay remains in the mission's G4 track.
