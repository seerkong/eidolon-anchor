# skill: codument-impl-mission（执行长周期 mission）

按 `mission.xnl` 的 desired DAG 执行 mission，并通过 `MissionPlanner` / `MissionObserver` / `MissionReconciler` / `MissionApplier` 四个控制论 + DEPA actor 做反馈收敛。

> mission 执行是持续的 level-triggered 控制循环：先读取 current actual state 并选择下一步；每个操作在自身范围内验证完成，验证通过且未发现计划失效信号时直接推进，只有不确定或偏差时才观察受影响范围并协调。格式规范见 `codument/std/spec/mission-xnl-spec.md`；flow notation 见 `codument/std/spec/flow-notation.md`。

## 0. 前置

- mission 必须位于 `codument/missions/pending/<id>/` 或 `codument/missions/active/<id>/`。
- `mission.xnl` 是状态真源。
- `analysis/` 和 `reports/` 是执行期外部记忆，默认不进 git。
- 不依赖 chat history 作为状态。

## 1. ActorSet 与 session runtime

标准四 actor 协议、ActorSet 继承和 canonical examples 只由 `std/spec/mission-xnl-spec.md` 定义。本 operation 根据当前 TaskGroup 选择最近的完整 ActorSet，并执行其中 `<Description>` 所声明的本 mission 工作方式；不在这里复制角色定义。

执行 session 以临时 `WorkspaceBinding` 提供 `ProjectRef -> workspace root` 映射。它不是配置、XML 节点或 report 内容，绝不写入 mission、track、report、decision 或任何可提交文件：

- 没有 external ProjectRef binding 时，Observer 报告 `UNBOUND`。这只是本次观察结果，不是持久 status。
- binding 存在但目标项目找不到 TrackLink 指向的 `track.xnl` 时，报告 `MISSING`，并以目标项目自己的 `track.xnl` 作为实际态真源。
- Reconciler 只阻断直接依赖该 ProjectRef 的 operation；其他 ready DAG branch 仍可执行。

## 2. 主循环

### 2.1 连续执行边界

调用 `codument-impl-mission <id>` 就是开始实现 mission，不存在仅启动后返回的模式。若 mission 位于 `pending/`，启动后必须重新读取 `active/<id>/mission.xnl` 并继续执行。

主循环只可在以下情况返回：

- decision-tree 的 ready frontier 有**显式确认 gate**：`HumanConfirm`、或显式配置更高 `QuestionSeverity` 且该决策无保守默认可替代。规划期问答预算（`light`/`normal`/`deep`）不构成执行期停点（见 `codument/std/protocols/questioning.md`）。
- 遇到真实 `BLOCKED`：缺少用户决策、外部输入、失败 track 或无法自动修复的结构偏差。
- mission 满足 completed gate，或状态为 `cancelled` / `superseded`。
- 当前 invocation 已完成 10 个 linked track 生命周期，写入可续跑 checkpoint。

`QuestionSeverity=auto` 必须把保守假设写入 `decisions.xnl` 或报告后继续，不得为了确认而暂停。十条 track checkpoint 只结束本次 invocation；mission 仍保持 `active`，下一次 `codument-impl-mission` 从 `mission.xnl` 续跑。

每个 logical mission operation 必须有与影响相称的完成判定，但不需要生成统一回执文件、XNL 节点或任何专用数据格式：代码改动运行相关测试或静态检查；linked track 检查叶子状态与验收证据；外部操作重新读取受影响资源；分析操作确认约定证据已写入。完成判定通过且无前提、依赖、范围或目标的失效信号时，直接继续下一个 planned ready operation；判定不确定、失败或发现失效信号时，才观察受影响范围并进入 reconcile。仅在范围无法界定时才做全量观察。

子流程的返回边界不得冒充 mission 主循环返回边界：`codument-impl-track`、`codument-archive-track`、`codument-verify`、`codument-gap-loop` 或 fresh 子代理返回时，只是把局部结果交还给 `MissionApplier`。若当前操作是在 mission 中处理某个子 track，子 track 的收口只约束该子流程；mission 父层读取结果、通过 CLI 更新状态、执行当前 operation 完成判定，然后继续 mission 主循环，除非命中本节列出的返回条件。

