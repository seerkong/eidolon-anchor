# Decisions

## Usage
- 用于记录需要用户确认的决策问题、选项、最终结论与理由。
- 问题标题不用字母前缀；字母只用于选项。
- 后续执行过程中出现的新决策，也继续追加到本文件，不新建分散的决策记录。

### 1. 【P0】Control Signal Snapshot Payload 表达
- 背景：control signal 需要恢复调度事实，但不应该在 `vm.json` 中保存完整 LLM/tool payload。
- 需要决定：new snapshot shape 如何表达 payload。
- 选项：
  - A) bounded metadata + optional payloadRef。signal snapshot 只保存调度字段、digest/status 和引用。
  - B) 按 mailbox kind 白名单保留小 payload，大 payload 转 ref。
  - C) 其他（可填写）。
- 当前建议：A。
- 用户答复：A。
- 最终决策：A) bounded metadata + optional payloadRef。
- 决策理由：VM snapshot 只保存恢复调度所需的有界元数据、digest/status 与可选 payloadRef；完整 LLM/tool payload 不再直接进入 `vm.json`，以保持 snapshot 边界清晰且大小可控。
- 状态：decided

### 2. 【P0】Consumed Signal Retention 策略
- 背景：`events + consumedEventIds + idempotencyIndex` 当前会无限增长。
- 需要决定：已消费 signal 如何保留幂等和审计信息。
- 选项：
  - A) bounded tombstone window。保留最近 N 条或最近 T 时间内的 idempotency tombstone。
  - B) checkpoint by sequence。保存 checkpoint watermark + pending events + recent tombstones。
  - C) 其他（可填写）。
- 当前建议：B，必要时叠加 recent tombstone window。
- 用户答复：B。
- 最终决策：B) checkpoint by sequence。
- 决策理由：以 sequence checkpoint 表达已消费 signal 的整体水位，只保留 pending events 与 checkpoint 之后必要的 recent tombstones，避免 `events + consumedEventIds + idempotencyIndex` 随长会话无限增长。
- 状态：decided

### 3. 【P1】Legacy Session Full Payload 迁移方式
- 背景：已有 session 可能已经在 `vm.json` 中保存了 full payload。
- 需要决定：如何清理旧数据。
- 选项：
  - A) lazy normalization。恢复时兼容旧格式，下一次保存时输出新 bounded 格式。
  - B) 提供显式 cleanup/migrate command，不在普通保存路径改写。
  - C) 两者都做：普通保存 lazy normalization，另提供 cleanup command 处理历史现场。
- 当前建议：C。
- 用户答复：A。
- 最终决策：A) lazy normalization。
- 决策理由：恢复旧 session 时兼容已有 full payload 快照，但普通保存路径会自动写回新的 bounded VM snapshot；本 track 不额外引入显式 cleanup/migrate command。
- 状态：decided
