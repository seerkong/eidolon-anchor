# codument operations 索引

本目录是 codument 各**操作的权威提示词 body**（track / implement / gap-loop / archive ...）。agent skill 安装目录中的 `SKILL.md` 只是薄壳入口，通过提示词引用本目录 `@/codument/std/operations/<op>.md` 并遵循之。

每个操作一个文件，**Markdown 为主**（标题/说明/规则/表格/示例）；**程序化的执行流程**（串行/并行/条件/循环/spawn/返回/退出）用 `--` 流程标记块（文本化控制流语言）。规范见 `_operation-spec.md`。所有引用指向 `codument/std/...` / `codument/std/sop/...`（self-contained）。

| skill | 文件 | 作用 |
|---|---|---|
| codument-init | `init.md` | 在项目初始化 codument（落盘 std/ config/ attractors/ 等） |
| codument-track | `track.md` | 创建变更追踪（behavior delta + track.xml） |
| codument-discuss | `discuss.md` | 执行前讨论/细化某 phase 的任务与调度 |
| codument-plan-schedule | `plan-schedule.md` | 规划 Schedule：标 `cdt:child-mode="dag"` + 写 `<Dag>` |
| codument-implement | `implement.md` | 按 TaskSpace + Schedule 执行任务（顺序/DAG，编排子代理） |
| codument-gap-loop | `gap-loop.md` | 有界目标对比纠偏（fresh 子代理） |
| codument-verify | `verify.md` | 独立验证实现是否达成目标 |
| codument-revise-track | `revise-track.md` | 非线性修订 track 自身产物 |
| codument-validate | `validate.md` | 校验 track.xml / spec 结构 |
| codument-status | `status.md` | 项目/track 状态总览（从 track.xml 派生） |
| codument-archive | `archive.md` | 归档 track + 提升 behavior 进 `codument/behaviors/` + 可选 artifact/memory 同步 |
| codument-artifact-sync | `artifact-sync.md` | 按 output MaterialBundle 同步制品到目标 |
| codument-docs-bootstrap | `docs-bootstrap.md` | 把现存项目总结进 docs/modeling 与 docs/impl |
| codument-migrate | `migrate.md` | 迁移旧 plan.xml→track.xml、md specs→xml、旧 archive 布局 |

> 兼容说明：旧 `plan-wave` → `plan-schedule`（Schedule 模型）；旧 `execute-wave` 并入 `implement`（Schedule 统一表达调度）；旧 `migrate-archive`+`migrate-specs` 并入 `migrate`。
> 每个 skill 的「执行套路」细节（TDD、wave 调度、gap-loop 规程等）放 `codument/std/sop/`，由 skill 用 `#call` / 文中引用。