**候选 track 激活（candidate activation）**：当 ready operation 是 candidate TrackLink 时，plan-track 产出的 Track 属于 mission 执行期产物。MissionApplier 运行 `codument track transition <track-id> in_progress` 与 `codument mission bind-track <mission-id> <task-id> <track-id>`，由 CLI 移动 authority、验证真实 Track、更新 TrackLink/leaf/revision 并写 bind report。命令成功后继续下一个 planned ready operation；显式确认 gate 仍可在激活点暂停。

```text
@delimiter: --
@node: #
@marker: ?
-- #loop ?mission until="mission completed/cancelled/superseded or blocked"
---- #step ?load
定位 mission：优先读取 active/<id>/；若只存在 pending/<id>/，执行 start-mission（见 §3）后立即重新读取 active/<id>/。
---- /?load
---- #if ?pending_start cond="mission 位于 pending/<id>/"
------ #call ?start target="start-mission(pending/<id>)"
------ /?start
------ #step ?reload_active
从 active/<id>/ 重新加载 mission.xnl；不要沿用 pending 路径缓存继续执行 DAG。
------ /?reload_active
---- /?pending_start
---- #if ?track_budget cond="本 invocation 已完成 10 个 linked track 生命周期"
------ #return ?checkpoint value="写 continuation checkpoint；mission 保持 active，下一次 impl-mission 从当前 mission.xnl 续跑"
------ /?checkpoint
---- /?track_budget
---- #step ?observe
MissionObserver 读取 actual state：mission.xnl 当前状态、根据 session WorkspaceBinding 和 `TrackLink { project_ref = "..." }` 定位真实 tracks、archive、测试结果、用户新约束、reports。对未绑定外部项目投影 UNBOUND；不得把 workspace path 写回文件。
---- /?observe
---- #step ?reconcile
MissionReconciler 比较 desired vs actual，并读取根 `decisions.xnl` 与递归 `decisions/**/*.xnl` 组成的 pending decision frontier，判定：question / ready-node / drift / blocked / completed。
---- /?reconcile
---- #switch ?decision on="reconcile result"
------ #case ?question when="存在显式确认 gate 的 ready pending decision（HumanConfirm，或显式更高 severity 且无保守默认可替代）"
-------- #return ?question_out value="按 decision-tree 的当前 ready batch 提出问题，并保留 mission active"
-------- /?question_out
------ /?question
------ #case ?ready when="存在 ready mission node"
-------- #step ?apply_ready
MissionApplier 执行当前 ready leaf 作为一个 logical operation：分析一个 plan 节点、创建/续跑/验证/归档一个 track，或写一个报告。若该 operation 含 `TrackLink { state = "candidate" }`，plan-track 返回后使用 CLI receipt 的真实 track 目录，运行 `codument mission bind-track`；需要 lifecycle transition 时运行 `codument track transition`。ready leaf 是推进粒度，不是 invocation 返回边界；linked track 只有在生命周期完成且对应 mission leaf 写为 DONE 时才计入本 invocation 的 track 数。
-------- /?apply_ready
-------- #step ?verify_operation
按当前 operation 的影响范围执行完成判定；不生成独立回执格式。验证通过且未发现计划失效信号时，基于已更新的 DAG 状态直接选择下一个 planned ready operation 并继续；不得把启动、单个节点或单条 track 完成当作默认停止点。验证不确定、失败或发现失效信号时，只观察受影响范围后再 reconcile；范围无法界定时才全量观察。
-------- /?verify_operation
-------- #continue ?next_ready
验证通过且没有失效信号时，立即回到本 mission loop 选择下一个 planned ready operation；子流程 return 不得结束本 invocation。
-------- /?next_ready
------ /?ready
------ #case ?drift when="actual state 使当前 DAG/节点不再成立"
-------- #step ?plan_revision
MissionPlanner 基于 evidence 或 human decision 产出重规划建议。
-------- /?plan_revision
-------- #step ?apply_replan
MissionApplier 写 reports/replan-XXX.md 并更新 TaskSpace/Schedule 的语义结构；根与 task 状态通过 `codument mission transition` / `codument mission task transition` 写回，CLI 负责 revision 与时间。
-------- /?apply_replan
-------- #step ?verify_replan
验证修订后的 mission graph、Revision 与重规划证据。若验证明确且没有新的失效信号，直接继续修订后 ready 的分支；只有不确定或发现偏差时才观察受影响范围并 reconcile。
-------- /?verify_replan
-------- #continue ?next_after_replan
重规划验证通过且没有失效信号时，立即回到本 mission loop 选择修订后的 planned ready operation；不得把重规划完成当作本 invocation 收口。
-------- /?next_after_replan
------ /?drift
------ #case ?blocked when="缺少 evidence、用户决策、外部状态或 track 失败"
-------- #return ?blocked_out value="报告阻塞和所需输入"
-------- /?blocked_out
------ /?blocked
------ #case ?done when="全部节点 DONE 或 SUPERSEDED，成功判据满足"
-------- #return ?complete value="运行 codument mission transition <id> completed；提示可 archive-mission"
-------- /?complete
------ /?done
---- /?decision
-- /?mission
```

