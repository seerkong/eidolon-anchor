# Mission XML 规范

`codument/missions/{pending,active,archived}/.../mission.xml` 是 codument mission 的**结构 / 状态 / 调度真源**。mission 是比 track 更长周期的控制面对象，用于编排多个 plan 节点和落地 track，并允许在执行中根据 evidence 或 human decision 受控重规划。

mission 不替代 track。真实代码、规范、测试和迁移仍由 `codument/tracks/{pending,active}/<id>/track.xml` 管理，归档历史位于 `codument/tracks/archived/`。

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

  <cdt:ProjectRefs>
    <cdt:ProjectRef id="host" kind="host"/>
  </cdt:ProjectRefs>
  <cdt:ActorSets default="runtime-control-loop">
    <cdt:ActorSet id="runtime-control-loop">
      <cdt:Actor role="MissionPlanner" project-ref="host"><Description>根据 runtime evidence 切分并重规划 tracks。</Description></cdt:Actor>
      <cdt:Actor role="MissionObserver" project-ref="host"><Description>读取 runtime tests、tracks、archive 与 reports 的实际态。</Description></cdt:Actor>
      <cdt:Actor role="MissionReconciler" project-ref="host"><Description>比较 runtime desired graph 与实际态，选择下一个 planned ready action，并在验证明确时持续推进。</Description></cdt:Actor>
      <cdt:Actor role="MissionApplier" project-ref="host"><Description>连续创建、执行或验证 runtime track；在动作内验证完成，只有不确定或发现偏差时才观察并协调，或受控修订 mission。</Description></cdt:Actor>
    </cdt:ActorSet>
  </cdt:ActorSets>

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
            <cdt:TrackLink state="candidate" id="add-runtime-data-subgraph-contracts" project-ref="host"/>
          </Task>
        </SubNodes>
      </TaskGroup>
      <TaskGroup id="G3" name="首批 track 落地" status="NOT_STARTED" order="2">
        <Description>创建并执行首批 track。</Description>
        <SubNodes>
          <Task id="G3-T1" name="创建并执行 runtime data subgraph track" status="NOT_STARTED" order="0">
            <cdt:TrackLink state="candidate" id="add-runtime-data-subgraph-contracts" project-ref="host"/>
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
      <cdt:MissionReconcile max-tracks="10" on-limit="checkpoint" on-drift="replan-or-block"/>
    </Hook>
  </Hooks>
</Mission>
```

## 4. ProjectRef、ActorSet 与 session binding

`<cdt:ProjectRefs>` 和 `<cdt:ActorSets>` 都是 `<Mission>` 的直接子节点。新建或修订 mission 时必须 materialize 它们；旧 mission 可读，但在首次受控写入时补齐。

```xml
<cdt:ProjectRefs>
  <cdt:ProjectRef id="host" kind="host"/>
  <cdt:ProjectRef id="shared-library" kind="external"/>
</cdt:ProjectRefs>
<cdt:ActorSets default="application-loop">
  <cdt:ActorSet id="application-loop">
    <cdt:Actor role="MissionPlanner" project-ref="host"><Description>为上层应用安排反馈驱动的 tracks。</Description></cdt:Actor>
    <cdt:Actor role="MissionObserver" project-ref="host"><Description>观测应用集成、测试与用户反馈。</Description></cdt:Actor>
    <cdt:Actor role="MissionReconciler" project-ref="host"><Description>判断应用是否应等待底层库或继续独立工作。</Description></cdt:Actor>
    <cdt:Actor role="MissionApplier" project-ref="host"><Description>连续执行应用侧 track、验证或重规划；验证明确且无偏差时直接推进。</Description></cdt:Actor>
  </cdt:ActorSet>
