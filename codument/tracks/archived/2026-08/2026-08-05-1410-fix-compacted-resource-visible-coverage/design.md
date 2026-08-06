## 上下文

本 track 是 mission `improve-file-read-efficiency-and-context-reuse` 的 G3 落地 track，负责修复 `ContextResourceLoadDecision` 的可见性判定对已压缩/持久化引用不识别的问题。read 工具语义（G2）与压缩阈值配置化（G4）不在本 track 范围。

## 方案概览

1. 可见性判定识别压缩引用（[ContextResourceLoadDecision.ts](cell/packages/ai-organ-logic/src/runtime/ContextResourceLoadDecision.ts)）
   - `deriveVisibleResourceCoverage` 增加分支：当 message.content 匹配 `isCompactedResult`（已存在，[ContextResourceLoadDecision.ts:104](cell/packages/ai-organ-logic/src/runtime/ContextResourceLoadDecision.ts:104)）时：
     - `delivered_and_compacted` → 该 toolCallId 覆盖 deliveries 里记录的原始 range → 可见。
     - `pending_first_delivery_compacted` → 不可见。
   - 关键：resource fact 的 `deliveries` 是追加式保留（[persistDelivery](cell/packages/ai-organ-logic/src/runtime/LocalTextResourceLoader.ts:107)），compaction 不删它，所以"哪些行已投递过"的原始信息还在。
2. already-visible 恢复路径提示
   - 命中 already-visible 且原始 delivery 是 compacted 时，引用附 `Full output persisted at: <path>`。
3. 保持按 range 精确判定
   - 复用现有 `normalizeLineRanges` / `subtractLineRanges`；compacted 引用覆盖的是原始投递 range，请求更大范围时仍返回 missing。

## 影响范围与修改点（Impact）

- `cell/packages/ai-organ-logic/src/runtime/ContextResourceLoadDecision.ts`
- `cell/packages/ai-organ-logic/src/runtime/LocalTextResourceLoader.ts`（如需在 already-visible 引用附路径）
- 相关测试：`read_progressive_resource_loading.test.ts`、context visibility 测试

## 决策摘要

- 详见 `decisions.xnl`。
- `delivered_and_compacted` 可见；`pending_first_delivery_compacted` 不可见（决策 D/E 前的主决策）。
- 按 range 精确判定（决策 E）。
- already-visible 引用附恢复路径提示（决策 D）。

## 风险 / 权衡

- 风险：`pending_first_delivery_compacted` 场景下模型永远拿不到正文。
  - 缓解：此场景不返回 already-visible；模型引导去读 artifact 文件，或 loader 重新投递。
- 风险：如果 delivery 其实没真正进上下文（provider 层丢消息），判定虚高。
  - 缓解：仅当 status 明确为 delivered_and_compacted 才判可见；与 toolCallRecord 状态交叉验证。

## 待解决问题

- 恢复路径提示放在 already-visible 引用文本里，还是作为 `<context-resource>` 新属性。
