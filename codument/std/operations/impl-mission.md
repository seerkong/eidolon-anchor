# skill: codument-impl-mission（执行长周期 mission）

按 `mission.xml` 的 desired DAG 执行 mission，并通过 `MissionPlanner` / `MissionObserver` / `MissionReconciler` / `MissionApplier` 四个控制论 + DEPA actor 做反馈收敛。

> mission 执行不是一次性按 DAG 跑完。它是 level-triggered 的控制循环：每轮读取当前 actual state，比较 desired state，只执行一个 bounded convergence action。格式规范见 `codument/std/spec/mission-xml-spec.md`；flow notation 见 `codument/std/spec/flow-notation.md`。

## 0. 前置

- mission 必须位于 `codument/missions/pending/<id>/` 或 `codument/missions/active/<id>/`。
- `mission.xml` 是状态真源。
- `analysis/` 和 `reports/` 是执行期外部记忆，默认不进 git。
- 不依赖 chat history 作为状态。

## 1. Actor 边界

| Actor | 输入 | 输出 | 禁止 |
|---|---|---|---|
| `MissionObserver` | mission id | actual state projection | 不修改文件 |
| `MissionReconciler` | desired state + actual state | next action / drift / blocked / done | 不直接写文件 |
| `MissionPlanner` | drift / user decision / evidence | revised desired graph proposal | 不执行 track |
| `MissionApplier` | approved bounded action | file changes / track action / report | 不做无限自动化 |

## 2. 主循环

```text
@delimiter: --
@node: #
@marker: ?
-- #loop ?mission until="mission completed/cancelled/superseded or blocked"
---- #step ?load
定位 mission：优先读取 active/<id>/；若只存在 pending/<id>/，本轮唯一允许的 bounded action 是 start-mission（见 §3），不得执行任何 ready node。
---- /?load
---- #if ?pending_start cond="mission 位于 pending/<id>/"
------ #call ?start target="start-mission(pending/<id>)"
------ /?start
------ #exit ?reload_active
启动完成后停手或从 active/<id>/ 重新加载；不要沿用 pending 路径缓存继续执行 DAG。
------ /?reload_active
---- /?pending_start
---- #step ?observe
MissionObserver 读取 actual state：mission.xml 当前状态、`cdt:TrackLink` 绑定的真实 tracks、archive、测试结果、用户新约束、reports。
---- /?observe
---- #step ?reconcile
MissionReconciler 比较 desired vs actual，判定：ready-node / drift / blocked / completed。
---- /?reconcile
---- #switch ?decision on="reconcile result"
------ #case ?ready when="存在 ready mission node"
-------- #step ?apply_ready
MissionApplier 执行一个 bounded action：分析一个 plan 节点、创建一个 track、续跑一个 track、归档一个 track，或写一个报告。
-------- /?apply_ready
-------- #exit ?wait_after_action
动作完成后停手或进入下一轮；不要无界连续执行多个 track。
-------- /?wait_after_action
------ /?ready
------ #case ?drift when="actual state 使当前 DAG/节点不再成立"
-------- #step ?plan_revision
MissionPlanner 基于 evidence 或 human decision 产出重规划建议。
-------- /?plan_revision
-------- #step ?apply_replan
MissionApplier 写 reports/replan-XXX.md，更新 mission.xml，递增 Revision。
-------- /?apply_replan
-------- #exit ?wait_replan
重规划后停手，等待下一轮观察。
-------- /?wait_replan
------ /?drift
------ #case ?blocked when="缺少 evidence、用户决策、外部状态或 track 失败"
-------- #return ?blocked_out value="报告阻塞和所需输入"
-------- /?blocked_out
------ /?blocked
------ #case ?done when="全部节点 DONE 或 SUPERSEDED，成功判据满足"
-------- #return ?complete value="更新 mission.xml Status=completed；提示可 archive-mission"
-------- /?complete
------ /?done
---- /?decision
-- /?mission
```

