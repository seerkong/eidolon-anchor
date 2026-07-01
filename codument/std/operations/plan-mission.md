# skill: codument-plan-mission（创建长周期 mission）

为一个跨多个 track、需要较长时间自动化收敛的目标创建 **Mission**：生成 `mission.xml`、`proposal.md`、`design.md`，并放入 `codument/missions/pending/<mission-id>/`。

> mission 是长周期控制面，不是大号 track。真实代码 / 规范 / 测试落地仍由 track 承担；mission 负责期望态 DAG、观察实际态、受控重规划和跨 track 编排。
>
> 文件格式见 `codument/std/spec/mission-xml-spec.md`；流程块格式见 `codument/std/spec/flow-notation.md`。

## 0. 何时创建 mission

创建 mission 的场景：

- 一个目标明显跨多个 track 或多个仓库。
- 需要先做证据盘点、设计收敛、track 切片，再逐批落地。
- 执行期可能出现较大不确定性，需要重规划、人工介入、阶段性验证。
- 用户明确要求更长时间自动化。

不要创建 mission 的场景：

- 单个 track 能闭环。
- 纯 bug fix / 拼写 / 配置。
- 只是想把一个 track 拆成多个 phase。

## 1. 产物

```text
codument/missions/pending/<mission-id>/
  mission.xml
  proposal.md
  design.md
  decisions.md
  decisions/
  memory/
  analysis/   # 默认不进 git
  reports/    # 默认不进 git
```

新 mission 不创建 `roadmap.md`。

## 1.5 Questioning severity 与无问答模式

创建 mission 前先解析 `codument/std/sop/questioning.md` 的 questioning severity：**未指定时默认 `light`**。

| severity | mission plan 行为 |
|---|---|
| `auto` | 无问答 / 高自主：不因 mission-id、proposal、design、mission.xml 或 DAG 默认值向用户确认；直接推断并把假设写入 `analysis/decision-tree.md`、`decisions.md`、`proposal.md`、`design.md`。 |
| `light` | 默认：只问 P0 用户意图 / 不可逆取舍；能查代码、archive、tracks、missions、attractors、modeling/engineering 就不问。 |
| `normal` | 问 P0/P1，每题必须给推荐答案和取舍。 |
| `deep` | 适用于长期不确定性；允许更深 decision-tree，但每轮必须落文件并收敛 frontier。 |

`analysis/decision-tree.md` 是 mission planning 的推荐外部记忆，记录 Root Question、Severity、Decision Frontier、Assumptions。mission 的四个 actor 使用它：

- `MissionObserver` 先从代码 / 文档 / track/archive / reports 查证可回答问题。
- `MissionPlanner` 生成 desired mission graph 与 decision frontier。
- `MissionReconciler` 判断哪些 pending decision 阻塞 DAG。
- `MissionApplier` 在非 auto 模式下执行一个有界提问；auto 模式下写入假设并选择保守默认。

## 2. Mission Actor 模型

`design.md` 必须写清楚四个控制论 + DEPA actor：

| Actor | 控制论角色 | DEPA 归属 | 职责 |
|---|---|---|---|
| `MissionPlanner` | 期望态产出者 | Processor + Actor | 产出 desired mission graph |
| `MissionObserver` | 传感器 | Data + Actor | 读取 actual state projection |
| `MissionReconciler` | 控制器 | Processor + Actor | 比较 desired vs actual |
| `MissionApplier` | 执行器 | Effect + Actor | 执行 bounded convergence action |

## 3. 主流程

正式进入 mission 规划前，先执行命令级前置 hook：若 `codument/config/operation-hooks.xml` 中存在 `Operation name="plan-mission"` 的 `<Hook on="plan-mission:before">`，按其中 hook DSL 执行。默认配置会运行 `<cdt:AttractorCheck use="coding"/>`，即读取 `config/attractor-profiles.xml` 的 `coding` profile 及其引用的 attractor，将项目工程理念、边界、长期知识沉淀方式作为 mission proposal/design/mission.xml 的规划约束。`operation-hooks.xml` 缺失或没有该 hook 时按默认流程继续。

