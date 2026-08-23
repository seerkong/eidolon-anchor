# Mission XNL 规范

`codument/missions/{pending,active}/<id>/mission.xnl` 是 Mission 的 desired state、执行状态、调度和控制 loop 真源；归档后位于 `missions/archived/<date>-<id>/mission.xnl`。新 Mission 必须由 `codument mission create <id> --stage pending|active` 生成，版本来自 Mission KindDefinition。

## 1. 目录与 Kind

```text
missions/<state>/<id>/
  mission.xnl
  proposal.md
  design.md
  decisions.xnl       # 首个真实决策出现时才创建
  reports/            # observe/reconcile/continuation evidence
  analysis/           # 可选迭代期记忆
  memory/             # 可选 durable candidate
```

`proposal.md` 与 `design.md` 是 required files。Kind authority 位于 `std/kinds/KindDefinitions/Mission/manifest.xnl`，当前 apiVersion 为 `codument.tech/v1alpha1`。

## 2. Canonical DSL

下例是 `codument mission create` 生成骨架并经过执行更新后的完整投影。`#id`、`apiVersion`、`version`、初始状态与时间字段由 CLI 写入；作者只保留这些 receipt 值，不从示例复制。

```xnl
<Mission #adopt-kind-system apiVersion="codument.tech/v1alpha1" version="1" {
  status = "active"
  goal = "统一版本化结构资源"
  description = "以控制论循环推进多个真实 Track"
  question_mode = "decision-tree"
  question_severity = "auto"
  revision = 3
  created_at = "2026-08-15T09:00:00Z"
  updated_at = "2026-08-15T10:00:00Z"
} (
  <Ports { scope = "mission" } [
    <MaterialBundle { role = "state" name = "reports" domain = "mission" path = "vfs://./reports/" }>
  ]>
  <ProjectRefs [
    <ProjectRef #host { kind = "host" }>
    <ProjectRef #compiler { kind = "external" }>
  ]>
  <ActorSets { default = "default-loop" } [
    <ActorSet #default-loop [
      <Actor { role = "MissionPlanner" project_ref = "host" } (<Description ?>规划下一条可验证 Track。</?>)>
      <Actor { role = "MissionObserver" project_ref = "host" } (<Description ?>读取代码、资源和验证证据。</?>)>
      <Actor { role = "MissionReconciler" project_ref = "host" } (<Description ?>比较 desired 与 actual state。</?>)>
      <Actor { role = "MissionApplier" project_ref = "host" } (<Description ?>实现并验证 ready operation。</?>)>
    ]>
  ]>
  <TaskSpace #space_adopt-kind-system { name = "adopt-kind-system" version = "1" child_mode = "dag" } (
    <SubNodes [
      <TaskGroup #G1 { name = "Foundation" status = "DONE" order = 0 } (
        <SubNodes [
          <Task #G1-T1 { name = "Build CLI" status = "DONE" order = 0 } (
            <TrackLink #build-cli { state = "bound" project_ref = "host" }>
          )>
        ]>
      )>
      <TaskGroup #G2 { name = "Integration" status = "ACTIVE" order = 1 }>
    ]>
  )>
  <Schedule [
    <Dag { for = "space_adopt-kind-system" } [
      <Node #G2 [<After { ref = "G1" }>]>
    ]>
  ]>
  <Hooks [
    <Hook { on = "mission:after-node" } (
      <MissionReconcile { max_tracks = 10 on_limit = "checkpoint" on_drift = "replan-or-block" }>
    )>
  ]>
)>
```

## 3. XNL 通道

- Mission `#id` 是 identity；`apiVersion`/`version` 是 metadata。
- `status`、目标、问答策略、`revision`、时间和可选 `gap_round` 放根 `{}`，不得创建 `<Metadata>`。
- `Ports`、`ProjectRefs`、`ActorSets`、`SubNodes`、`Schedule`、`Hooks` 等集合使用 `[]`。
- `TaskSpace`、`Description`、单个 `TrackLink` 和 Hook operation 等 singleton 使用 `()`。
- 普通节点属性放 `{}`；Mission XNL 不使用 XML namespace 或 `cdt:` 前缀。

Mission 状态：`pending | active | completed | cancelled | superseded | archived`。节点状态：`NOT_STARTED | ACTIVE | DONE | BLOCKED | ABANDONED | SUPERSEDED`。