</cdt:ActorSets>
```

- `ProjectRef.id` 是唯一、路径无关的逻辑项目身份；必须恰有一个 `kind="host"`，其余可为 `kind="external"`。
- 每个 `ActorSet` 必须恰有一次四个标准角色。角色协议只在本规范的 [§8](#8-cybernetic-depa-actors) 定义；`Actor/Description` 必须填写该 mission 和 project context 中的具体工作方式，不能复制该通用协议。
- `default` 指向完整默认 ActorSet。`TaskGroup cdt:actor-set="..."` 可替换整个 ActorSet；未设置时继承最近祖先，再回退到默认集。禁止逐角色 merge。
- `WorkspaceBinding` 是 `impl-mission` 当前 session 输入中 `ProjectRef -> workspace root` 的临时映射，不是 XML 节点或文件格式。不得写入 mission、track、report、decision 或项目配置，也不得持久化任何 `path` / `workspace` 属性。
- 外部 ProjectRef 缺少本 session binding 时，Observer 投影 `UNBOUND`。binding 存在但目标项目中找不到 TrackLink 对应 `track.xml` 时，投影 `MISSING`；实际 track 状态始终由目标项目自己的 `track.xml` 所有。Reconciler 只阻断直接依赖该 ProjectRef 的动作，其他 DAG 分支继续。

### 4.1 单项目反馈飞轮

上面的 `runtime-evolution` 是单项目示例：所有 Actor 绑定 `host`，Observer 读取同一项目的 tests/tracks，Reconciler 的 evidence 可触发 Planner 修订后续 runtime tracks。它形成由动作验证驱动的 `observe -> reconcile -> apply -> verify` 闭环：验证明确且无偏差时直接推进，只有不确定或发现偏差时才重新观察并协调，而不是把四 Actor 当作固定的人名或重复的 design.md 模板。

### 4.2 底层库与上层应用反馈飞轮

以下片段展示上层应用 host 与外部底层库协同：应用阶段继承默认集，库修复阶段以完整局部 ActorSet 覆盖。两边都只保存逻辑 id，新的 session 可重新提供 binding 后恢复观察。

```xml
<Mission id="library-application-feedback" version="1" xmlns:cdt="urn:codument:v1">
  <Metadata>
    <Status>pending</Status>
    <Goal>通过应用反馈迭代底层库，并将可验证结果回流应用。</Goal>
    <Description>上层应用与底层库以完整 ActorSet 交替收敛。</Description>
    <Revision>1</Revision>
  </Metadata>
  <cdt:ProjectRefs>
    <cdt:ProjectRef id="application" kind="host"/>
    <cdt:ProjectRef id="foundation-library" kind="external"/>
  </cdt:ProjectRefs>
  <cdt:ActorSets default="application-loop">
    <cdt:ActorSet id="application-loop">
      <cdt:Actor role="MissionPlanner" project-ref="application"><Description>从应用集成反馈切分应用或库 tracks。</Description></cdt:Actor>
      <cdt:Actor role="MissionObserver" project-ref="application"><Description>观察应用集成、契约测试和交付反馈。</Description></cdt:Actor>
      <cdt:Actor role="MissionReconciler" project-ref="application"><Description>判断应用可独立推进的工作与库依赖。</Description></cdt:Actor>
      <cdt:Actor role="MissionApplier" project-ref="application"><Description>执行一个应用侧实现、验证或重规划动作。</Description></cdt:Actor>
    </cdt:ActorSet>
    <cdt:ActorSet id="library-loop">
      <cdt:Actor role="MissionPlanner" project-ref="foundation-library"><Description>将应用暴露的抽象缺口切为库侧 tracks。</Description></cdt:Actor>
      <cdt:Actor role="MissionObserver" project-ref="foundation-library"><Description>观察库的 contract tests、track 状态与 archive。</Description></cdt:Actor>
      <cdt:Actor role="MissionReconciler" project-ref="foundation-library"><Description>比较库 API 期望与应用反馈，判断下一个库侧动作。</Description></cdt:Actor>
      <cdt:Actor role="MissionApplier" project-ref="foundation-library"><Description>执行一个库侧修复或向应用回传可验证证据。</Description></cdt:Actor>
    </cdt:ActorSet>
  </cdt:ActorSets>
  <TaskSpace id="space_library-application-feedback" name="library-application-feedback" version="1" cdt:child-mode="dag">
    <SubNodes>
      <TaskGroup id="G1" name="应用集成" status="NOT_STARTED" order="0"><SubNodes><Task id="G1-T1" name="执行应用集成 track" status="NOT_STARTED" order="0"><cdt:TrackLink state="candidate" id="integrate-library-contract" project-ref="application"/></Task></SubNodes></TaskGroup>
      <TaskGroup id="G2" name="库反馈" status="NOT_STARTED" order="1" cdt:actor-set="library-loop"><SubNodes><Task id="G2-T1" name="执行库侧反馈 track" status="NOT_STARTED" order="0"><cdt:TrackLink state="candidate" id="repair-foundation-contract" project-ref="foundation-library"/></Task></SubNodes></TaskGroup>
      <TaskGroup id="G3" name="应用复验" status="NOT_STARTED" order="2"><SubNodes><Task id="G3-T1" name="复验应用契约" status="NOT_STARTED" order="0"/></SubNodes></TaskGroup>
    </SubNodes>
  </TaskSpace>
  <Schedule><Dag for="space_library-application-feedback"><Node id="G2"><After ref="G1"/></Node><Node id="G3"><After ref="G2"/></Node></Dag></Schedule>
