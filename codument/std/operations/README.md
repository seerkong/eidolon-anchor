# codument operations 索引

本目录是 codument 各 **operation 的权威提示词 body**（track / implement / gap-loop / archive ...）。agent skill 安装目录中的 `SKILL.md` 只是薄壳入口，通过提示词引用本目录 `@/codument/std/operations/<operation>.md` 并遵循之。

每个 operation 一个文件，**Markdown 为主**（标题/说明/规则/表格/示例）；**程序化的执行流程**（串行/并行/条件/循环/spawn/返回/退出）用 `--` 流程标记块（文本化控制流语言）。规范见 `_operation-spec.md`。所有引用指向 `codument/std/...` / `codument/std/methods/...`（self-contained）。

| skill | 文件 | 作用 |
|---|---|---|
| codument-impl-quick | `impl-quick.md` | 基于 Codument 上下文快速实现小改动，不创建 track/mission |
| codument-discuss | `discuss.md` | 创建 track/mission 前的人机讨论与 quick/track/mission 分流 |
| codument-plan-track | `plan-track.md` | 创建变更追踪（behavior delta + track.xnl） |
| codument-maintain-track | `maintain-track.md` | 以 `discuss-phase`、`revise` 或 `schedule` 模式维护既有 track |
| codument-impl-track | `impl-track.md` | 按 TaskSpace + Schedule 执行任务（顺序/DAG，AI 自主本地或委派） |
| codument-gap-loop | `gap-loop.md` | 有界目标对比纠偏（fresh 子代理） |
| codument-verify | `verify.md` | 独立验证实现是否达成目标 |
| codument-validate | `validate.md` | 校验 Track、Mission、Behavior、BehaviorPatch 与 Decision resource |
| codument-archive-track | `archive-track.md` | 归档 track + transactionally 提升 behavior 与完整 XNL decision registry + 可选 artifact/memory 同步 |
| codument-plan-mission | `plan-mission.md` | 创建长周期 mission（mission.xnl + proposal.md + design.md） |
| codument-impl-mission | `impl-mission.md` | 按 mission.xnl DAG 执行 mission，支持控制论 actor loop 与受控重规划 |
| codument-archive-mission | `archive-mission.md` | 归档 mission 到 `missions/archived/YYYY-MM-DD-<mission-id>/` |
| codument-artifact-sync | `artifact-sync.md` | 按 output MaterialBundle 同步制品到目标 |
| codument-docs-bootstrap | `docs-bootstrap.md` | 把现存项目总结进 codument/modeling 与 codument/engineering |
| codument-migrate | `migrate.md` | 通过统一 resource migration pipeline 升级 legacy authority |

CLI 确定性能力：`track|mission|behavior-patch|decisions create` 生成版本骨架，`track|mission transition` 与 `task transition` 写生命周期，`decisions frontier` 计算问题前沿，`validate` 做结构校验，`upgrade-resource` 做版本迁移，`archive` 执行 registry transaction 与路径变更，`artifact sync` 分发制品树，`modeling|engineering validate|lint` 管理知识登记表。operation body 负责编写业务内容、执行显式 hook 与 AI 语义 review，不重复实现已有 CLI 逻辑。

> 兼容说明见 `../compat/README.md`。当前 operation 只引用当前名称；历史 `discuss-phase`、`revise-track`、`plan-track-wave` 已合并为 `maintain-track`。
> 每个 skill 的「执行套路」细节（TDD、wave 调度、gap-loop 规程等）放 `codument/std/methods/`，由 skill 用 `#call` / 文中引用。
