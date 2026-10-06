# Design: fix-tui-live-updates-in-actor-scope

## 方案概述

把 actor 作用域的事件准入从「一律丢弃」改为「按 actor 身份过滤」。身份来自事件自身已有的 `agentActorId`，不新增通道、不改后端读端口。

```text
message.updated / message.part.updated
        │
        ├─ session 作用域 ──> 现状：全部接纳（不变）
        │
        └─ actor 作用域 ────> 新增：仅当事件属于当前 actor 时接纳
                              （此前为无条件丢弃）
```

## 变更点

### 1. 事件准入：丢弃 → 过滤

当前（`view.tsx:1201`、`:1210`）：

```ts
if (!info || info.sessionID !== sessionID() || historySource().actor) return
```

`historySource().actor` 一旦为真就整条丢弃。改为：只有当事件不属于**当前 actor 作用域**时才丢弃。

需要的身份：
- 当前作用域：`historySource().actor.actorID`（来源 `ActorListTarget`，即 `ActorRuntimeLaneData.actorId`，canonical actor id）
- 事件归属：`event.properties` 上的 actor 身份（`agentActorId`）

### 2. 事件侧身份的可获得性（实现时先验证）

工具增量路径（`emitToolPartStart` / `emitToolPartResult`）已经拿到 `event.agentActorId` 并用于建键。但 `message.updated` / `message.part.updated` 当前发射的 `properties` 只有 `{ info }` / `{ part }`——需要确认这两条路径能把 actor 身份带出来：

- `BaseMessage.agent` 已经承载 agent 身份（`buildHistorySessionMessage` 里 `agent: params.actorIdentity ?? ...`）。
- 若 `info.agent` / `part` 上可直接读到 actor 身份，则过滤纯在 `view.tsx` 完成，不必改 `TuiRuntimeClient`。
- 若读不到（例如 `agent` 存的是显示名而非 canonical id），则在 `TuiRuntimeClient` 发射处补一个明确的 actor 字段，而不是复用语义模糊的 `agent`。

**这条必须在写实现前用代码事实确认**，不能假设。

### 3. id 空间对齐（决定成败的静默失败点）

actor 视图的行来自 `actor.messages({limit:100})` 经 `buildHistorySessionMessage({ actorIdentity })` 投影；session 侧的 live 行同样经 `buildHistorySessionMessage`。两侧 id 都由 `domainMessageID || history:${actorIdentity}:${messageIndex}:${role}` 派生。

若两侧 `actorIdentity` 取值不同（一边 canonical actorId、一边 actorKey），同一逻辑消息会得到两个 id，表现为「事件已接纳、行却不更新」的静默失败。**必须有测试锁住两侧 id 一致**。

## 测试策略

覆盖三条行为（对应 behavior delta 的三个 case）：

1. **实时到达**：actor 作用域视图下，该 actor 的新消息无需用户操作即出现。
2. **不串台**：actor A 视图下，actor B 的消息不出现；A 自己的增量继续进入。
3. **切换仍可用且实时**：切换 actor 后历史正确加载，且后续增量继续进入。

外加一条回归：session 级视图行为不变。

现有测试面：`terminal/packages/tui/tests/`（含 `session-abort-runtime.test.ts`、`session-interrupt-keybind.test.tsx`、`tui-stream-diagnostics.test.tsx` 等）。优先复用既有的 surface/SDK 假件风格。

## 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| actor 身份在事件上不可得 | 可能需改 `TuiRuntimeClient` 发射处 | 实现前先用代码事实确认（见 §2）；若需补字段，补语义明确的字段而非复用 `agent` |
| id 空间不一致导致静默失败 | 事件接纳了但行不更新 | 专门测试断言两侧 id 同源（见 §3） |
| 让 session 视图退化 | 过滤条件写错会误伤现状正常的 session 作用域 | `historySource().actor` 为空时保持无条件接纳（既有行为）；加回归测试 |
| 切换 actor 功能回退 | 过滤会把切换后视图的事件也挡掉 | 过滤按「当前作用域」求值而非启动时快照；第三条测试覆盖 |

## 兼容与迁移

- 纯 TUI 层数据流修正：不改后端契约、不改持久化格式、不改虚拟列表窗口语义。
- 无数据迁移。
- session 级视图（`historySource().actor` 为空）保持既有无条件接纳语义。
