# 变更：实现 Conversation 原生 Session Fork 与事故会话修复

## 背景和动机 (Context And Why)

当前 TUI 的 session fork 会先读取父会话的可见消息，再把 `messages/parts` 复制进一个新的进程内 `SessionState`。这个复制品能在同一 TUI 进程中显示，因此既有测试会通过；但子 session 的 Conversation History、Prompt、Session lineage 和 provider-context authority 没有被持久化。子 session 第一次真正运行或进程重启后，只能从自己的新消息开始，模型因而丢失父会话上下文。

历史 Conversation Persistence 设计已经把 fork 定义为 history generation/head/lineage 的领域操作，但当时明确延后了完整 runtime surface。后续 TUI 先暴露了 `[分叉会话]`，provider-context tracks 又只完成了既有 session 内 rewind/fork 的 epoch 失效，没有补齐“创建新子 authority”的跨 session fork transaction。本 Track 补完这段被跨阶段遗漏的主链。

## “要做”和“不做” (Goals / Non-Goals)

**目标：**

- 由 Conversation Domain 提供唯一的 session fork capability，TUI/CLI/headless surface 不再复制消息真相。
- 同时支持从当前 canonical head 分叉，以及从指定 committed message 边界分叉。
- 在一个可恢复的 child-authority 初始化事务中写入子 History、Prompt、Session lineage、必要 context assets 与独立 provider epoch。
- 将父 session 的当前 XNL conversation authority 重绑定到子 session；父子随后独立追加，父 session 不被修改。
- 跨 compaction 边界只有在准确 Prompt basis 可证明时才允许分叉；证明不足时 fail closed，且不发布空或部分子 session。
- 提供幂等 repair 能力，把已产生自身后续消息但缺失父 fork base 的事故子 session 修复成合法 lineage。
- 用 fresh-process、真实 provider-request observation、故障注入和事故 session 副本验证行为。

**非目标：**

- 不引入跨 session 的全局共享 generation store 或内容去重协议。
- 不复制父 session 的 in-flight LLM/tool stream、fiber continuation、外部副作用或 provider-native checkpoint。
- 不把 VM snapshot、TUI messages/parts 或旧 transcript 提升为 fork 真相源。
- 不静默猜测跨 compaction fork point，也不把当前 compaction summary 错配给更早的历史点。
- 不在本 Track 改造 branch 浏览/explain UI，也不自动合并父子后续分支。

## 变更内容（What Changes）

- 新增 path-neutral 的 Conversation fork command/result/fork-point proof contract。
- 在 Conversation Capsule 中新增 fork planner/processor，解析 current-head 或 message-level fork point并构造子三域 raw state。
- 扩展本地 Conversation support，使 child fork-init 复用现有 immutable stage、journal、fsync、publish、head-last/CAS 协议，并把 History/Prompt 正文写入当前 `history.xnl` / `prompts.xnl` authority。
- 为跨 session fork 建立独立的 child provider epoch；父 receipt 只作为 lineage/proof，不冒充子 session 的同 session predecessor。
- 按类型迁移 context assets：只复制 Prompt 仍需的稳定事实/资产并重绑定引用；清除 provider admissions、checkpoint、continuation、pending delivery optimization 与 transient runtime state。
- 将 TUI session-list、message-list 和 command-palette fork 入口全部改为调用 domain-owned capability；成功后从持久化 child authority hydrate，失败时留在父 session 并显示 typed error。
- 新增事故 repair/graft 路径：从可证明的父 fork point建立 child base，再把子 session 已提交消息作为后继 tail 原子接入。
- **BREAKING**：无法证明准确 Prompt 状态的跨 compaction message-level fork 将返回明确拒绝，不再静默生成语义错误的子 session。

## 影响范围（Impact）

- 受影响的能力：`ai-semantic-conversation-spine`、`aiagent-persistence-recovery`、`provider-context-epoch`、`runtime-projection-surfaces`、`terminal-tui-shell`。
- 主要代码范围：
  - `cell/packages/ai-organ-contract/src/conversation/` 与 `persistence/conversation/`
  - `cell/packages/ai-organ-logic/src/conversationCapsule/`
  - `cell/packages/ai-support/src/conversation/local/`
  - `terminal/packages/tui/src/runtime/client/TuiRuntimeClient.ts`
  - TUI session/message fork surfaces 与相关 tests
- 迁移对象：由用户明确指定、具有父 session 证据的事故子 session；原现场必须先复制，repair 必须支持 dry-run 与幂等重试。
