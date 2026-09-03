# 变更：修复会话目录延迟与弹窗生命周期竞态

## 背景和动机 (Context And Why)

长会话的会话目录读取和标题重命名错误地复用了“完整恢复会话历史”的重路径。现场会话的 `conversation/history.xnl` 已达约 56 MB，导致一次标题重命名约 17 秒、应用启动时会话列表约 19–46 秒才返回。长异步窗口又放大了弹窗重挂载竞态：已经销毁的 OpenTUI input/textarea 仍被延迟 `focus()`，最终抛出 `EditBuffer is destroyed`。

## “要做”和“不做” (Goals / Non-Goals)

**目标：**

- 会话列表只消费轻量、可持久化的会话摘要，不加载完整 Conversation History。
- 缺少摘要的旧会话在首次列举时仍显示第一条和最近一条消息；兼容读取只能读取 `history.xnl` 的有界首尾窗口并解析完整 XNL 记录。
- 重命名只更新标题元数据和内存投影，完成后立即回到会话列表展示新标题。
- 恢复当前会话时，会话目录加载不得阻塞当前会话的定向 hydration。
- 弹窗被 replace/clear/unmount 后，任何延迟焦点和异步提交回调不得访问已销毁 EditBuffer。
- 用户选中会话后，完整恢复投影必须重建正文、reasoning 与工具调用卡片；不得把 tool-call-only 记录渲染为空 ASSISTANT，也不得因 compaction 中重复的 toolCallId 丢失 tool result parts。
- 历史消息显示的 provider/model 必须来自 Conversation active Actor 的 provider epoch authority；不得使用当前全局默认模型伪造历史身份。
- 长历史消息卡片不得按卡片实例各自订阅 renderer 级 resize 事件；监听器数量必须与历史消息数量解耦。
- 通过大历史替身、事件投影和弹窗销毁竞态测试锁定性能与生命周期行为。

**非目标：**

- 不改变 Conversation History 的权威格式、fork/rewind 语义或 provider 协议。
- 不以删除会话预览能力换取性能；旧会话缺失摘要时允许先显示基础信息，并在定向 hydration 后回填摘要。
- 不在本 Track 构建全局数据库或新的通用缓存框架。

## 变更内容（What Changes）

- 扩展 `tui-session.json` 为轻量 Session Summary sidecar，保存标题、删除标记、时间与有限长度预览。
- 拆分 persisted session summary 与完整 history hydration；`session.list`、`session.update` 不再调用 `loadHistoryProjection`。
- 当前会话在已完成 hydration、turn、rewind/fork 等稳定边界刷新摘要，旧 sidecar 保持兼容。
- 调整 TUI bootstrap，使当前会话恢复与会话目录读取互不串行阻塞。
- 让完整 history hydration 合并 tool-call request/result，并把 active Actor 的 provider/model authority 传入历史消息显示投影。
- 在消息列表边界共享一次 terminal dimensions 订阅，向普通消息与摘要工具卡片传递 fallback 宽度，同时保留卡片容器实测宽度优先级。
- 重命名成功后恢复会话列表视图；为 input/textarea 的延迟焦点和异步完成增加销毁/代际保护。

## 影响范围（Impact）

- 受影响的能力：`runtime-projection-surfaces`、`terminal-tui-shell`。
- 受影响的代码：TUI runtime client、sync bootstrap、session list/rename dialogs、通用 prompt dialog 及其测试。
- 持久化兼容：现有 `tui-session.json` 字段继续可读；新增字段均为可选派生摘要，不成为 Conversation 恢复权威。
