# 变更：ContextResourceLoadDecision 识别已压缩/持久化引用为可见覆盖

## 背景和动机 (Context And Why)

`deriveVisibleResourceCoverage`（[ContextResourceLoadDecision.ts:114](cell/packages/ai-organ-logic/src/runtime/ContextResourceLoadDecision.ts:114)）目前只按"当前 message.content 与 toolCallRecords 记录的完整 outputText 字符串全等"判定可见（[:142](cell/packages/ai-organ-logic/src/runtime/ContextResourceLoadDecision.ts:142)）。一旦 compaction 把 tool result 替换成 `<compacted-tool-result>` / `<persisted-tool-result>` 摘要（[ContextCompressor.ts:195,286](cell/packages/ai-organ-logic/src/compression/ContextCompressor.ts:195)），content 不再全等 → 判定不可见 → loader 重新投递整个请求范围 → 大 range 又触发压缩 → 无限翻页。摘要里其实带着"模型已看过正文"的证据（`Full output persisted at: <path>`、`Original characters: <n>`），但当前判定完全无视。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**

- `delivered_and_compacted` 引用视为可见覆盖，复用 resource fact deliveries 中追加保留的原始 range（[persistDelivery](cell/packages/ai-organ-logic/src/runtime/LocalTextResourceLoader.ts:107)，compaction 不删 deliveries）。
- `pending_first_delivery_compacted`（[AiAgentExecutor.ts:818](cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts:818)）不可见——正文在首次投递前就被 spill，模型从未看过。
- already-visible 引用附恢复路径提示（`Full output persisted at: <path>`），模型需要原文时可读 artifact。
- 按 range 精确判定，不做"压缩过就整文件可见"的粗粒度。

**非目标:**

- 不改变 read 工具语义与 total-lines 元信息（G2 track）。
- 不改变压缩管线阈值（G4 track）。

## 变更内容（What Changes）

- `cell/packages/ai-organ-logic/src/runtime/ContextResourceLoadDecision.ts`：
  - `deriveVisibleResourceCoverage` 增加"compacted/persisted 引用"分支：`delivered_and_compacted` → 可见；`pending_first_delivery_compacted` → 不可见。
  - already-visible 判定保持按 range 精确（`subtractLineRanges`）。
  - 可选：返回值携带持久化路径提示。
- 更新/新增相关测试（read_progressive_resource_loading、context visibility）。

## 影响范围（Impact）

- 受影响的能力（behaviors）：`progressive-context-resource-loading`（MODIFIED）
- 受影响的代码：
  - `cell/packages/ai-organ-logic/src/runtime/ContextResourceLoadDecision.ts`
  - `cell/packages/ai-organ-logic/src/runtime/LocalTextResourceLoader.ts`（如需在 already-visible 引用附路径）
  - 相关测试：`read_progressive_resource_loading.test.ts` 等
