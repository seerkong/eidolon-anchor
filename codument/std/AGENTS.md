# Codument 使用指南（std/AGENTS.md）

AI 编程助手用 Codument 做行为驱动开发的**入口与路由**。本文件只做路由 + 速查；**怎么操作**的过程在 `std/sop/`，**格式规范**在 `std/spec/`，**各 skill** 在 `std/operations/`。init 后全部自包含于 `codument/`。

## 何时打开本指南

- 提到 planning / proposal / track（proposal、behavior、change、plan、track、implement）
- 新增能力、破坏性变更、架构/模式调整、性能/安全工作
- 需求模糊、需要权威行为规范再动手
- 用户补充需求属于某进行中 track 范围

## 路由表

| 你要做的事 | 去读 |
|---|---|
| 了解工作流程总纲 | `std/sop/workflow.md` |
| **一条信息该落哪层 / 何时晋升 / 冲突谁赢** | `attractors/knowledge-tiers.md`（分层 + 信息晋升 + 真源优先级） |
| 某标准文件夹"装什么" / 给目录补职责说明 | `std/spec/folder-manifest.md`（目录职责自描述 + 补齐机制） |
| 选下一个该做的任务（候选 + 自主度） | `backlog/README.md` |
| 规划跨多个 track 的路线 / mission | `missions/README.md` |
| 长期记忆（lessons/incidents/patterns） | `attractors/project-memory.md` + `memory/`（memory profile） |
| docs/ 怎么写（modeling/impl 分形、frontmatter） | `attractors/model-driven-docs.md` → `std/docs-{modeling,impl}-fractal/index.md` |
| 怎么提问/确认/纠偏（协议） | `std/sop/questioning.md`、`std/sop/validation.md` |
| 执行套路（TDD / wave 调度 / 归档 / 同步） | `std/sop/{tdd,wave-exec,gap-loop,archive,artifact-sync}.md` |
| track 文件（track.xml）格式 | `std/spec/track-xml-spec.md` |
| 怎么写 behavior delta / behavior 登记表格式 | `std/spec/behavior-delta.md`、`std/spec/behavior-registry.md` |
| 具体某个操作怎么做 | `std/operations/<name>.md`（索引见 `std/operations/README.md`） |
| 命令级 hook、attractor profile、能力开关 | `config/operation-hooks.xml`、`config/attractor-profiles.xml` |

## 三阶段（详见 std/sop/workflow.md）

1. **创建 track**：`codument-track` → behavior delta（`behavior_deltas/`）+ proposal + `track.xml`（TaskSpace/Schedule/Hooks）。
2. **实现**：`codument-discuss` / `codument-plan-schedule` / `codument-implement`，按需 `codument-gap-loop` / `codument-verify` / `codument-revise-track`。
3. **归档**：`codument-archive` → 提升 behavior 进 `codument/behaviors/`、移入 `archive/`、按显式 hook 同步 artifact/docs。

## 知识沉淀与晋升（务必，详见 attractors/knowledge-tiers.md）

codument 是 **track 中心**的：迭代记忆强，但 **owner 文档（`docs/modeling`/`docs/impl`）的维护是弱环**，要刻意补强：

- **file-in/file-out**：重要输入/结论落文件，别只留 chat；按职责分类写回（见分层表）。
- **实时维护，不只归档**：澄清（discuss）期一旦某概念/行为/policy/架构**稳定**，**当轮就**收敛进 `docs/modeling`/`docs/impl`，不要拖到归档才补、也不要只留在 proposal。
- **晋升阶梯**：track → `behaviors/`（行为，归档必做）/ `docs/modeling·impl`（稳定领域知识）/ `decisions/`（承重决策）/ `memory/`（复用教训）；`memory` 中**反复复发**的再固化为 sop/skill/check。触发条件见 knowledge-tiers.md §5。
- **新建目录自带职责**：在 docs/ 下新建文件夹时，按 `std/spec/folder-manifest.md` 给它写"目录职责"块（或跑补齐）。

## skill 入口（优先用 skill）

```
请使用 codument-track skill, 创建 track: <track-id>
请使用 codument-discuss / codument-plan-schedule / codument-implement skill, 处理 track: <track-id>
请使用 codument-gap-loop / codument-verify / codument-revise-track skill, 校验/验证/修订 track: <track-id>
请使用 codument-archive / codument-validate / codument-status skill
请使用 codument-docs-bootstrap / codument-artifact-sync / codument-migrate skill
```

## CLI 速查

```bash
codument list [--behaviors]      # 列活跃 track / 行为登记表
codument show [item] [--json]
codument validate [item] [--strict]
codument archive <track-id>
codument init [path] / upgrade-workspace / upgrade-track <id> / status
```

> 外部 CLI 回退：若提示词要求运行 `codument validate ...` 但系统无 `codument` 命令，跳过该步并明确说明已跳过（不阻塞工作流）。详见 `std/sop/workflow.md`。
