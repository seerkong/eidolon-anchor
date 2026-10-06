# Track: fix-frozen-session-history

## Why

一个真实会话（`/Users/kongweixian/infra-dev/depa-codument/.eidolon/sessions/20260916195258__01M2NJ5J13HCNR63X950KTPJXS`）出现三重症状，用户描述为「运行一段时间后停下来不动；我 cancel 后，再发继续，TUI 里看不到我新发的消息，也看不到 AI 的新对话」。

排查结论：**不是 TUI 虚拟列表**，而是两层真实缺陷叠加。

**第一层（诱因）：bash 权限解析器把合法命令判死。**

会话中 agent 反复发出同一条命令（`effects.xnl` 中出现 5 次）：

```bash
cd /tmp/depa-codument-f76ab893 && rm -rf extract && mkdir -p extract/logic extract/support extract/contract \
  && D=/Users/.../host-release-round-44-contract-011-final \
  && tar -xzf "$D/69f561bc….tgz" -C extract/logic && ...
```

权限求值直接失败，5 次都产出同一个错误：

```
Error: Bash segment does not contain an executable command
```

根因在 `LocalPermissionEvaluator.ts:906-952`：`collectBashCommandWords` 会跳过段首的纯赋值 token，跳完若为空就抛。而 `D=/path` 作为 `&&` 链里的独立段在 POSIX shell 中是**合法**的（纯赋值命令，退出码 0）。真机复现：

```
THROW Bash segment does not contain an executable command <= A=1 && echo hi
THROW Bash segment does not contain an executable command <= cd /tmp/x && D=/tmp/y && tar -xzf "$D/a.tgz"
```

这是一个 false negative：模型写的命令是对的，运行时说它不可执行。后果是工具失败 → 模型换写法重试 → 再失败，20:40 之后 5 分钟内 34 次 provider attempt、36 次 tool_call，每轮约 8 秒空转。该会话该轮共 16 次 bash 失败（含 `Dangerous command blocked`、超时等），turn 始终到不了 safepoint。

**第二层（主因）：turn 结束时已完成进度被搁置在内存里。**

```
runtime_conversation_flush          n=32   last 20:28:44
runtime_conversation_history_buffered  n=573  其中末次 flush 之后 159 条（20:28:59 → 20:44:57）
runtime_checkpoint_save_skipped     n=1    20:28:52  status=skipped_non_safepoint
```

对照：runtime 自报 `messageCount = 4362`，持久化 `history.xnl` 只有 4203 条 —— **159 条只在内存**。`runtime_state/fibers/main%3Aactor-….json` 为 `status=suspended` / `waitingReason=idle_external`；`orchestration_history.xnl` 末条（20:28:52）记 `pendingMailboxes = ["humanInput"]`、`waitingReason = wait_llm_result`、inflight `llm:main:…:338`，hook 结果 `runtime hook dispatch stopped because lifecycle state is no longer current`。

也就是说：用户的「继续」进了 humanInput mailbox，fiber 一直没回到 safepoint，`flush` 不再执行（它只在 safepoint 安全时触发），checkpoint 被 `skipped_non_safepoint` 跳过。TUI 的 durable 页读的正是 `history.xnl` + `history.index.json`（那份冻结在 20:41:58），live 一路靠 `message.updated` 事件补（turn 没提交就没有新事件）。**两侧都无内容可渲染，症状完全吻合。**

`.conversation-authority-locks/` 为空，锁不是原因。

**已排除：TUI 虚拟列表。** `terminal/packages/tui/src/app/tui_a1/perf/` 四个模块逐个检查：

| 模块 | 职责 | 是否吞行 |
|---|---|---|
| `history-source-adapter.ts` `pageHistorySnapshot` | 按 cursor 切片 + `historyOrder` 重排 | 否，只做窗口/排序 |
| `mergeHistoryMessages` | 按 `sourceMessageID` 分组覆盖 | 否，是合并 |
| `createHistoryRowAdapter` | `orders` LRU 512、canonical/page/live 三档权威 | 否，未见过的新 id 走 `!entry` 分支按 live 补位 |
| `history-row-estimate.ts` | 只算行高 | 否 |

`liveMessageIDs` 上限 200、`orders` 上限 512 只是挤出最旧一条，不会藏住刚发的一条。

## Goals / Non-Goals

**目标:**

- bash 段解析 SHALL 承认「纯环境变量赋值段」为合法段，SHALL NOT 以「不含可执行命令」拒绝整条命令。
- 解析失败 SHALL 保持既有 unsupported-syntax 风险分类路径；解析器内部不变量违规 SHALL NOT 被当作权限结论外泄。
- turn 结束时，已完成但未落盘的 conversation 进度 SHALL NOT 被搁置；SHALL NOT 依赖「只有 safepoint 安全才 flush」作为唯一出口。
- in-flight / 未完成消息 SHALL NOT 被 flush 成完成态；既有 `timed-out-turn-progress-persisted` 语义（不快照不安全工具执行中状态）SHALL 保持不变。
- 「未落盘进度被搁置」SHALL 可观测（非致命告警：会话标识 + 消息数差额 + 结局），不新增第二写者。
- 用户已送达并被 runtime 接纳的输入，SHALL 在后续恢复/续做时出现在 model-visible history。

**非目标:**

- 不改 TUI 虚拟列表（已排除）。
- 不调整任何超时阈值（1000ms 量子、`--timeout`、120s first-event 均不在本 track 范围）。
- 不修 settle 契约本身——那是并行 track `harden-turn-settle-budget-contract` 的范围，本 track 只消费其结果。
- 不追查 provider 侧 TTFT hang（`first event exceeded timeout after 120s`），另一条线。
- 不新增第二个/兜底 conversation 写者（单写者不变）。
- 不改 `dist/`，不重新构建发布产物。

## What Changes

- `cell/packages/ai-organ-logic/src/permissions/LocalPermissionEvaluator.ts`：段归一化把「纯赋值段」判为合法（无副作用），而不是抛 `does not contain an executable command`；`bashSegmentIsWorkspaceSafe` 等既有守卫语义不变。
- 该文件对应测试面新增覆盖：`A=1 && cmd` 形状、`D=/p` 后被引用、整条仅赋值、受保护配置路径仍被拒绝。
- conversation 单写者/turn 结束路径：让已完成进度在 turn 结束时（含非 safepoint 结局）获得 flush 出口，或将「有在途提交者」显式化；in-flight 不快照。
- 搁置可观测：新增非致命结构化告警（会话标识、缓冲数、持久化数、结局）。
- 受影响的行为能力：`bash-permission-approval`（新增两个 requirement）、`aiagent-persistence-recovery`（新增两个 requirement）。

## Impact

- 受影响的能力（behaviors）：`bash-permission-approval`、`aiagent-persistence-recovery`。`runtime-session-robustness#timed-out-turn-progress-persisted` 语义保持，仅其出口覆盖面变宽。
- 受影响的代码（按 P 顺序）：
  - P1：`cell/packages/ai-organ-logic/src/permissions/LocalPermissionEvaluator.ts` + `tests/AIAgent/local_permission_*.test.ts`
  - P2：conversation 单写者 flush 出口与 turn 结束路径（具体文件在 P2 开工时依并行 track 的已落地基线确定）
  - P3：测试迁移与全量回归
- 并行协调：另一会话正在改 `driverRuntime.ts` / `AiAgentRuntimeCoordinator.ts`（settle 契约）。P1 与之零重叠，可立即落地；P2 开工前须重新核对基线（见 `decisions.xnl` 的 `parallel_settle_coordination`）。