</Mission>
```

如果 `foundation-library` 未绑定，只有 `G2` 及依赖它的 `G3` 等待；与之无依赖的 application DAG 分支仍可执行。绑定后而找不到 `repair-foundation-contract` 才是 `MISSING`，应以目标项目的实际证据进入 drift、replan 或 blocked。

## 5. Metadata

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

## 6. TaskSpace

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

### 6.1 TrackLink

`cdt:TrackLink` 是 mission 叶子任务与 codument track 的绑定指针，不是任务状态，也不是路径缓存。

```xml
<Task id="G2-T2" name="确认首批 track 切片" status="NOT_STARTED" order="1">
  <cdt:TrackLink state="candidate" id="add-runtime-data-subgraph-contracts" project-ref="host"/>
</Task>
```

创建真实 track 后，`codument-impl-mission` 必须原地更新同一个节点：

```xml
<Task id="G2-T2" name="确认首批 track 切片" status="DONE" order="1">
  <cdt:TrackLink state="bound" id="add-runtime-data-subgraph-contracts" project-ref="host"/>
</Task>
```

属性：

| 属性 | 必填 | 含义 |
|---|---:|---|
| `state` | 是 | `candidate` 或 `bound` |
| `id` | 是 | `candidate` 时是推荐 track id；`bound` 时是真实 track id |
| `project-ref` | 是 | Track 所属 ProjectRef；host 和 external 都显式写出 |

禁止在 `cdt:TrackLink` 上写 `path`、`archive-path`、workspace 或 track 状态。消费者先通过 session WorkspaceBinding 解析 `project-ref`，再通过 `id` 解析目标项目中的真实位置：

- pending track：`codument/tracks/pending/<id>/track.xml`
- active track：`codument/tracks/active/<id>/track.xml`
- archived track：`codument/tracks/archived/**/<timestamp>-<id>/track.xml`

如果真实创建的 track id 与 candidate id 不同，直接把 `id` 更新为真实 id，并在 `reports/track-bind-XXX.md` 记录原 candidate id。

## 7. Schedule

mission 顶层默认 DAG：

```xml
<TaskSpace id="space_x" cdt:child-mode="dag">
```

`Schedule` 规则与 track 一致：

- `<Dag for="...">` 只描述该父节点的直接下层依赖。mission 默认只把顶层 `TaskGroup` 放进 `TaskSpace` 的 DAG。
- `<Node id="..."><After ref="..."/></Node>` 表示前驱。
- 不跨层、不跨父。
- 一个 `TaskGroup` 内的叶子 `Task` 默认按 `order` 顺序执行，不在 mission 顶层 `Schedule/Dag` 中描述。

## 8. Cybernetic DEPA Actors

mission execution is a cybernetic actor loop over a DAG-shaped desired state.

| Actor | 控制论角色 | DEPA 归属 | 职责 |
|---|---|---|---|
| `MissionPlanner` | 期望态产出者 | Processor + Actor | 产出或修订 desired mission graph |
| `MissionObserver` | 传感器 | Data + Actor | 读取 actual state projection |
| `MissionReconciler` | 控制器 | Processor + Actor | 比较 desired vs actual，判定 drift / ready / blocked / done，并选择下一个 planned ready action |
| `MissionApplier` | 执行器 | Effect + Actor | 执行当前 mission logical action 并写入实际态；子流程返回后继续回到 mission loop |

执行协议：

```text
MissionObserver 观测实际态
-> MissionReconciler 比较 mission.xml 期望态 vs 实际态
-> MissionPlanner 在必要时提出重规划
-> MissionApplier 执行当前 mission logical action
-> 写 report / 更新 mission.xml
-> 同一 invocation 继续下一轮
```

### 8.1 连续执行与 `max-tracks`

`codument-impl-mission` 默认持续执行。pending mission 激活后必须立即从 `active/<id>/mission.xml` 继续；每个 logical action 在自身范围内完成验证，不以单个节点或单条 track 的完成作为默认返回点。

动作验证直接使用已有的验收条件、相关测试、track 状态、外部资源读取或分析证据；不要求写回执文件，也不规定 XNL、JSON 或其他统一序列化格式。验证通过且没有前提、依赖、范围或目标的失效信号时，直接选择下一个 planned ready action。验证不确定、失败或发现失效信号时，Observer 先读取受影响范围，Reconciler 再决定继续、重规划或阻塞；只有范围无法可靠界定时才全量观察。

`mission:after-node` 上的 `<cdt:MissionReconcile>` 是 mission 连续循环内部的 reconcile/checkpoint gate，不是“每个 node 后返回给用户”的 hook。若当前 action 调用 `codument-impl-track`、`codument-archive-track`、`codument-verify`、`codument-gap-loop` 或 fresh 子代理，这些子流程的 `return` / “完成即停” / “收口”只返回到 `MissionApplier`；mission 父层必须用结果更新 `mission.xml` / report，并继续循环，除非命中待确认 decision、真实 BLOCKED、终态或 `max-tracks` checkpoint。

循环只在需要用户确认的 pending decision、真实 `BLOCKED`、`completed` / `cancelled` / `superseded` 时返回。`QuestionSeverity=auto` 记录假设后继续。

`<cdt:MissionReconcile max-tracks="10" on-limit="checkpoint"/>` 表示一次 invocation 最多连续完成 10 个 linked track 生命周期。达到上限时，写 continuation report 并返回 checkpoint；mission 仍为 `active`，后续 invocation 从状态真源续跑。它不是通用 action 计数器。

`cdt:TrackLink state="candidate"` 的激活是 mission logical action 的一部分：ready action 创建真实 track 后，`QuestionSeverity=auto`（或连续执行模式）下 `MissionApplier` 立即把 track 激活到 `tracks/active/<id>/`、回写 `TrackLink state="bound"` 与 bind report，并继续循环，不等待用户批准；只有显式配置了确认 gate（如 `cdt:HumanConfirm`，或显式更高 severity 且无保守默认可替代）才停在激活点。`plan-track` 的 pending/批准语义只约束用户直接对话场景（见 `actions/plan-track.md` §3.2 调用方上下文）。

## 9. 受控重规划

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
- 暂停等待人工介入（仅用于显式配置的确认 gate 或真实不可自动恢复的阻塞；不作为自主迭代的默认停点）。

## 10. 标准文件拆分

新 mission 不使用 `roadmap.md`。内容拆分：

- `proposal.md`：目标、非目标、成功判据、背景。
- `design.md`：此 mission 的控制目标、重规划协议、风险、plan vs track 区分；不重复四个标准 actor 定义。
- `mission.xml`：ProjectRefs、ActorSets 中的具体 actor 工作方式、TaskGroup/Task 节点、依赖、状态、`cdt:TrackLink` 绑定。
- `analysis/`：执行期 evidence / findings，默认不进 git。
- `reports/`：mission run / drift / replan / verify reports，默认不进 git。
