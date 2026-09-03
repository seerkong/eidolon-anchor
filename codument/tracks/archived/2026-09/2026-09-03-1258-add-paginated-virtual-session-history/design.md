# 设计：分页历史读取、viewport/window 挂载与上滚增量加载

## 现状映射

- `cell/packages/ai-core-contract/src/runtime/ConversationProjectionReadPort.ts` 只有完整 `loadHistoryProjection()`；surface 无法表达尾页/上一页。
- `cell/packages/ai-support/src/conversation/LocalFileConversationProjectionReadPort.ts` 的完整路径调用 `loadConversationHistoryMessages()`；后者经 `loadConversationActorRawState()` 加载所有 visible generations。
- `cell/packages/ai-support/src/conversation/local/LocalFileConversationPersistenceRepository.ts` 的 generation loader 使用 `readXnlRecords()` 全文件解析。已有 `readXnlEdgeRecords()` 只适合目录首尾摘要，不能连续翻页。
- `terminal/packages/tui/src/runtime/client/TuiRuntimeClient.ts` 最多保留 300 条 runtime message，`sync-store.ts` 默认取 100 条，`graph.ts` 再做 200/300 条尾裁剪；这些是缓存上限，不是历史分页。
- `terminal/packages/tui/src/app/tui_a1/features/message/cards.tsx` 对传入消息执行完整 `<For>`，所以所有保留消息仍同时挂载。

## 分页契约

`ConversationHistoryPageQuery` 使用 `limit` 与可选 opaque `before` cursor；无 cursor 表示读取最新尾页。返回：

- `messages`：时间正序的可见 ChatMessage；
- `pageInfo.startCursor`：仅用于继续向更早历史读取；
- `pageInfo.hasPreviousPage`；本 Track 不暴露尚未实现的向后/forward cursor 语义；
- `historyGenerationId/promptGenerationId` 与不可变 `snapshotId`，用于检测 rewind/compaction/provider handoff 后 cursor 失效；
- `observedBytes/sourceBytes`，让“有界读取”可测试。

cursor 编码 adapter 私有的 XNL 字节边界与 snapshot digest，surface 不解释。digest 绑定 session identity、index revision、actor 与 visible-generation authority。任何 cursor 与当前快照不匹配时返回 typed stale-cursor；TUI 保留用户所在窗口并停止自动上翻，由用户按 End 显式刷新到最新尾页，避免异步失效抢走阅读位置。

## 文件侧倒序页读取

在 `ai-file-store-logic` 增加 `readXnlRecordPage()`：从文件尾或 cursor byte offset 向前读取固定窗口，只把 parser 证明完整的顶层 XNL record 返回；窗口两端的半记录丢弃。如果完整候选不足一页则继续向前读下一窗口，单条记录超窗时受控扩张并保持观测量可见。返回记录的绝对 start/end offset，cursor 始终落在已验证记录边界。

Conversation adapter 复用成熟 runtime 的 Prompt-target/history-head 与 lineage 排序函数，再按 active actor、visible generation 和 `(generationId, recordId)` 去重、解码 ChatMessage。Prompt 与 head authority 也通过同一总预算内的 XNL record window 定位；预算内无法证明 authority 时失败关闭，而不是退回 declared tail。mixed-tag 流用所有顶层 XNL 边界切片、再过滤目标 tag，避免历史 `history-generation` 记录夹在 `HistoryMessage` 间导致漏页。fork lineage 的历史由 child canonical source 承载；rewind/compaction 后快照改变，旧 cursor 明确失效。

## TUI 历史窗口

新增无 UI 依赖的 `SessionHistoryWindow` 状态机：初始尾页默认 40 条；页面缓存最大 4 页；根据 `scrollTop`、viewport height 和已测量卡片高度计算 overscan window；未挂载区用 top/bottom spacer 保持滚动几何。renderable mount 数与 viewport + overscan 成正比，而不是与已加载页数/历史总量成正比。

当 `scrollTop` 进入顶部阈值时，串行去重发起 previous-page 请求。prepend 前计算真正新增的历史卡片高度，渲染后把 `scrollTop` 增加该高度；即使有界缓存同时从尾部淘汰页面，也能使原锚点停留在原屏幕位置。首帧使用估算高度，卡片挂载后把实际高度反馈给 window projection 并校正滚动几何。用户在底部时实时消息继续 sticky follow；用户浏览旧页时实时尾部只更新缓存/未读状态，不抢滚动位置。session/actor 切换会丢弃旧异步页结果。

## API 兼容与边界

- `session.messages({sessionID})` 保持原有完整兼容返回；新增 `cursor`/page mode 时返回 page metadata。TUI 主视图只走 page mode，命令面板和诊断调用可继续走兼容完整路径。
- `ConversationProjectionReadPort` 仍为只读；分页状态、card measurement 和 spacer 都属于 surface 投影。
- page result 不参与 provider context 构造，也不反向 gate AI loop。

## 验证策略

- Contract：只读方法集合、cursor opaque、stale snapshot、边界 flags。
- File adapter：多窗口、半条 XNL、oversize record、visible generation、compaction、fork lineage、rewind 尾部隔离，并断言观察字节远小于源文件。
- Window controller：初始尾页、上滚只发一次、乱序响应丢弃、prepend anchor、spacer、页面回收、live 去重。
- Render：数百条已加载消息下只挂载 viewport/overscan 卡片，resize listener 仍为常数。
- Integration：恢复长会话首屏可交互，上滚抵达第一条；切换会话无串页；focused tests、terminal build 和 strict Codument validation 通过。

## 风险与取舍

- 变高卡片需要测量反馈；首帧使用保守估高，测量后校正 spacer/anchor。
- 超大单条 XNL record 无法严格固定 64 KiB 读取；reader 达到页预算后显式报告并拒绝越过该记录，不允许静默遗漏。Conversation 页读取还设有跨过滤扫描的总预算。
- 完整兼容 API 暂时保留，因此非主 TUI 调用仍可全量读取；性能门槛针对会话主恢复和滚动路径。

## 待解决问题

- 无阻塞性待决事项。
