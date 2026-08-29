# 变更：对齐历史压缩与 Provider Cache Epoch

## 背景和动机 (Context And Why)

官方 DeepSeek 真实 `modeling-blog/ordinary` 运行在历史压缩后被缓存证据门禁拒绝。相邻请求的 provider-visible context facts 已从旧历史锚点移动到压缩后锚点，但 `ProviderCacheCostObservation.identity.contextEpoch` 仍为 3。现场证明 provider receipt 已从 epoch 1 原子推进到 2；观测层却用 `max(provider epoch, Responses continuation baseline)` 合成标量，continuation baseline 的 3 吞掉了 1→2 的真实边界。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**

- 让 provider cache observation 使用 provider-context receipt 作为 v2 authority。
- 历史压缩导致事实重锚定时，下一请求必须进入不同的 cache observation epoch。
- 保留 Responses continuation planner 自身的 baseline epoch 语义，不把两个独立计数器继续用 `max` 混成一个 authority。
- 用相邻请求回归覆盖真实的 work-context/provider-projection 重锚定场景。

**非目标:**

- 不放宽 exact retained-prefix 门禁。
- 不改变 DeepSeek 请求内容、缓存计价、压缩阈值或事实锚定规则。
- 不顺带修复 lazy stream observation 的既有测试漂移。

## 变更内容（What Changes）

- 分离 Responses continuation planning epoch 与 provider cache observation epoch。
- 在 v2 receipt 存在时，cache observation epoch 直接投影 receipt epoch；仅为 legacy/no-receipt 状态保留兼容 fallback。
- 补充压缩边界、普通 append、provider/profile/surface/frozen-resource 边界的回归验证。

## 影响范围（Impact）

- 受影响的能力（behaviors）：`provider-call-domain-lifecycle`
- 受影响的代码：`AiAgentExecutor` 的 provider observation identity 投影与相关 executor tests