## 3. 启动 pending mission

当 mission 位于 `pending/<id>/`：

`start-mission` 是一个门禁动作，不是普通 ready node。完成前不得执行 mission DAG 中的任何节点。

1. 读取 `proposal.md`、`design.md` 和 `mission.xml`。
2. 确认用户要启动；如果用户未明确启动，返回 blocked。
3. 检查 `active/<id>/` 不存在；若已存在，返回 blocked，要求人工处理，禁止覆盖。
4. 移动目录到 `active/<id>/`。
5. 更新 `active/<id>/mission.xml`：
   - `Metadata.Status=active`
   - `Metadata.UpdatedAt=<now>`
6. 写 `reports/mission-run-001.md` 记录启动路径、启动时间和用户确认。
7. 启动动作完成后停手，或从 `active/<id>/` 重新加载再进入下一轮观察；禁止继续使用旧的 `pending/<id>/` 路径引用。

## 4. ready node 处理

ready node 来自 `mission.xml` 顶层 `TaskGroup` DAG：所有 `<After>` 前驱已 DONE / SUPERSEDED，且节点自身未完成。进入某个 ready `TaskGroup` 后，按其内部叶子 `Task` 的 `order` 顺序执行第一个未完成 Task；除非未来显式扩展 nested DAG，否则组内 Task 不并行、不写进顶层 DAG。

常见节点类型：

- 普通 leaf `Task`：做证据盘点 / 设计收敛 / track 切片；产物写 `analysis/`，稳定结论写 `design.md` 或 decisions。
- 带 `cdt:TrackLink` 的 leaf `Task`：创建、续跑、验证或归档一个 codument track；真实实现交 `codument-plan-track` / `codument-impl-track` / `codument-archive-track`。
- 验证 leaf `Task`：独立验证 mission 成功判据。

### 4.1 TrackLink 绑定写回

`cdt:TrackLink` 只挂在叶子 `Task` 上：

```xml
<Task id="G3-T1" name="创建并执行 runtime contracts track" status="NOT_STARTED" order="0">
  <cdt:TrackLink state="candidate" id="add-runtime-contracts"/>
</Task>
```

当 `MissionApplier` 创建真实 track 后，必须立即更新 `mission.xml`：

1. 将同一个 `cdt:TrackLink` 的 `state` 从 `candidate` 改为 `bound`。
2. 将 `id` 写成真实 track id；如果真实 id 与 candidate id 不同，用真实 id 覆盖。
3. 不写 `path`、`archive-path` 或 track 状态；active/archive 位置后续通过 id 解析。
4. 更新该 leaf `Task.status`，并更新 `Metadata.Revision` / `UpdatedAt`。
5. 写 `reports/track-bind-XXX.md`，至少包含 mission task id、candidate id、real track id、创建证据和时间。

如果 `cdt:TrackLink state="candidate"` 指向的 track 已经存在，也按同样规则绑定为 `bound` 并写 report；不得重复创建 track。

## 5. 受控重规划

允许变更：

- 增加 mission 节点。
- 删除 / supersede mission 节点。
- 修改节点描述、验收、状态。
- 修改 DAG 依赖。
- 改变某 `cdt:TrackLink state="candidate"` 的边界、id 或顺序。

硬要求：

- 必须有 evidence 或 human decision。
- 必须写 `reports/replan-XXX.md` 或 `reports/human-intervention-XXX.md`。
- 必须递增 `Metadata.Revision`。
- 必须更新 `Metadata.UpdatedAt`。

## 6. reports 模板

```markdown
# Mission Replan Report

## Trigger

## Desired State

## Actual State

## Diff

## Decision

## Applied Change

## Next Observation
```

## 7. 完成

当所有必要节点 DONE 或 SUPERSEDED，且 proposal 的成功判据满足：

- 更新 `mission.xml` status 为 `completed`。
- 写 `reports/mission-complete.md`。
- 提示用户使用 `codument-archive-mission` 归档。