## 3. 启动 pending mission

当 mission 位于 `pending/<id>/`：

`start-mission` 是进入 continuous execution 的前置迁移，不是可单独收口的模式。完成前不得执行 mission DAG 中的任何节点；完成后必须从 active 路径重新加载并继续主循环。

1. 读取 `proposal.md`、`design.md` 和 `mission.xnl`。
2. 本次入口是 `codument-impl-mission <id>` 或用户要求实现/续跑时，视为已授权启动；用户明确要求只检查时保持 pending。
3. 运行 `codument mission transition <id> active`。CLI 验证 lifecycle、目标目录、revision 与更新时间并原子移动 authority。
4. 从命令返回的 active 路径重新加载，然后继续主循环；启动本身不结束 invocation。

## 4. ready node 处理

ready node 来自 `mission.xnl` 顶层 `TaskGroup` DAG：所有 `<After>` 前驱已 DONE / SUPERSEDED，且节点自身未完成。进入某个 ready `TaskGroup` 后，按其内部叶子 `Task` 的 `order` 顺序执行第一个未完成 Task；除非未来显式扩展 nested DAG，否则组内 Task 不并行、不写进顶层 DAG。这个“第一个未完成 Task”只是当前 logical operation 的选择规则，不是执行后向用户返回的规则。

常见节点类型：

- 普通 leaf `Task`：做证据盘点 / 设计收敛 / track 切片；产物写 `analysis/`，稳定结论写 `design.md` 或 decisions。
- 带 `TrackLink` 的 leaf `Task`：创建、续跑、验证或归档一个 codument track；真实实现交 `codument-plan-track` / `codument-impl-track` / `codument-archive-track`。
- 验证 leaf `Task`：独立验证 mission 成功判据。

### 4.1 操作完成判定

MissionApplier 的每个 logical operation 都必须在操作内完成与影响相称的验证。完成判定可直接使用该任务已有的验收条件、相关测试、真实 track 状态、外部资源读取或约定的分析证据；不得为此新增统一回执文件或专用序列化格式。

- 判定通过且没有前提、依赖、范围或目标的失效信号：更新普通实际态与证据后，直接继续下一个 planned ready operation。
- 判定不确定或失败，或发现失效信号：先由 Observer 只读取受影响的文件、track、测试、资源或报告，再由 Reconciler 判断是否需要重规划、阻塞或继续。
- 仅在影响范围不能可靠界定时，才重新做全量 actual-state observation。

任务开始或完成时运行 `codument mission task transition <mission-id> <task-id> ACTIVE|DONE`；TaskGroup 在其子任务实际收口后用同一命令更新。CLI 负责合法状态、revision 和更新时间。

### 4.2 TrackLink 绑定写回

`TrackLink` 只挂在叶子 `Task` 上，并显式指向其 ProjectRef：

