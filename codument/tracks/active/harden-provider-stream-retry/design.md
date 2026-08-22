# Design: harden-provider-stream-retry

## 方案

把 provider attempt 的生命周期扩展为：

```text
createStream -> consumeStream -> finalize provider output
```

retry wrapper 必须覆盖整个 attempt，但每个 attempt 暴露一个 typed `outputObserved` 状态。状态至少区分：

- `none`: 尚未收到 assistant 内容、reasoning 或 tool-call fragment；
- `visible_output`: 已收到可见输出，不能安全 replay；
- `completed`: 正常完成。

对于 `response.failed`、`response.error`、SSE EOF、transport reset 等错误，先做现有 provider retry classification，再结合 output state 决定：

- retryable + `none`：按现有 retry policy 延迟重试；
- retryable + `visible_output`：不重试，标记 `indeterminate_after_accept`；
- non-retryable：立即失败。

## 关键边界

Responses adapter 已经有原生 output evidence 和 checkpoint 逻辑。重试 attempt 不能提交 checkpoint、baseline 或 tool result，直到完整 provider output 成功结束。失败 attempt 的 partial evidence 只用于诊断，不进入 canonical conversation。

## 兼容性

- DeepSeek 仍使用 Chat Completions driver，但共享同一 provider retry shell；其 `reasoning_content` 保留逻辑不变。
- OpenAI Chat 与 Responses 都使用同一 retry decision contract。
- 直接实例化底层 adapter 的测试/调用保持现有行为，生产 runtime adapter 路径获得完整 attempt retry。

## 风险与验证

- 风险：stream 已产生隐藏 provider 状态但尚未产生可见 chunk。默认按 `none` 仅适用于当前 transport contract；需要在 adapter 中明确第一可接受事件边界。
- 风险：重试后 diagnostics 可能重复记录 request；使用 attempt identity 区分。
- 验证：纯 retry policy 测试、Responses SSE failure 测试、部分输出不重试测试、DeepSeek reasoning/tool round 回归、provider diagnostic observation 测试。