根状态是可恢复的生命周期状态，不是永久锁。`completed | cancelled | superseded | archived` Mission 在用户明确续跑或补充任务时，可运行 `codument mission transition <id> active` 恢复；若唯一 authority 已归档，CLI 将其移动回 `missions/active/<id>/` 并递增 revision。恢复不会撤销此前归档产生的 durable 产物；再次进入 `completed` 仍必须通过当前任务树的 completion gate。若 archived 中存在多个同 id authority，CLI 必须拒绝猜测并要求先消除歧义。

## 4. ProjectRefs 与 ActorSets

- ProjectRef 只保存逻辑 id 与 `kind = "host|external"`，不得持久化 workspace path；路径由当前 session 的 WorkspaceBinding 提供。
- ProjectRef 没有 WorkspaceBinding 时，Observer 将其投影为 `UNBOUND`；已有绑定但目标资源不存在时投影为 `MISSING`。
- 恰好一个 host ProjectRef。
- 每个 ActorSet 必须恰好包含 `MissionPlanner`、`MissionObserver`、`MissionReconciler`、`MissionApplier` 各一个 Actor。
- Actor 的 `project_ref` 必须可解析，并包含 mission-specific `Description`。
- TaskGroup 可用 `actor_set` 选择其他完整 ActorSet。

## 5. TrackLink

`TrackLink` 只挂在叶子 Task 的 `()` 中：

```xnl
<Task #G2-T1 { name = "Integrate" status = "ACTIVE" order = 0 } (
  <TrackLink #integrate-halfcode { state = "bound" project_ref = "host" }>
)>
```

状态为 `candidate | bound`。`bound` 仅表示通过 session WorkspaceBinding 能在目标项目解析到 active 或 archived `track.xnl`；Mission 不复制 Track 状态，也不持久化项目路径。

`TrackLink { state = "candidate" }` 的激活是 mission logical operation 的一部分。`question_severity = "auto"` 时，Applier 必须立即创建、激活并通过 `codument mission bind-track` 绑定 Track，不等待用户批准。

## 6. 控制循环

MissionPlanner 维护 desired DAG；MissionObserver 读取真实 Track、测试、资源树和报告；MissionReconciler 比较实际态并选择 ready operation；MissionApplier 执行、验证、写回状态和 evidence。

每个 operation 完成后继续循环。只有以下情况返回调用方：

- question policy 要求确认且无保守默认；
- 真实 `BLOCKED` 且无法自动重规划或执行其他 ready 分支；
- Mission 进入 `completed | cancelled | superseded`；
- 本次连续完成 10 条 Track，命中 continuation checkpoint。

这些子流程的 `return` / “完成即停” / “收口”只返回到 `MissionApplier`，不是 mission invocation 的默认停点。`mission:after-node` 上的 `MissionReconcile` 是 mission 连续循环内部的 reconcile/checkpoint gate，不是用户确认 gate；`max_tracks` 只统计连续完成的 Track 生命周期，不是通用 operation 计数器。

## 7. Replanning

active Mission 可以受控修改 `mission.xnl`：先写 `reports/replan-<n>.md`，再更新 TaskSpace/Schedule；状态通过 Mission lifecycle CLI 写回，由 CLI 递增根 `revision` 与 `updated_at`。历史 DONE 节点不重写；废弃节点用 `SUPERSEDED` 并保留原因。新 TrackLink 必须指向真实 candidate/bound Track 生命周期。

## 8. Authority 与迁移

- 新建与状态写入只使用 `mission.xnl`。
- legacy `mission.xml` 在兼容窗口内仍可读和校验。
- 同目录双 authority 是冲突，必须停止。
- `upgrade-workspace` 先备份，再结构化转换、解析验证、原子替换；失败返回 `review-required` 并保留 XML。
- 程序转换后由 AI review ActorSets、ProjectRefs、TrackLink、DAG、Hook 和 XNL 通道。

## 9. 严格校验

1. 唯一 Mission 根具有 `#id`、当前 apiVersion/version 和合法根属性。
2. proposal/design required files 存在。
3. XNL singleton/collection/attribute channel 使用正确。
4. TaskSpace 节点 id、状态、DAG 引用和无环性合法。
5. ProjectRefs、ActorSets、TrackLink 引用闭合且无持久化 workspace path。
6. Hook 与 MissionReconcile 参数合法；`max_tracks` 是正整数。
7. decision source set 通过 Decision Kind 与 decision schema 校验。

```bash
codument validate <mission-id> --strict
```
