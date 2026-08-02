# 变更：修复 Conversation Generation 回放顺序

## 背景和动机 (Context And Why)

历史 session 在 compaction 后继续运行时，同一 generation 内可能同时存在两种合法的 `committedAt` 表示：复制消息保留毫秒时间戳，live append 使用 generation ordinal。当前 reader 按 `committedAt` 重排记录，导致 post-input assistant/tool progress 被移动到最后一次用户输入之前，TUI 看起来像丢失了后续工作。

故障 session 的 `HistoryMessage.sequence=0..408` 完整、连续，后续工作数据没有丢失。应修复共享 conversation reader，而不是修补 session 文件或让 TUI 建立第二条读取路径。

## “要做”和“不做” (Goals / Non-Goals)

**目标：**

- 以持久化 `HistoryMessage.sequence` 作为 generation 的权威回放顺序。
- 对完整缺少 sequence 的 legacy generation 保留确定性 fallback。
- 从最新适用记录重建 generation freshness。
- 用 core repository、projection/TUI acceptance 和真实故障 session 只读验证防止回归。

**非目标：**

- 不放宽 safepoint-only VM snapshot 规则。
- 不重写、修复或迁移用户的历史 XNL 文件。
- 不增加 transcript/checkpoint fallback，不混合多个 conversation 真源。
- 不重构 compaction lineage 或 TUI session selector 的其他行为。

## 变更内容（What Changes）

- 为 mixed `committedAt` generation 增加失败回归测试。
- 修复 `LocalFileConversationPersistenceRepository` 的 generation replay 排序与 freshness 重建。
- 增加只读 projection/TUI hydration 验收，确保 assistant/tool progress 位于最后用户输入之后。
- 对 `Auto_LIFE.OS` 真实 session 执行只读验证。

## 影响范围（Impact）

- 受影响的能力：`conversation-history-replay`
- 受影响的代码：`cell/packages/ai-support` conversation persistence reader、相关 core/projection tests、TUI hydration acceptance tests
- 兼容性：已有正确 sequence 的文件无需迁移；无 sequence 的 legacy generation 继续走 deterministic fallback

