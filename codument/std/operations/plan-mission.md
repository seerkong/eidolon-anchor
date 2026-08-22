# skill: codument-plan-mission（创建长周期 mission）

为一个跨多个 track、需要较长时间自动化收敛的目标创建 **Mission**：生成 `mission.xnl`、`proposal.md`、`design.md`，并放入 `codument/missions/pending/<mission-id>/`。

> mission 是长周期控制面，不是大号 track。真实代码 / 规范 / 测试落地仍由 track 承担；mission 负责期望态 DAG、观察实际态、受控重规划和跨 track 编排。
>
> 文件格式见 `codument/std/spec/mission-xnl-spec.md`；流程块格式见 `codument/std/spec/flow-notation.md`。

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
  mission.xnl
  proposal.md
  design.md
  decisions.xnl       # only when the first real decision appears
  decisions/**/*.xnl  # optional owner/topic shards; read with root decisions.xnl
  memory/     # only when a reusable memory has eligible content
  analysis/   # 默认不进 git
  reports/    # 默认不进 git
```

新 mission 不创建 `roadmap.md`。

## 1.1 TrackLink 规划纪律

`TrackLink` 是 mission 对真实 codument track 的生命周期承诺，不是“相关工作”的标签。

规划 `mission.xnl` 时：

- 只有当某个叶子 `Task` 的未来操作就是创建、绑定、执行、验证或归档一个真实 track 时，才允许写 `TrackLink`。
- 如果任务只是证据盘点、设计收敛、切片讨论、写报告、验证总目标，使用普通 `Task`，不要挂 `TrackLink`。
- 如果预计直接在 mission 中完成局部实现，而不是创建 track，使用普通 `Task` 并写清楚验收与证据；不要先挂 `TrackLink` 再绕过真实 track。
- `TrackLink { state = "candidate" }` 的 `#id` 是计划中的真实 Track id。Mission auto 调用时 `codument track create ... --stage active` 直接返回 active authority，再由 `codument mission bind-track` 绑定；如果只是临时命名或议题名，不要写成 candidate。
- 同一个真实 track 的创建 / 执行任务只应有一个权威 `TrackLink`；其他任务可在描述中引用该 track id，但不要重复挂多个 candidate。

`proposal.md` 和 `design.md` 必须说明：mission 负责控制面和跨 track 编排；代码、规范、测试等落地工作由真实 track 承担。若 mission 确实包含不经 track 的直接实现任务，必须把它显式写成例外，并说明为什么不需要 track。

## 1.5 Decision-tree pass

按 `std/protocols/decision-tree.md` 处理 severity、evidence、依赖图和当前拓扑问题批次。MissionObserver 先查证，MissionPlanner 生成 decision forest，MissionReconciler 判断父子与跨分支依赖，MissionApplier 在当前模式允许时一次询问整个 ready batch；`auto` 直接记录假设并继续。

## 2. Mission ActorSet

四个标准 actor 的协议与完整的单/多项目示例只由 `std/spec/mission-xnl-spec.md` 定义。本 operation 不复制它们。

规划时必须在 `mission.xnl` materialize：

- 唯一 host 与任何 external 的路径无关 `ProjectRef`。
- 一个完整默认 `ActorSet`，每个 actor 都用 `<Description>` 写本 mission 中的具体工作方式。
- 仅在阶段确实需要不同控制工作时，使用完整 `TaskGroup actor-set` 覆盖；不逐角色 merge。

`design.md` 只记录本 mission 的控制目标、事实源、风险和重规划条件；不要重新枚举四个标准角色。跨项目 workspace path 是 invocation session 提供的 `WorkspaceBinding`，绝不写入持久产物。

## 3. 主流程

正式进入 mission 规划前，直接读取相关项目 attractor、代码、行为和现有 mission/track 作为约束上下文。只有 `operation-hooks.xnl` 显式为 `plan-mission:before` 配置 hook 时才执行 fresh AttractorCheck。

