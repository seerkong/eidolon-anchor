# skill: codument-discuss（创建 track/mission 前的人机讨论）

`codument-discuss` 是 **pre-plan 对话入口**：在还没有决定要 quick、track 还是 mission 前，先读取必要上下文，然后和用户讨论目标、边界、取舍与下一步。

> 关键原则：这是一次**对话**，不是一次报告生成。不要用生成文件代替和用户来回澄清。

## 0. 定位

`codument-discuss`：

- 必须与用户进行讨论、提问、确认或澄清，除非用户显式要求 `QuestionSeverity=auto` / 无问答。
- 不修改源码。
- 不创建 track/mission。
- 不写 proposal/design/behavior delta。
- 不创建 `codument/discussions/` 或任何 discussion workspace。
- 不把 route、决策树、推荐命令做成固定产物文件。
- 输出一个对话中的下一步建议：`quick | track | mission | blocked`。

如果目标 track 已存在、用户要细化某个 phase，使用 `codument-maintain-track` 的 `discuss-phase` mode。

## 1. 临时 analysis 生命周期

每次触发 `codument-discuss`：

1. 删除旧的 `codument/analysis/`。
2. 创建新的 `codument/analysis/`。
3. 只在确有必要时写入类似 track/mission analysis 的临时材料：
   - `findings.md`：从代码、测试、behavior/modeling/engineering、archive、mission/track 中读到的证据。
   - `knowledge.md`：讨论中尚未稳定、仅供本轮继续推理的临时知识草稿。
4. 不在 `codument/analysis/` 中保存聊天记录、最终推荐报告、正式决策或待创建的 proposal/design。
5. 如果用户同意进入 `codument-plan-track` 或 `codument-plan-mission`，在开始创建前再次删除 `codument/analysis/`。

`codument/analysis/` 是 scratch，不是 owner 真源；稳定结论应在后续 quick/track/mission 中按知识层级进入 `codument/modeling`、`codument/engineering`、`behaviors`、`decisions` 或 memory。

## 2. 上下文搜集

直接读取与讨论目标相关的项目约束和现有资料；仅当 `action-hooks.xml` 显式为 `discuss:before` 配置 `<cdt:AttractorCheck>` 时才执行 fresh check。

按需求相关性读取：

- `codument/attractors/` 与 `codument/std/attractors/`。
- `codument/behaviors/`。
- `codument/modeling/` 与 `codument/engineering/`（如果存在）。
- `codument/decisions/`、`codument/memory/`。
- 当前 active tracks、missions、archive 中相关历史。
- 相关源码、测试、配置和文档。

上下文搜集是为了提出更好的问题和建议，不是为了直接结束讨论。

## 3. 对话协议

使用 `codument/std/protocols/questioning.md` 的 severity：

| severity | 行为 |
|---|---|
| `auto` | 不提问，直接基于证据给 route 和保守假设。仅当用户显式要求高自主/无问答时使用。 |
| `light` | 默认。至少做一轮面向人的澄清；只问 P0 用户意图或不可逆取舍。 |
| `normal` | 可问 P0/P1，每题给推荐答案与取舍。 |
| `deep` | 适合不确定性大的方向探索，可多轮对话，但仍必须把 frontier 收敛到下一步 route。 |

默认 `light` 模式下，不要在第一次响应就直接写“已完成分流分析”。推荐流程：

1. 简短说明已经读取或将读取的关键上下文。
2. 给出当前初步判断，但标明它是“初步”。
3. 按 `decision-tree.md` 的拓扑 ready batch 向用户提出 1-3 个真正影响方案的问题；同批独立方向一起问，每题带推荐选项和取舍。
4. 根据用户答复继续收敛，直到能给出 route。

## 4. 分流规则

| route | 条件 | 下一步 |
|---|---|---|
| `quick` | 小范围 bug、测试、局部重构、配置修正；不引入新行为契约和长期规划对象 | `codument-impl-quick` |
| `track` | 新能力、行为变化、架构/模式调整、风险较高或需要 proposal/design/behavior delta | `codument-plan-track` |
| `mission` | 跨多个 track/仓库，长期自动化，执行期需要重规划 | `codument-plan-mission` |
| `blocked` | 关键信息缺失、权限/环境不可用、用户目标冲突 | 先补证据或请求用户决策 |

## 5. 对话输出

当讨论收敛时，最终回复在对话中给出：

```text
route: quick|track|mission|blocked
reason:
suggested_next_command:
evidence_read:
open_questions:
temporary_analysis_notes:
```

如果 route 是 `track` 或 `mission`，开始 planning 前清理 `codument/analysis/`。

## 引用

- `codument/std/protocols/questioning.md`
- `codument/std/actions/plan-track.md`
- `codument/std/actions/plan-mission.md`
- `codument/std/actions/impl-quick.md`
- `codument/std/attractors/knowledge-tiers.md`
