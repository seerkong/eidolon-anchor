# Mission XML 规范

`codument/missions/{pending,active,archived}/.../mission.xml` 是 codument mission 的**结构 / 状态 / 调度真源**。mission 是比 track 更长周期的控制面对象，用于编排多个 plan 节点和落地 track，并允许在执行中根据 evidence 或 human decision 受控重规划。

mission 不替代 track。真实代码、规范、测试和迁移仍由 `codument/tracks/<id>/track.xml` 管理。

## 1. 目录位置

```text
codument/missions/
  pending/<mission-id>/mission.xml
  active/<mission-id>/mission.xml
  archived/YYYY-MM-DD-<mission-id>/mission.xml
```

- `pending`：已规划但未启动。
- `active`：正在执行；允许受控重规划。
- `archived`：完成、取消、废弃或被替代。

## 2. 与 track.xml 的关系

`mission.xml` 与 `track.xml` 同构，复用三轴模型：

- `TaskSpace`：结构轴，表达 mission plan 分组、叶子任务、TrackLink 绑定和状态。
- `Schedule`：调度轴，表达 DAG 依赖。
- `Hooks`：行为轴，表达 mission reconcile、人工确认、方向审查等生命周期行为。

区别：

- 根节点是 `<Mission>`。
- 顶层 `TaskSpace` 默认 `cdt:child-mode="dag"`。
- active mission 允许受控重规划，须递增 `Metadata.Revision` 并写 report。
- mission 的顶层节点应是 `TaskGroup`；真正执行单元是叶子 `Task`。track creation / track execution 通过叶子 `Task` 上的 `cdt:TrackLink` 绑定真实 track。

## 3. 最小示例

```xml
<Mission id="runtime-evolution" version="1" xmlns:cdt="urn:codument:v1">
  <Metadata>
    <Status>pending</Status>
    <Goal>重构 runtime 长周期架构</Goal>
    <Description>先证据盘点，再设计收敛，再切片为 tracks 落地。</Description>
    <QuestionMode>decision-tree</QuestionMode>
    <QuestionSeverity>light</QuestionSeverity>
    <Revision>1</Revision>
    <CreatedAt>2026-06-27T13:56:11Z</CreatedAt>
    <UpdatedAt>2026-06-27T13:56:11Z</UpdatedAt>
  </Metadata>

  <Ports scope="mission">
    <MaterialBundle role="state" name="analysis" domain="mission" path="vfs://./analysis/"/>
    <MaterialBundle role="state" name="reports" domain="mission" path="vfs://./reports/"/>
    <MaterialBundle role="output" name="tracks" domain="codument" path="vfs://@/codument/tracks/"/>
  </Ports>

  <TaskSpace id="space_runtime-evolution" name="runtime-evolution" version="1" cdt:child-mode="dag">
    <Description>Runtime evolution mission.</Description>
    <SubNodes>
      <TaskGroup id="G1" name="证据盘点" status="NOT_STARTED" order="0">
        <Description>盘点事实源、读写路径和包边界。</Description>
        <SubNodes>
          <Task id="G1-T1" name="盘点事实源" status="NOT_STARTED" order="0"/>
          <Task id="G1-T2" name="盘点包边界" status="NOT_STARTED" order="1"/>
        </SubNodes>
      </TaskGroup>
      <TaskGroup id="G2" name="设计收敛" status="NOT_STARTED" order="1">
        <Description>形成架构归属和候选 track 边界。</Description>
        <SubNodes>
          <Task id="G2-T1" name="形成架构方案" status="NOT_STARTED" order="0"/>
          <Task id="G2-T2" name="确认首批 track 切片" status="NOT_STARTED" order="1">
            <cdt:TrackLink state="candidate" id="add-runtime-data-subgraph-contracts"/>
          </Task>
        </SubNodes>
      </TaskGroup>
      <TaskGroup id="G3" name="首批 track 落地" status="NOT_STARTED" order="2">
        <Description>创建并执行首批 track。</Description>
        <SubNodes>
          <Task id="G3-T1" name="创建并执行 runtime data subgraph track" status="NOT_STARTED" order="0">
            <cdt:TrackLink state="candidate" id="add-runtime-data-subgraph-contracts"/>
          </Task>
          <Task id="G3-T2" name="验证首批 track 结果" status="NOT_STARTED" order="1"/>
        </SubNodes>
      </TaskGroup>
    </SubNodes>
  </TaskSpace>

  <Schedule>
    <Dag for="space_runtime-evolution">
      <Node id="G2"><After ref="G1"/></Node>
      <Node id="G3"><After ref="G2"/></Node>
    </Dag>
  </Schedule>

  <Hooks>
    <Hook on="mission:after-node">
      <cdt:MissionReconcile max-rounds="3" on-drift="replan-or-block"/>
    </Hook>
  </Hooks>
</Mission>
```

## 4. Metadata

```xml
<Metadata>
  <Status>active</Status>
  <Goal>...</Goal>
  <Description>...</Description>
  <QuestionMode>decision-tree</QuestionMode>
  <QuestionSeverity>light</QuestionSeverity>
  <Revision>7</Revision>
  <CreatedAt>...</CreatedAt>
  <UpdatedAt>...</UpdatedAt>
</Metadata>
```

mission status:

- `pending`
- `active`
- `completed`
- `cancelled`
- `superseded`
- `archived`

`Revision` 从 `1` 起。每次受控重规划必须递增。

