# Codument 使用指南（std/AGENTS.md）

AI 编程助手用 Codument 做行为驱动开发的**入口与路由**。本文件只做路由 + 速查；**怎么操作**的过程在 `std/methods/`，**格式规范**在 `std/spec/`，**各 skill** 在 `std/actions/`。init 后全部自包含于 `codument/`。

## 何时打开本指南

- 提到 planning / proposal / track / mission（proposal、behavior、change、plan、track、mission、implement）
- 新增能力、破坏性变更、架构/模式调整、性能/安全工作
- 需求模糊、需要权威行为规范再动手
- 用户补充需求属于某进行中 track 范围

## 路由表

| 你要做的事 | 去读 |
|---|---|
| 了解工作流程总纲 | `std/methods/workflow.md` |
| **一条信息该落哪层 / 何时晋升 / 冲突谁赢** | `std/attractors/knowledge-tiers.md`（分层 + 信息晋升 + 真源优先级） |
| 某标准文件夹"装什么" / 给目录补职责说明 | `std/spec/folder-manifest.md`（目录职责自描述 + 补齐机制） |
| 选下一个该做的任务（候选 + 自主度） | `backlog/README.md` |
| 规划跨多个 track 的路线 / mission | `missions/README.md`、`std/spec/mission-xml-spec.md` |
| 长期记忆（lessons/incidents/patterns） | `std/attractors/project-memory.md` + `memory/`（memory profile） |
| engineering/modeling 长期知识 registry 怎么写 | `std/spec/{modeling,engineering}-registry.md`、`std/spec/{modeling,engineering}-node-schema.md` |
| modeling / engineering 长期知识怎么写（分形、路由、元数据） | `std/attractors/model-driven-docs.md` → `std/skill/docs-{modeling,engineering}-fractal/index.md` |
| 怎么提问/确认/纠偏（协议） | `std/protocols/decision-tree.md`、`std/protocols/questioning.md`、`std/protocols/validation.md` |
| 执行套路（TDD / DAG 调度 / workflow） | `std/methods/{tdd,dag-execution,workflow}.md` |
| track 文件（track.xml）格式 | `std/spec/track-xml-spec.md` |
| mission 文件（mission.xml）格式 | `std/spec/mission-xml-spec.md` |
| 流程标记块（flow notation）格式 | `std/spec/flow-notation.md` |
| 怎么写 behavior delta / behavior 登记表格式 | `std/spec/behavior-delta.md`、`std/spec/behavior-registry.md` |
| 怎么写 engineering delta / engineering 登记表格式 | `std/spec/engineering-delta.md`、`std/spec/engineering-registry.md` |
| 具体某个 action 怎么做 | `std/actions/<name>.md`（索引见 `std/actions/README.md`） |
| 命令级 hook、attractor profile、能力开关 | `config/action-hooks.xml`、`config/attractor-profiles.xml` |

## 三阶段（详见 std/methods/workflow.md）

0. **小改动**：`codument-impl-quick` → 读取 Codument 上下文后直接实现；若超出 quick 范围则转 track/mission。
1. **创建 track 前讨论**：`codument-discuss` → 与用户讨论、搜集上下文并分流到 quick / track / mission / blocked。
2. **创建 track**：`codument-plan-track` → behavior delta（`behavior_deltas/`）+ proposal + `track.xml`（TaskSpace/Schedule/Hooks）。
3. **实现**：`codument-maintain-track`（按 mode 细化、修订或调度）/ `codument-impl-track`，按需 `codument-gap-loop` / `codument-verify`。
4. **归档**：`codument-archive-track` → 提升 behavior 进 `codument/behaviors/`、移入 `tracks/archived/`、按显式 hook 同步 artifact/docs。

mission 是更长周期的控制面对象：

1. **创建 mission**：`codument-plan-mission` → `codument/missions/pending/<id>/mission.xml` + `proposal.md` + `design.md`。
2. **执行 mission**：`codument-impl-mission` → 按 `mission.xml` DAG + MissionPlanner/Observer/Reconciler/Applier 控制论 actor loop 推进，允许受控重规划。
3. **归档 mission**：`codument-archive-mission` → 移入 `codument/missions/archived/YYYY-MM-DD-<id>/`，按条件提升 decisions/memory。

## 知识沉淀与晋升（务必，详见 std/attractors/knowledge-tiers.md）

codument 是 **track 中心**的：迭代记忆强，但 **owner registry（`codument/modeling`/`codument/engineering`）的维护是弱环**，要刻意补强：

- **file-in/file-out**：重要输入/结论落文件，别只留 chat；按职责分类写回（见分层表）。
- **实时维护，不只归档**：澄清（discuss）期一旦某概念/行为/policy/架构**稳定**，**当轮就**收敛进 `codument/modeling` / `codument/engineering` 的 delta，不要拖到归档才补、也不要只留在 proposal。
- **晋升阶梯**：track → `behaviors/`（行为，归档必做）/ `codument/modeling`（结构真源）/ `codument/engineering`（工程知识真源）/ `decisions/`（承重决策）/ `memory/`（复用教训）；`memory` 中**反复复发**的再固化为 method/skill/check。触发条件见 knowledge-tiers.md §5。
- **新建目录自带职责**：在 docs/ 下新建文件夹时，按 `std/spec/folder-manifest.md` 给它写"目录职责"块（或跑补齐）。

## skill 入口（优先用 skill）

```
请使用 codument-plan-track skill, 创建 track: <track-id>
请使用 codument-discuss skill, 讨论尚未确定 quick/track/mission 的需求
请使用 codument-impl-quick skill, 快速实现小改动
请使用 codument-maintain-track / codument-impl-track skill, 处理 track: <track-id>
请使用 codument-gap-loop / codument-verify skill, 校验/验证 track: <track-id>
请使用 codument-archive-track / codument-validate skill
请使用 codument-plan-mission / codument-impl-mission / codument-archive-mission skill
请使用 codument-docs-bootstrap / codument-artifact-sync / codument-migrate skill
```

## CLI 速查

```bash
codument list [--behaviors]      # 列活跃 track / 行为登记表
codument show [item] [--json]
codument validate [item] [--strict]
codument archive <track-id>
codument modeling validate|lint
codument engineering validate|lint
codument init [path] / upgrade-workspace / upgrade-track <id> / status
```

> 外部 CLI 回退：若提示词要求运行 `codument validate ...` 但系统无 `codument` 命令，跳过该步并明确说明已跳过（不阻塞工作流）。详见 `std/methods/workflow.md`。
