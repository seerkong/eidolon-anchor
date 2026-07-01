# codument operations 索引

本目录是 codument 各**操作的权威提示词 body**（track / implement / gap-loop / archive ...）。agent skill 安装目录中的 `SKILL.md` 只是薄壳入口，通过提示词引用本目录 `@/codument/std/operations/<op>.md` 并遵循之。

每个操作一个文件，**Markdown 为主**（标题/说明/规则/表格/示例）；**程序化的执行流程**（串行/并行/条件/循环/spawn/返回/退出）用 `--` 流程标记块（文本化控制流语言）。规范见 `_operation-spec.md`。所有引用指向 `codument/std/...` / `codument/std/sop/...`（self-contained）。

| skill | 文件 | 作用 |
|---|---|---|
| codument-impl-quick | `impl-quick.md` | 基于 Codument 上下文快速实现小改动，不创建 track/mission |
| codument-discuss | `discuss.md` | 创建 track/mission 前的上下文搜集与 quick/track/mission 分流 |
| codument-plan-track | `plan-track.md` | 创建变更追踪（behavior delta + track.xml） |
| codument-discuss-phase | `discuss-phase.md` | 执行前讨论/细化某 phase 的任务与调度 |
| codument-plan-track-wave | `plan-track-wave.md` | 规划 Schedule：标 `cdt:child-mode="dag"` + 写 `<Dag>` |
| codument-impl-track | `impl-track.md` | 按 TaskSpace + Schedule 执行任务（顺序/DAG，编排子代理） |
| codument-gap-loop | `gap-loop.md` | 有界目标对比纠偏（fresh 子代理） |
| codument-verify | `verify.md` | 独立验证实现是否达成目标 |
| codument-revise-track | `revise-track.md` | 非线性修订 track 自身产物 |
| codument-validate | `validate.md` | 校验 track.xml / spec 结构 |
| codument-archive-track | `archive-track.md` | 归档 track + 提升 behavior 进 `codument/behaviors/` + 可选 artifact/memory 同步 |
| codument-plan-mission | `plan-mission.md` | 创建长周期 mission（mission.xml + proposal.md + design.md） |
| codument-impl-mission | `impl-mission.md` | 按 mission.xml DAG 执行 mission，支持控制论 actor loop 与受控重规划 |
| codument-archive-mission | `archive-mission.md` | 归档 mission 到 `missions/archived/YYYY-MM-DD-<mission-id>/` |
| codument-artifact-sync | `artifact-sync.md` | 按 output MaterialBundle 同步制品到目标 |
| codument-docs-bootstrap | `docs-bootstrap.md` | 把现存项目总结进 docs/modeling 与 docs/impl |
| codument-migrate | `migrate.md` | 迁移旧 plan.xml→track.xml、md specs→xml、旧 archive 布局 |

CLI 辅助命令（非 skill body）：`codument init` 初始化工作区；`codument status` 显示项目状态；`codument modeling validate|lint` 管理 `codument/modeling/`；`codument engineering validate|lint` 管理 `codument/engineering/`。

> 兼容说明：旧 `codument-plan-schedule` → `codument-plan-track-wave`（Schedule 模型）；旧 `execute-wave` 并入 `impl-track`（Schedule 统一表达调度）；旧 `migrate-archive`+`migrate-specs` 并入 `migrate`。
> 每个 skill 的「执行套路」细节（TDD、wave 调度、gap-loop 规程等）放 `codument/std/sop/`，由 skill 用 `#call` / 文中引用。
