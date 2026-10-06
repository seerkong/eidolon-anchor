# Track: fix-tui-live-updates-in-actor-scope

## Why

一个真实会话（`/Users/kongweixian/infra-dev/depa-codument/.eidolon/sessions/20260916195258__01M2NJ5J13HCNR63X950KTPJXS`）在 TUI 里表现为「不再输出、也没有最终回复」，但磁盘证据显示后端一切正常：

- `runtime_conversation_flush` 全部 `saved`，末次 flush 报的 `messageCount` 与 `history.xnl` 实际条数一致（4291 = 4291）
- `runtime_conversation_progress_stranded` 告警 0 次
- fiber 收尾干净：`status=suspended`、`waitingReason=idle_external`、`phase=drain`、`toolOpen=0`
- 用户重开会话加载后，那条「做完工作后的总结性回答」完整可见

即：**消息已持久化，只是 TUI 的实时显示冻结了**。用户已明确指出这可能与 TUI 有关，并在重开会话后确认了这一点；同时提出硬约束：**切换查看不同 actor 是既有功能，改造不得使其回退，且切换后的视图也应享受同一修复**。

### 根因（已在代码中定位）

`terminal/packages/tui/src/app/tui_a1/view.tsx` 的两半构成一个「只有手动刷新才更新」的视图：

**第一半 —— live 事件被无条件丢弃**（`:1201`、`:1210`）：

```ts
if (!info || info.sessionID !== sessionID() || historySource().actor) return
```

`message.updated` / `message.part.updated` 在 `historySource().actor` 为真时直接 return，即 actor 作用域视图主动丢弃全部实时消息事件。

**第二半 —— 没有替代刷新源**。actor 作用域的 durable 读取是有界快照：

```ts
await props.runtime.client.actor!.messages!({ sessionID, ...source.actor, limit: 100 })
```

`perf/history-source-adapter.ts:8` 的注释已承认这一点：

> Actor APIs currently expose a bounded 100-message snapshot, not a durable cursor.

它只在读请求（初始加载、翻页、`jump-to-latest`）时拉取，自身不轮询。live 事件又被第一半丢弃 —— 于是该视图只能靠用户操作触发刷新。

### 关键发现：actor 身份已经在事件里

修复不需要发明新通道。live 事件的类型本身就带 actor 归属：

```ts
export type MessageHistoryEvent = {
  stream: string;
  payload: string;
  startAt?: number;
  endAt?: number;
  agentKey: string;
  agentActorId: string;
};
```

`emitHistoryEvent`（`TerminalRuntime.ts:1318`）原样转发给订阅者，未剥离这两个字段。工具路径已经在用它做键：

```ts
const key = `${event.agentActorId}:${payload.toolCallId}`   // emitToolPartStart / emitToolPartResult
```

而 `ActorRuntimeLaneData.actorId`（actor 切换所用的 id）与 `MessageHistoryEvent.agentActorId` 同为 canonical actor id，二者可对齐。`BaseMessage.agent` 也已经承载 `actorIdentity`。

因此「丢弃事件」从来不是必需的：**正确做法是按 actor 作用域过滤，而不是一律丢弃**。这同时满足「实时」与「切 actor 不串台」。

## Goals / Non-Goals

**目标:**

- actor 作用域视图 SHALL 无需用户操作即收到属于该 actor 的实时消息与工具增量。
- actor 作用域视图 SHALL NOT 串入其他 actor 的输出。
- 切换查看不同 actor SHALL 继续可用；切换后 SHALL 同时获得历史与后续实时增量。
- 修复 SHALL NOT 让 session 级视图（现状正常）行为退化。
- SHALL NOT 新增 conversation 写者，SHALL NOT 触碰单写者边界。

**非目标:**

- 不改后端 actor 读端口的契约（不给 `actor.messages` 加游标/增量端口）——那是后续优化方向，本 track 只在 TUI 层做数据流修正。
- 不改虚拟列表的窗口/测量/滚动语义（`virtualized-incremental-session-history` 的既有条款保持不变）。
- 不改后端 turn 落盘与 seal 语义（已由 track `fix-frozen-session-history` 完成并验证）。
- 不改 `dist/`，不重新构建发布产物（除非用户显式授权）。

## What Changes

- `view.tsx` 的 `message.updated` / `message.part.updated` 分支：把「actor 作用域一律丢弃」改为**按 actor 身份过滤**，使当前作用域的 actor 增量进入 `liveMessageIDs` 与投影。
- 过滤所需身份来自事件自身的 `agentActorId`；工具增量路径已按该字段建键，保持同源。
- 新增测试覆盖三个 actor 作用域行为：实时到达、跨 actor 不串台、切换后仍实时。
- 受影响能力：`terminal-tui-shell`（`virtualized-incremental-session-history` 扩展两个 suite）。

## Impact

- 受影响的行为能力：`terminal-tui-shell`。
- 受影响的代码：
  - `terminal/packages/tui/src/app/tui_a1/view.tsx`（事件过滤与 live 准入）
  - 可能涉及 `terminal/packages/tui/src/runtime/client/TuiRuntimeClient.ts`（若需在事件上补齐 actor 身份，或让 live 路径携带 actor key）
  - 测试：`terminal/packages/tui/tests/`
- 风险点：actor 投影所用的 message id 与 session 投影必须落在同一 id 空间，否则会出现「事件收到了但行没进去」的静默失败。`buildHistorySessionMessage` 用 `actorIdentity` 派生 id，两侧同源，但须用测试锁住。
