## 上下文
现场问题暴露的是 crash consistency 缺口：runtime 内存状态允许存在短暂半步，但快照保存把半步当作恢复真相源。尤其是 tool-call 协议中，assistant message 写入 history 和 durable tool operation 创建之间存在 `yield`。如果在此处保存，恢复后无法确定工具是否应该启动、是否已经启动、是否会重复执行。

## 方案概览
1. 定义 snapshot safepoint
  - 新增运行态检查，输入为 `driver.inspectRuntime()`、VM actors、必要的 actor protocol state。
  - 输出包含 `safe: boolean`、blocking fiber 列表、reason、可选的 progress hint。
  - safepoint 至少要求：没有协议关键 mandatory continuation；assistant tool call 要么已有 matching tool result，要么已有 durable tool operation/inflight proof。
2. 调整保存路径
  - `saveSnapshot()` 不再无条件把当前内存态写成 latest recoverable snapshot。
  - 非 safepoint 时先执行受限 settle/progress，尝试把 mandatory continuation 推进到 durable operation 或 typed wait。
  - 仍非 safepoint 时跳过本次保存并记录诊断，保留上一个 known-good snapshot。
3. 调整 scheduler settled 语义
  - `tickUntilForegroundSettled()` 和需要用于保存前的 all-lane settle 应区分 ordinary idle 与 snapshot-safe settled。
  - `ready + start_tool` 必须继续执行 `agent_step`，不能因为没有 running fiber 就返回 snapshot-safe。
  - queued `fiber_result`、`resume_fiber` 等会影响 scheduling 的 orchestrator mailbox work 必须在 safepoint 判断前 drain 或表示为 durable work。
4. 纳入相关未提交修复
  - OpenAI Responses input-item 的 tool-call/tool-output 配对修复作为 provider 协议兼容项纳入测试。
  - delegate/member/batch 工具变更不属于 safepoint 机制，只在实现中出现直接依赖时处理。

## 影响范围与修改点（Impact）
- `AiAgentRuntimeCoordinator`：在 enqueue 后保存前引入 safepoint save 流程。
- `OrchestratorDriver`：暴露或实现 snapshot-safe settle / mandatory continuation 检测。
- `RuntimeSnapshots`：保存前校验、诊断、必要的 historical bad snapshot 兼容处理。
- `AiAgentExecutor` 附近测试：覆盖 `wait_llm -> start_tool -> wait_tool` 的 crash boundary。
- OpenAI Responses adapter/input-item 测试：保证恢复后 provider 输入不会出现 orphan tool output 或 unmatched tool call。

## 决策摘要
- 详见 `codument/tracks/add-runtime-snapshot-safepoints/decisions.md`
- 当前关键结论：主方案应以保存前 safepoint 校验和 mandatory continuation settling 为核心，而不是恢复时补 wake。

## 风险 / 权衡
- 风险：保存前推进可能增加 turn 结束延迟。
  - 缓解措施：限制推进范围，只消费 mandatory continuation；无法及时推进时跳过保存而不是无限等待。
- 风险：过严 safepoint 规则可能导致快照保存频率下降。
  - 缓解措施：保留 previous known-good snapshot，并输出诊断帮助定位长期非 safepoint。
- 风险：历史坏快照仍需恢复。
  - 缓解措施：保留 recovery diagnostics/repair fixture，但不把历史兼容逻辑作为新快照的主要语义。

## 兼容性设计
- 新规则不应破坏已存在的 suspended typed wait、pending mailbox wake、durable control signal recovery。
- 历史 `ready + start_tool` 坏快照可以由恢复诊断识别，并在受控路径下修复或提示；但新保存路径不得继续产生同类坏快照。
- Snapshot 写入仍保持 bounded payload 约束，不用完整 tool output 或 provider-private fields 证明 safepoint。

## 迁移计划
1. 先用测试复现 `assistant tool call saved before start_tool` 的非 safepoint。
2. 引入 safepoint checker，仅诊断不改变行为。
3. 接入 snapshot save guard，非 safepoint 时受限推进或跳过保存。
4. 调整 settled 语义并补充回归测试。
5. 验证历史坏 session 可以被加载并继续，或至少得到明确诊断。

## 待解决问题
- 是否需要在 `depa-actor` 层增加 mailbox quiescence API，还是在 AI runtime driver 内部完成 mailbox drain 观测。
- 非 safepoint 保存失败时是否需要另建独立 diagnostics/trace 文件给 TUI；不要为此扩展 `AiAgentVm` 契约。