```xnl
<Task #G3-T1 { name = "创建并执行 runtime contracts track" status = "NOT_STARTED" order = 0 } (
  <TrackLink #add-runtime-contracts { state = "candidate" project_ref = "host" }>
)>
```

TrackLink 是对真实 track 生命周期的承诺，不是一个普通标签：

- `{ state = "candidate" }` 只表示推荐 track id，不能代表 track 已存在。
- `{ state = "bound" }` 只能由 `codument mission bind-track` 在 ProjectRef 的 session WorkspaceBinding 可解析且目标项目中真实 track 可解析后写入。
- 带 `TrackLink` 的 ready leaf 的合法操作是：创建 track、绑定 TrackLink、执行 / 验证 / 归档该真实 track。
- 直接改代码而不创建真实 track 是非法操作；如果执行中确认该叶子不应再由 track 承担，必须先受控重规划，supersede / 移除该 `TrackLink`，并在 replan report 中记录原因。

当 `MissionApplier` 创建或发现真实 Track 后，立即运行 `codument mission bind-track <mission-id> <task-id> <track-id>`。CLI 验证 Track authority，写真实 id、bound state、leaf ACTIVE、revision、更新时间与 bind report；已存在 Track 直接绑定后继续。

### 4.3 连续 track 预算

一次 invocation 最多连续完成 10 个 linked track 生命周期。只有 linked track 完成、其 mission leaf 被写为 `DONE`，并已记录实际证据时才计数；创建、绑定、分析和普通验证不计数。

达到 10 时写 `reports/continuation-XXX.md`，记录已完成 track、下一 ready 节点和恢复入口，然后返回 checkpoint。不得把 mission 改为 `blocked` 或 `completed`；下一次 invocation 重新从 `mission.xnl` 观察。

## 5. 受控重规划

允许变更：

- 增加 mission 节点。
- 删除 / supersede mission 节点。
- 修改节点描述、验收、状态。
- 修改 DAG 依赖。
- 改变某 `TrackLink { state = "candidate" }` 的边界、id 或顺序。

硬要求：

- 必须有 evidence 或 human decision。
- 必须写 `reports/replan-XXX.md` 或 `reports/human-intervention-XXX.md`。
- 重规划写回后运行 `codument validate <mission-id> --strict`；Mission 状态和 task 状态使用 `mission transition` / `mission task transition` 命令更新，CLI 负责 revision 与时间。

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

- 先执行 completed gate（见 §7.1）。gate 未通过时不得更新为 `completed`。
- 运行 `codument mission transition <mission-id> completed`；CLI completion gate 校验任务终态并写入 revision/时间。
- 写 `reports/mission-complete.md`。
- 提示用户使用 `codument-archive-mission` 归档。

### 7.1 Completed gate

更新 Mission 根 `status = "completed"` 前必须逐项确认：

- 所有必要 `TaskGroup` / `Task` 都是 `DONE` 或 `SUPERSEDED`；`SUPERSEDED` 必须有 replan / human-intervention report 解释。
- 所有 `TrackLink { state = "bound" }` 都能通过当前 session 的 ProjectRef binding 解析到目标项目的真实 track。
- 已完成任务上不应残留 `TrackLink { state = "candidate" }`；除非该任务被 `SUPERSEDED`，且 report 说明该 candidate 被取消或改由其他节点承担。
- 所有关联的真实 track 已完成、归档，或有明确 superseded / abandoned 证据；不能只凭 mission report 声称已完成。
- `proposal.md` 的成功判据都有证据：track 验证报告、测试结果、代码位置、设计决策或人工确认。
- mission reports 不自相矛盾：例如不得同时写“未创建 track”与 `TrackLink { state = "bound" }`，或写“已完成”但缺少对应 track。
- `mission.xnl` XNL/Kind/领域校验有效；对每个 linked track，best-effort 运行 `codument validate <track-id> --strict`。

任一项失败时，不得标记 `completed`。应进入 drift / replan / blocked 分支，先修复结构偏差或向用户报告阻塞。
