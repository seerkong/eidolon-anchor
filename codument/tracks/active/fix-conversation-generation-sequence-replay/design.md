# Conversation Generation Sequence Replay Design

## 根因

`historyMessageRecordsToGeneration()` 已先按 XNL `sequence` 读取记录，但 dedupe 后又按 `committedAt` 排序。compaction 复制消息的 `committedAt` 是 wall-clock milliseconds，live append 的 `committedAt` 是 generation ordinal，因此同一字段不可作为跨来源的 chronology key。

## 方案

1. Generation replay order
   - generation 的所有 deduped `HistoryMessage` 都有有效 `sequence` 时，严格按 `sequence` 排序，record id 仅作为异常重复 sequence 的稳定 tie-breaker。
   - generation 不具备完整 sequence metadata 时，作为 legacy generation 整体回退到 `committedAt` + record id 的旧确定性顺序。
   - 不再把有完整 sequence 的 generation 按 `committedAt` 二次重排。

2. Generation freshness
   - immutable lineage metadata 继续从 generation 记录读取。
   - `updatedAt` 取所有可解析 `generationUpdatedAt` 的最大 epoch；没有有效值时保留 legacy generation metadata，再回退到 zero ISO，而不是固定取排序后的第一条。

3. Verification layers
   - repository regression：timestamp-valued compacted user input 后跟 ordinal-valued assistant/tool appends，loader 必须保持 sequence 顺序。
   - projection/TUI acceptance：只读 projection 的最后消息必须是 post-input tool progress，TUI hydration 同序呈现。
   - incident smoke：从 `analysis/findings.md` 的只读 locator 加载真实 session；`::30` 必须先于 `::31..::408`，最终消息为 `::408` tool result。

## 决策摘要

- `sequence` 是 generation 内 chronology；`committedAt` 只保留为 legacy fallback/事实字段。
- 修复共享 reader，使 runtime recovery 与 TUI projection 同时受益。
- 不用 TUI-specific merge 掩盖底层 replay 错序。
- 不修改现有持久化数据。

## 风险与缓解

- Legacy records 可能没有 sequence。
  - 缓解：只有 sequence metadata 不完整的整个 generation 才使用旧 deterministic fallback。
- 重复 record id 可能存在于旧 append-only 文件。
  - 缓解：继续按 stable record id 去重，保留最后可解析记录，再按 canonical order 排列。
- TUI 层测试可能只验证 fake port 而未触达 production reader。
  - 缓解：至少一个 acceptance 使用 local-file production projection port 和真实 XNL fixture。

## 兼容性与迁移

没有数据迁移。故障 session 已持久化正确 `sequence`，升级后的 reader 可直接恢复正确顺序。
