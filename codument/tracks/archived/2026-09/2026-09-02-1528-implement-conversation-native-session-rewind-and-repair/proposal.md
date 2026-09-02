# 变更：实现 Conversation 原生 Session Rewind 与事故修复

## 背景和动机

当前 TUI 的 `session.revert` 只截断进程内 `state.messages` 与 `state.parts`，随后用户继续输入时，Terminal runtime 仍从持久化 Conversation History/Prompt/Session authority 构造 provider request。因此界面已经回退，模型却仍能看到目标消息之后的内容。`session.unrevert` 同样只清除一个 surface 标记，并不是领域状态恢复。

原生 session fork 已建立 canonical message selector、Prompt 可证明性、tool-pair 边界、Conversation authority lease、XNL transaction 与 provider epoch 重建。本 Track 在同一架构上补齐 same-session rewind，而不是由 TUI 复制或删改消息。

## 目标

- 由 Conversation Domain 提供唯一的 same-session rewind capability；TUI、CLI/headless surface 不直接修改消息数组或持久化文件。
- 只接受可唯一映射的 committed message 边界；缺失、歧义、开放 tool pair、跨 compaction 且 Prompt 不可证明时 fail closed。
- 原子创建 `createdReason="rollback"` 的 History generation、对应 Prompt generation、History/Prompt/Session heads 与 `history_rewind_or_fork` provider epoch successor。
- 清除旧 admissions、provider context fact head、replay checkpoint、continuation 等不再适用于新 frontier 的优化状态。
- 成功后将运行中 VM 从持久化 authority 同步，再由 TUI hydrate；fresh restart 与同进程下一轮必须看到相同上下文。
- 移除当前伪 `unrevert` 成功语义：在尚未设计分支恢复协议前明确返回 unsupported，不能只清除 surface 标记并谎报恢复成功。
- 用真实事故形态的回归 fixture 证明目标后的消息不进入下一次 provider request，并为既有 surface-only revert 状态提供安全诊断/修复路径。

## 非目标

- 不实现任意历史分支浏览、merge 或跨 compaction 的猜测式 time travel。
- 不在本 Track 实现 redo；这需要独立的分支恢复、stale authority 与副作用语义。
- 不把 TUI rendered messages、parts、旧 transcript 或 VM snapshot提升为 authority。
- 不保留 rewind 后发生在废弃分支上的 provider continuation、tool execution 或缓存命中身份。
- 不在本 Track 修改并行进行中的 workflow context fact 命名和投影语义。

## 影响范围

- `ai-semantic-conversation-spine`
- `provider-context-epoch`
- `aiagent-persistence-recovery`
- `runtime-projection-surfaces`
- `terminal-tui-shell`

主要代码范围是 Conversation contract/logic、local persistence transaction、Terminal runtime bridge、TUI runtime client 及相应 tests。

## 兼容性

这是对 local-runtime 回退语义的故障修复。mock TUI 可继续使用内存模拟，但 production/local-runtime 必须走 domain capability。无法证明的旧回退点会显示 typed rejection，且不修改会话。
