# 设计：Provider Context Authority 与缓存观测 Epoch 同源

## 根因

当前 `resolveResponsesContextEpoch()` 返回 conversation binding epoch 与 Responses continuation baseline 的最大值。该值既被 Responses request planner 使用，也被 generic provider cache observation 使用。现场中 continuation baseline 已为 3，而 provider-context receipt 在历史压缩时从 1 推进到 2；`max(1,3)` 与 `max(2,3)` 都是 3，导致结构性前缀变化被错误标为 same-epoch divergence。

## 方案

保留 `resolveResponsesContextEpoch()` 给 Responses continuation request planning。新增窄职责投影 `resolveProviderCacheObservationContextEpoch()`：

1. 若 actor binding 有 v2 `providerEpochReceiptV2`，返回该 receipt 的 `epoch`。receipt 是历史重写、provider/model/profile、frozen resource 与 provider surface 变化的统一 authority。
2. 若只有 legacy receipt，返回 legacy receipt epoch。
3. 若还未建立 receipt，兼容回退到现有 Responses epoch，避免初始化路径失去合法非负 identity。

构建 provider request 时，cache observation identity 只调用新投影；Responses transport planner 仍使用原函数。这样两个生命周期不再以 `max` 发生不可逆碰撞。

## 原子边界

`prepareProviderPromptForTurn()` 已在 prompt materialization 前执行 provider-context fence；`commitV2ConversationCompaction()` 又在新 history/fact heads 可见前提交新 receipt。因此修复观测投影后，下一次 adapter createStream 必然同时看到新请求 bytes 与新 receipt epoch。

## 测试策略

- RED：构造 continuation baseline 大于 provider receipt 的 actor；强制历史压缩从 receipt 1→2，并捕获压缩前后两次 `providerCacheCostObservation.contextEpoch`，预期 1→2 而非 3→3。
- 断言压缩后的 facts 可以重锚定，但两次观测比较关系为 `epoch_boundary`。
- 断言普通 append 在 receipt 不变时仍保留同 epoch，避免每 turn 误增 epoch、破坏缓存可比范围。
- 复跑已有 provider epoch、cache observation、compaction 与 DeepSeek adapter suites。

## 风险与兼容

- legacy/no-receipt fallback 保持旧行为。
- v2 下观测 epoch 数值可能从 continuation baseline 值变为 receipt 值；这是 authority 修正，不是持久格式迁移，比较语义只要求同一 identity 内一致、边界间不同。
- 不修改 serialized request，因此不会直接增加 provider token 成本。
