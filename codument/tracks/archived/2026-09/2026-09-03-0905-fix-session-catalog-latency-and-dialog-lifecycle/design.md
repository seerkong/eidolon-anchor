# 设计：轻量会话目录与生命周期安全弹窗

## 上下文

当前 `TuiRuntimeClient.loadPersistedSessionInfo()` 为生成列表预览而加载 active actor 的完整 history projection；`session.list()` 对全部持久化会话执行该操作，`session.update()` 又通过 `loadBestSessionInfo()` 重复执行。恢复模式还把 `session.list()` 放进第一阶段 blocking requests。这个读放大与 56 MB 现场历史共同造成秒级到几十秒级延迟。

OpenTUI 弹窗同时使用未取消的 1 ms `setTimeout(...focus...)`。当异步加载引发组件重挂载，或 rename prompt 被 replace/clear 后，回调仍可能访问已销毁 renderable；错误堆栈为 `guard -> getText -> focus`。

## 方案概览

1. 轻量 `SessionSummary` 投影
   - 沿用 surface-owned `tui-session.json`，新增可选 `createdAt`、`updatedAt`、`preview` 字段。
   - 摘要只是目录投影，不替代 `conversation/*.xnl` 与 index 的恢复 authority。
   - 对标题、删除状态、有限预览做运行时校验与长度归一化，避免 sidecar 膨胀。
2. 读路径分离
   - `loadPersistedSessionInfo()` 只读取 materialization marker、session index 和轻量 sidecar，不读取 actor/history projection。
   - `session.list()` 只组合 persisted summary 与已经存在的 live state；不得为列表创建 runtime 或读取完整历史。
   - `session.messages()`、定向恢复、fork/rewind 仍通过 `ConversationProjectionReadPort` 完整 hydration。
3. 摘要写入边界
   - rename 直接更新 live state 与 sidecar，不先做完整 hydration。
   - 已完成的定向 hydration、turn、rewind 与 fork 写回当前可证明的 title/time/preview；写回失败不得污染 Conversation authority。
   - legacy sidecar 缺少 preview 时，通过同一只读 Port 请求 `HistorySummaryProjection`；本地文件适配器只读取 `history.index.json` 和 `history.xnl` 的固定大小首尾窗口，从窗口中的完整顶层 `HistoryMessage` 记录提取预览。
   - 首尾窗口按顶层记录起点切片并交给 XNL parser 验证；窗口边缘的半条记录必须丢弃，不能用正则直接解释截断内容。第一条消息沿 session lineage 取根会话头部；最近消息以当前 history index 的 active actor / visible generations 过滤，避免把已回退分支尾部当成最近消息。
   - 用户真正加载会话后，仍由完整权威 hydration 自动回填 sidecar。
4. Bootstrap 解耦
   - provider/config 与当前会话定向恢复仍决定可交互 readiness。
   - session catalog 作为独立投影并发加载，不再成为恢复当前会话前的串行前置。
5. UI 生命周期安全
   - 延迟 focus 必须可取消，并在执行前检查 mounted、renderable 存在且 `isDestroyed !== true`。
   - async confirm 只允许拥有当前 dialog generation 的组件清理/替换自己的 dialog。
   - rename 成功后 replace 回 `DialogSessionList`，通过 `session.updated` 投影立即显示新标题。
6. 完整恢复消息投影
   - catalog 的有界摘要与选中会话的完整 hydration 是两条不同读路径；后者继续读取 Conversation visible history，并完整转换正文、reasoning、tool calls 与 tool results。
   - tool-call request 与后续 result 按 `actor identity + toolCallId` 相关联为一个工具卡片，但 UI message/part identity 由唯一的 committed message identity 派生，不能只用可能跨 compaction 重复的 toolCallId。
   - assistant 的 tool-call-only 记录不得触发空文本卡片兜底；没有可显示 part 的内部记录直接从显示投影省略。
   - `ChatMessage` 当前没有逐消息 provider/model provenance。恢复显示优先取 active Actor binding 的 `providerEpochReceiptV2.targetProviderId/targetModelId`；只有 Conversation authority 确实缺失时才使用 runtime catalog 默认值。legacy v1 receipt 没有 model id，不能伪造精度。
7. Renderer 级事件订阅收敛
   - `useTerminalDimensions()` 每调用一次就向同一个 `CliRenderer` 注册一个 `resize` listener。它适合 surface/list 边界，不适合在每张消息卡片内部调用。
   - `MessageCards` 只建立一次终端尺寸订阅，并把响应式 fallback width 向下传给 `CardFrame` 与 `SummaryToolCard`；卡片 `renderBefore` 取得的实际容器宽度仍具有更高优先级。
   - listener budget 通过渲染超过十张卡片的测试锁定为常数；不得通过 `setMaxListeners()` 放大阈值掩盖扇出。

## 影响范围与修改点（Impact）

- `terminal/packages/tui/src/runtime/client/TuiRuntimeClient.ts`
- `terminal/packages/tui/src/app/tui_a1/data.ts`
- `terminal/packages/tui/src/app/tui_a1/features/message/cards.tsx`
- `terminal/packages/tui/src/app/tui_a1/state/sync-store.ts`
- `terminal/packages/tui/src/app/tui_a1/system/session/session-list-dialog.tsx`
- `terminal/packages/tui/src/app/tui_a1/system/session/session-rename-dialog.tsx`
- `terminal/packages/tui/src/ui/dialog/prompt.tsx`
- `terminal/packages/tui/tests/`

## 决策摘要

- 使用既有 `tui-session.json` 承载 surface-owned 摘要，避免另造数据库或把 UI 摘要塞进 Conversation authority。
- legacy 会话采用“有界首尾预览立即可见、选中后完整回填”；不允许首次列表全量扫描历史，也不允许把截断字节直接当作 XNL 记录。
- 历史工具调用在 projection 层重建实时单卡片语义；历史模型标签以 Conversation Actor provider epoch 为准，不以应用启动时的默认模型为准。
- renderer 级响应状态在消息列表边界共享；单张卡片只消费共享尺寸和自身布局测量，不拥有全局 resize subscription。
- 性能约束以“列表/重命名不得调用 history projection”作为确定性架构断言，墙钟耗时只作辅助，避免测试环境抖动。

## 风险 / 权衡

- 极端情况下单条首/尾消息大于有界窗口，legacy 会话可能暂时没有对应预览 → 保留会话 ID/title/time，定向 hydration 后原子回填；常规旧会话无需先加载即可显示首尾预览。
- 旧格式没有逐消息模型 provenance，只能证明 active Actor 当前 epoch 的 provider/model；显示层使用该 authority 作为会话历史标签，不虚构逐轮切换精度。后续若需要逐消息精确 provenance，应扩展 Conversation message schema，而不是从时间或文本猜测。
- sidecar 与 Conversation 的更新时间可能短暂不同 → Conversation 仍是恢复权威；目录排序使用可用摘要和 session index 的最大已知时间。
- 非阻塞目录加载可能晚于主界面出现 → sync store 通过现有 reactive event/reconcile 更新，不影响当前会话交互。

## 兼容性设计

- 所有新 sidecar 字段可选；旧文件无需迁移即可读取。
- 删除标记与标题原语义不变。
- 注入的 `ConversationProjectionReadPort` 仍负责完整 hydration；只是目录路径不调用 history 方法。

## 迁移计划

- 无批量迁移。会话被加载、重命名、fork、rewind 或完成新 turn 时自然回填摘要。
- 回滚时旧版本会忽略新增 JSON 字段。

## 待解决问题

- 无阻塞性待决事项。