```text
@delimiter: --
@node: #
@marker: ?
-- #sequence ?plan_mission
---- #if ?before cond="operation-hooks.xnl 为 plan-mission 显式配置了 plan-mission:before"
执行显式 plan-mission:before hook
---- /?before
---- #step ?context
确认 codument 已初始化；读取 codument/attractors、codument/missions/README.md、codument/std/spec/mission-xnl-spec.md；解析 questioning severity（mission 建议默认 `auto`：用户未指定且目标是长时间自主迭代时用 `auto`；用户明确要求深挖 / 大量人工介入时才降级 `normal`/`deep`）。
---- /?context
---- #step ?decision-tree
先在规划上下文中识别真实决策；auto 模式不提问，普通假设写入 `analysis/findings.md` 或 `design.md`。首次需要复杂前沿工作记忆时运行 `codument decisions create <mission-dir>/analysis/decision-tree.xnl <decision-id>`，再按当前 Decision spec 填写语义；随后运行 `codument decisions validate <file>` 与 `codument decisions frontier <file> --json`，按 CLI 返回的 ready batch 继续。
---- /?decision-tree
---- #step ?id
根据用户目标生成 mission-id；查重 pending/active/archived；auto 模式直接采用并记录命名依据，其他模式只有命名确实影响范围或存在歧义时才将其并入当前拓扑 ready batch，不单独等待确认。
---- /?id
---- #step ?mkdir
运行 `codument mission create <mission-id> --stage pending`，只传 ID 与 stage，由 CLI 创建当前 Kind `apiVersion` 对应的 `mission.xnl`、`proposal.md`、`design.md`，后续使用 receipt 返回的 `<mission-dir>`。随后按需创建 analysis/ reports/；首次出现真实 decision 时运行 `codument decisions create <mission-dir>/decisions.xnl <decision-id>`，无 decision 时不落空文件。只有产生合格 reusable 内容时才创建 memory/。
---- /?mkdir
---- #step ?proposal
写 proposal.md：背景、目标、非目标、成功判据、为什么需要 mission 而不是 track。
---- /?proposal
---- #step ?design
写 design.md：控制目标、事实源、plan vs track 区分、受控重规划、人工介入和风险；标准 actor 协议引用 Mission XNL spec，不复制定义。
---- /?design
---- #step ?xnl
在 CLI 已生成的 mission.xnl 骨架内填写根 `{}`、Ports、ProjectRefs、ActorSets、TaskSpace、Schedule 与 Hooks；保留 scaffold 写入的 `#id`、`apiVersion`、`version` 和 XNL 通道。只有真实 track 生命周期任务才挂 TrackLink。
---- /?xnl
---- #step ?validate
运行 `codument validate <mission-id> --strict`，校验 Mission Kind 与领域规则。
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

- desired state：mission.xnl 的顶层 TaskGroup DAG、组内顺序 Task、节点状态、门禁和叶子 Task 上的 `TrackLink`。
- actual state：当前 mission 文件、track 状态、archive、测试结果、reports、用户新约束。
- actuation：创建/续跑/归档 track，或受控修订 mission.xnl。
- feedback / drift：reports、verify、用户介入、失败证据。

## 受控重规划

active mission 可以增删改节点和 DAG，但必须有 evidence 或 human decision，并写 reports/replan-XXX.md。
```

## 6. XNL authoring

完整 XNL 结构、字段约束与 canonical examples 只在 `std/spec/mission-xnl-spec.md` 维护。创建 mission 时必须先调用 CLI scaffold，再按该规范填充语义内容；不要手工拼根骨架。

## 7. 完成输出

创建完成后回复：

```text
Mission '<mission-id>' 已创建：
- codument/missions/pending/<mission-id>/mission.xnl
- codument/missions/pending/<mission-id>/proposal.md
- codument/missions/pending/<mission-id>/design.md

下一步：请使用 codument-impl-mission 直接执行该 mission。
```
