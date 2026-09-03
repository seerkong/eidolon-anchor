# 变更：分页读取并窗口化挂载会话历史

## 背景和动机 (Context And Why)

当前长会话恢复仍然把可见 Conversation History 一次性物化，经 `session.messages()` 灌入 TUI state graph，再由 `MessageCards` 对保留数组执行完整 `<For>` 挂载。现有 100/200/300 条尾部裁剪只控制最终数组上限：它既无法继续访问更早历史，也不是基于 viewport 的虚拟挂载；对于单条内容很长或工具卡片复杂的会话，初次恢复、内存占用和 OpenTUI renderable 数量仍然偏大。

## “要做”和“不做” (Goals / Non-Goals)

**目标：**

- Conversation projection read port 提供稳定、不透明 cursor 的只读分页历史投影，初次只取尾页，上滚才读取上一页。
- 本地文件实现按 XNL 合法记录边界做有界倒序读取，不以“先完整物化、再 slice”伪装分页。
- TUI 维护有界历史页窗口，只挂载 viewport 邻近的消息卡片，并用上下 spacer 保持滚动几何。
- 上滚接近顶部时自动加载上一页，prepend 后保持用户正在看的消息锚点不跳动；实时尾部与 durable 分页结果按稳定 identity 去重。
- fork、rewind、compaction 和 active Actor generation 边界不泄漏不可见记录，旧的完整读取 API 保持兼容。

**非目标：**

- 不改变 provider prompt、Conversation 写入 authority、fork/rewind 语义或历史 XNL 格式。
- 不把 surface 分页状态写回 Conversation domain truth。
- 不要求一次 Track 内构建适用于所有 OpenTUI 列表的通用虚拟列表框架。

## 变更内容（What Changes）

- 扩展 `ConversationProjectionReadPort`：新增 history page query/projection 与 page-info，cursor 对 surface 不透明。
- 在 file-store/support 层增加固定字节窗口的合法 XNL record page reader，以及 Conversation 可见 generation 过滤和消息解码。
- 扩展 local runtime bridge 与 `session.messages()`，支持 `limit + cursor` 的分页结果，同时保留无 cursor 调用的兼容返回形态。
- 新增独立的 history window controller，负责页合并、稳定 identity、viewport 区间、spacer 高度和 prepend anchor 修正。
- 将会话初次恢复改为尾页 hydration；滚轮/PageUp/顶部导航触发上一页加载，MessageCards 只接收窗口切片。
- 增加大历史、超长卡片、compaction/fork/rewind、实时追加、快速切换会话和 listener/renderable budget 回归。

## 影响范围（Impact）

- 受影响能力：`runtime-projection-surfaces`、`terminal-tui-shell`。
- 受影响代码：Conversation projection contract、本地 XNL read adapter、TerminalRuntime bridge、TUI runtime client/state/view/cards/perf helpers 及测试。
- 兼容性：旧调用仍可请求完整历史；新 TUI 恢复路径默认分页。cursor 只在一次 authority generation 快照内有效，generation 改变时客户端丢弃旧页并重新取尾页。