`QuestionMode` / `QuestionSeverity` 记录 mission 规划期的问答策略，与 track.xml 保持一致：

- `QuestionMode` 当前取 `decision-tree`。
- `QuestionSeverity` 取 `auto|light|normal|deep`；未指定按 `light` 处理。
- 这两个字段只控制规划/澄清阶段，不等同于 track 的 `CommitMode`。

## 5. TaskSpace

mission TaskSpace 必须保持接近 track.xml 的结构：

- 顶层直接子节点使用 `TaskGroup`，表达可 DAG 调度的 mission 工作组（如证据盘点、设计收敛、首批落地、验证收口）。
- `TaskGroup` 内部使用叶子 `Task` 表达顺序执行的实际动作。
- mission 任务状态只写在 `TaskGroup.status` / `Task.status` 上。
- `cdt:TrackLink` 只允许挂在叶子 `Task` 上，不挂在 `TaskGroup` 上。
- 顶层 `TaskGroup` id 建议使用 `G1` / `G2` / `VERIFY` / `CLOSE` 等语义化或稳定短 id；叶子 task id 建议使用 `G1-T1` 形态。

节点状态复用 track TaskSpace 状态：

- `NOT_STARTED`
- `ACTIVE`
- `DONE`
- `BLOCKED`
- `ABANDONED`
- `SUPERSEDED`

如果现有 validator 只支持 track 状态枚举，第一版实现可以在 mission spec 中定义语义，后续再扩 validator。

### 5.1 TrackLink

`cdt:TrackLink` 是 mission 叶子任务与 codument track 的绑定指针，不是任务状态，也不是路径缓存。

```xml
<Task id="G2-T2" name="确认首批 track 切片" status="NOT_STARTED" order="1">
  <cdt:TrackLink state="candidate" id="add-runtime-data-subgraph-contracts"/>
</Task>
```

创建真实 track 后，`codument-impl-mission` 必须原地更新同一个节点：

```xml
<Task id="G2-T2" name="确认首批 track 切片" status="DONE" order="1">
  <cdt:TrackLink state="bound" id="add-runtime-data-subgraph-contracts"/>
</Task>
```

属性：

| 属性 | 必填 | 含义 |
|---|---:|---|
| `state` | 是 | `candidate` 或 `bound` |
| `id` | 是 | `candidate` 时是推荐 track id；`bound` 时是真实 track id |

禁止在 `cdt:TrackLink` 上写 `path`、`archive-path` 或 track 状态。消费者通过 `id` 解析真实位置：

- active track：`codument/tracks/<id>/track.xml`
- archived track：`codument/archive/**/<timestamp>-<id>/track.xml`

如果真实创建的 track id 与 candidate id 不同，直接把 `id` 更新为真实 id，并在 `reports/track-bind-XXX.md` 记录原 candidate id。

## 6. Schedule

mission 顶层默认 DAG：

```xml
<TaskSpace id="space_x" cdt:child-mode="dag">
```

`Schedule` 规则与 track 一致：

- `<Dag for="...">` 只描述该父节点的直接下层依赖。mission 默认只把顶层 `TaskGroup` 放进 `TaskSpace` 的 DAG。
- `<Node id="..."><After ref="..."/></Node>` 表示前驱。
- 不跨层、不跨父。
- 一个 `TaskGroup` 内的叶子 `Task` 默认按 `order` 顺序执行，不在 mission 顶层 `Schedule/Dag` 中描述。

## 7. Cybernetic DEPA Actors

mission execution is a cybernetic actor loop over a DAG-shaped desired state.

| Actor | 控制论角色 | DEPA 归属 | 职责 |
|---|---|---|---|
| `MissionPlanner` | 期望态产出者 | Processor + Actor | 产出或修订 desired mission graph |
| `MissionObserver` | 传感器 | Data + Actor | 读取 actual state projection |
| `MissionReconciler` | 控制器 | Processor + Actor | 比较 desired vs actual，判定 drift / ready / blocked / done |
| `MissionApplier` | 执行器 | Effect + Actor | 执行一个 bounded convergence action |

执行协议：

```text
MissionObserver 观测实际态
-> MissionReconciler 比较 mission.xml 期望态 vs 实际态
-> MissionPlanner 在必要时提出重规划
-> MissionApplier 执行一个 bounded action
-> 写 report / 更新 mission.xml
-> 下一轮
```

## 8. 受控重规划

active mission 允许修改 `mission.xml`，但必须满足：

- 有 evidence 或 human decision。
- 写入 `reports/replan-XXX.md` 或 `reports/human-intervention-XXX.md`。
- 更新 `Metadata.Revision` 和 `UpdatedAt`。
- 说明 trigger、actual state、desired state、diff、decision、applied change。

允许的重规划：

- 新增节点。
- 删除 / supersede 节点。
- 修改节点目标、验收、状态。
- 修改 DAG 依赖。
- 暂停等待人工介入。

## 9. 标准文件拆分

新 mission 不使用 `roadmap.md`。内容拆分：

- `proposal.md`：目标、非目标、成功判据、背景。
- `design.md`：actor 模型、重规划协议、风险、plan vs track 区分。
- `mission.xml`：TaskGroup/Task 节点、依赖、状态、`cdt:TrackLink` 绑定。
- `analysis/`：执行期 evidence / findings，默认不进 git。
- `reports/`：mission run / drift / replan / verify reports，默认不进 git。