```text
@delimiter: --
@node: #
@marker: ?
-- #sequence ?plan_mission
---- #if ?before cond="operation-hooks.xml 为 plan-mission 配了 plan-mission:before（默认 <cdt:AttractorCheck use=\"coding\">）"
执行 plan-mission:before hook；AttractorCheck 必须读取 coding profile 与其引用的 attractor，将项目理念作为后续 proposal/design/mission.xml 的约束上下文
---- /?before
---- #step ?context
确认 codument 已初始化；读取 codument/attractors、codument/missions/README.md、codument/std/spec/mission-xml-spec.md；解析 questioning severity（默认 light）。
---- /?context
---- #step ?decision-tree
写 analysis/decision-tree.md：Root Question、Severity、Decision Frontier、Assumptions；auto 模式不得提问。
---- /?decision-tree
---- #step ?id
根据用户目标生成 mission-id；查重 pending/active/archived；auto 模式直接采用并记录命名依据，其他模式在必要时用 ask-single-question-free 确认。
---- /?id
---- #step ?mkdir
创建 codument/missions/pending/<mission-id>/ 以及 decisions/ memory/ analysis/ reports/。
---- /?mkdir
---- #step ?proposal
写 proposal.md：背景、目标、非目标、成功判据、为什么需要 mission 而不是 track。
---- /?proposal
---- #step ?design
写 design.md：MissionPlanner/Observer/Reconciler/Applier、plan vs track 区分、受控重规划、人工介入、风险。
---- /?design
---- #step ?xml
写 mission.xml：<Mission> 根、Metadata、Ports、TaskSpace(cdt:child-mode="dag")、Schedule、Hooks。
---- /?xml
---- #step ?validate
best-effort 校验 XML 格式；若 validator 尚未支持 mission.xml，至少运行 xmllint。
---- /?validate
---- #return ?done value="mission created under pending"
---- /?done
-- /?plan_mission
```

## 4. proposal.md 示例

```markdown
# Mission：runtime evolution

## 背景和动机

当前 runtime control、session persistence、projection surface 多处事实源边界不清，单个 track 无法安全闭环。

## 目标

- 完成证据盘点。
- 完成设计收敛。
- 切片出第一批可落地 tracks。
- 按依赖顺序逐批落地并验证。

## 非目标

- mission 本身不直接改代码。
- 不在没有 evidence 的情况下创建落地 track。

## 成功判据

- 每个落地 track 都能回指 evidence。
- 所有 mission 节点 DONE 或 SUPERSEDED。
- 最终 verify 报告确认目标收敛。
```

## 5. design.md 示例

```markdown
# Mission Design

## 控制论模型

- desired state：mission.xml 的顶层 TaskGroup DAG、组内顺序 Task、节点状态、门禁和叶子 Task 上的 `cdt:TrackLink`。
- actual state：当前 mission 文件、track 状态、archive、测试结果、reports、用户新约束。
- actuation：创建/续跑/归档 track，或受控修订 mission.xml。
- feedback / drift：reports、verify、用户介入、失败证据。

## Mission Actors

| Actor | 职责 |
|---|---|
| MissionPlanner | 产出或修订 desired mission graph |
| MissionObserver | 读取 actual state projection |
| MissionReconciler | 判定 drift / ready / blocked / done |
| MissionApplier | 执行一个 bounded action |

## 受控重规划

active mission 可以增删改节点和 DAG，但必须有 evidence 或 human decision，并写 reports/replan-XXX.md。
```

## 6. mission.xml 示例

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
        <SubNodes>
          <Task id="G1-T1" name="盘点事实源" status="NOT_STARTED" order="0"/>
          <Task id="G1-T2" name="盘点包边界" status="NOT_STARTED" order="1"/>
        </SubNodes>
      </TaskGroup>
      <TaskGroup id="G2" name="设计收敛" status="NOT_STARTED" order="1">
        <SubNodes>
          <Task id="G2-T1" name="形成架构方案" status="NOT_STARTED" order="0"/>
          <Task id="G2-T2" name="确认首批 track 切片" status="NOT_STARTED" order="1">
            <cdt:TrackLink state="candidate" id="add-runtime-contracts"/>
          </Task>
        </SubNodes>
      </TaskGroup>
      <TaskGroup id="G3" name="首批落地" status="NOT_STARTED" order="2">
        <SubNodes>
          <Task id="G3-T1" name="创建并执行 runtime contracts track" status="NOT_STARTED" order="0">
            <cdt:TrackLink state="candidate" id="add-runtime-contracts"/>
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
</Mission>
```

## 7. 完成输出

创建完成后回复：

```text
Mission '<mission-id>' 已创建：
- codument/missions/pending/<mission-id>/mission.xml
- codument/missions/pending/<mission-id>/proposal.md
- codument/missions/pending/<mission-id>/design.md

下一步：请使用 codument-impl-mission 启动或执行该 mission。
```
