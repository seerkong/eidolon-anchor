# Runtime Progress Seal Recovery Design

## 上下文

完整 runtime checkpoint 必须继续只在 safepoint 保存；本 track 不放宽 safepoint。要解决的是“长时间 turn 有完成进度但未到 safepoint”时，如何在下一轮 continuation 中接住已完成进度。

## 方案概览

1. Production seal wiring
   - Shell bootstrap 和 terminal runtime 在创建 coordinator 时传入 `sealCompletedProgress`。
   - 回调调用 `sealCompletedConversationProgress({ sessionDir, sessionId, vm })`。
   - coordinator 仍只在 `timeout_unsettled` 路径调用该回调，并且调用前 flush write-behind evidence。

2. Forward-only recovery policy
   - Recovery scanner 对 durable head mismatch 做 head-aware 判定。
   - `conversation` head 允许 `actual >= expected`。
   - `actual < expected`、`actual` 缺失、其他 authoritative head mismatch 仍为 dirty。

3. Verification
   - Pure scanner test covers forward, backward, missing, and non-conversation mismatch.
   - Runtime integration test flips the deferred production case: after timeout, recovered history includes sealed progress.

## 影响范围与修改点（Impact）

- Runtime-control recovery classification changes only for conversation forward advancement.
- Production coordinator creation passes a seal callback; no checkpoint save behavior changes.
- Existing direct injection seal tests remain valid.

## 决策摘要

- Keep full snapshot transactionality unchanged.
- Treat completed conversation progress as a closed fact with narrower recovery semantics.
- Leave CLI paused outcome semantics to `headless-paused-progress-exit`.

## 风险 / 权衡

- Risk: broad head mismatch relaxation could hide corruption.
  - Mitigation: only conversation forward-only advancement is clean; all other mismatch remains dirty.
- Risk: seal callback failure could convert timeout into hard failure.
  - Mitigation: coordinator already treats seal as best-effort and catches errors.

## 兼容性设计

- Sessions without sealed progress continue to recover from checkpoint as before.
- Sessions with backward/missing conversation heads still fail dirty recovery.

## 待解决问题

- Headless exec still reports `runtime_turn_unsettled:*` as failure until the next mission track adds paused semantics.