## Attractor 对齐整改
- `RuntimeSnapshots` 只负责 safepoint 判定、结构化返回和 snapshot 持久化，不在 persistence writer 内部主动调度 foreground work。
- 保存前的受限推进属于 runtime coordination / orchestration 边界，由 `AiAgentRuntimeCoordinator` 在调用 snapshot writer 前显式执行。
- `saveAiAgentRuntimeSnapshot` 返回结构化结果：`saved` 表示已写入 latest recoverable snapshot，`skipped_non_safepoint` 表示保留 previous known-good snapshot。
- Snapshot safepoint blocker 通过 `saveAiAgentRuntimeSnapshot` 返回值和 checker 返回值暴露；不新增 `AiAgentVm` / `VmRuntimeContext` 契约字段。
- Safepoint blocker 建模为通用 mandatory continuation，`start_tool` 是当前具体 phase；后续可扩展到其他协议关键 continuation。

## Conversation Safepoint 扩展
- Conversation history、actor transcript、runtime snapshot 都属于同一 crash-consistency 面，不能各自用不同节奏成为恢复真相源。
- LLM/tool stream 可以继续写入内存中的 conversation domain runtime，用于当前 turn 的 prompt assembly、UI 状态和恢复前的工作上下文；但文件系统中的 conversation head 只能在 runtime 到达 safepoint 后由 snapshot save 统一 flush。
- `MessageHistoryEffects.appendMessage` 只负责即时写 actor transcript；conversation `history-generations`、`history.index.json`、`session.index.json` 不在 append 回调里即时落盘。
- `saveAiAgentRuntimeSnapshot` 在 safepoint 判定通过后，将 VM 内存里的 conversation raw state 写入 conversation repository，再写 runtime snapshot manifest。非 safepoint 时保留内存缓冲和 previous known-good 文件状态。
- 恢复时如果 mailbox 已包含相同 durable mailbox payload，则不重复投递 pending durable control signal，避免 `humanInput` 已进入 conversation/memory 后又从 mailbox 再执行一次。
- 后续如果还有其他恢复真相源文件被发现会影响 prompt/runtime replay，也必须纳入同一 safepoint flush，而不是独立即时写入 latest head。

## Mailbox Safepoint 扩展
- Actor wake mailbox 必须纳入 safepoint 分类；其中已经抵达、且对应当前 inflight 或同步等待的 completion 类消息属于 mandatory continuation，不能把当前 runtime 写成 recoverable snapshot 后停止推进。
- 当前需要统一考虑的 wake mailbox 包括 `control`、`toolResult`、`asyncCompletion`、`childDone`、`memberCoordination`、`humanInput`、`memberChatInbox`、`heartbeat`。
- `asyncCompletion` 如果匹配当前 cooperative inflight op，说明异步结果已到达但 `agent_step` 尚未消费，应阻止 safepoint；`childDone.sync_wait` 是同步子任务完成结果，也应阻止 safepoint。
- `humanInput`、`memberChatInbox`、`memberCoordination`、`heartbeat`、普通 `toolResult` 和 control 消息可以作为可恢复 mailbox 输入保存；`control.questionnaire_pending` 是人类等待 marker，本身也不单独阻止 safepoint。
- `RuntimeSnapshots` 内部 safepoint result 可以携带 mailbox kind 供测试和调用方做结构化判断；不扩展 `AiAgentVm` contract 去记录 mailbox 类型或 payload。
- 保存前推进仍由 coordinator 负责；snapshot writer 只判断和跳过，不在 persistence 层调度。

## 原语化预备调整
- 当前 track 不创建 `depa-actor-control` 或 `ai-runtime-control-*` 包，避免过早抽象。
- 为后续双层原语化做小幅整理：将 safepoint 判定、blocker 类型和 AI wake mailbox 分类从 `persistence/RuntimeSnapshots` 移到 runtime 控制面 helper。
- `RuntimeSnapshots` 只消费 safepoint result 并负责 snapshot/conversation durable head 写入；`AiAgentRuntimeCoordinator` 直接依赖 runtime 控制面 helper，而不是从 persistence writer 反向导入判定逻辑。
- 该 helper 是后续迁移到 `cell/packages/ai-runtime-control-contract` / `cell/packages/ai-runtime-control-logic` 的候选边界；其中不含 AI 语义的 operation/barrier/classifier/cohort 机制，后续再反推出 `depa-actor-control`。
