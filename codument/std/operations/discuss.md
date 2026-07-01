# skill: codument-discuss（创建 track/mission 前的上下文讨论）

在还没有决定要 quick、track 还是 mission 前，先基于 Codument owner 知识和项目工程文件做一次轻量上下文搜集、问题树澄清与任务尺度分流。

> 本 operation 不创建 track、mission、discussion workspace，也不创建 `codument/discussions/`。讨论内容和临时决策主要留在 AI agent 上下文；只有必要的临时 analysis 写入 `codument/analysis/`，并在每次 discuss 开始和转入 plan 前清理。

## 0. 定位

`codument-discuss` 是 pre-plan 讨论入口：

- 不修改源码。
- 不创建 track/mission。
- 不写 proposal/design/behavior delta。
- 不持久化 discussion workspace。
- 输出一个明确建议：`quick | track | mission | blocked`。

如果目标 track 已存在、用户要细化某个 phase，使用 `codument-discuss-phase`。

## 1. 临时 analysis 生命周期

每次触发 `codument-discuss`：

1. 删除旧的 `codument/analysis/`。
2. 创建新的 `codument/analysis/`。
3. 可写入：
   - `context.md`：代码、测试、behavior/modeling/engineering、archive、mission/track 扫描摘要。
   - `decision-tree.md`：Root Question、QuestionSeverity、Decision Frontier、Assumptions。
   - `recommendation.md`：route、理由、下一步命令、未决问题。
4. 如果用户同意进入 `codument-plan-track` 或 `codument-plan-mission`，在开始创建前再次删除 `codument/analysis/`。

`codument/analysis/` 是 scratch，不是 owner 真源；稳定结论应在后续 quick/track/mission 中按知识层级进入 `codument/modeling`、`codument/engineering`、`behaviors`、`decisions` 或 memory。

## 2. 上下文搜集

先执行命令级前置 hook：若 `operation-hooks.xml` 为 `discuss:before` 配了 `<cdt:AttractorCheck use="coding"/>`，读取 `coding` profile 和其引用的 attractors。

然后读取：

- `codument/attractors/` 与 `codument/std/attractors/`。
- `codument/behaviors/`。
- `codument/modeling/` 与 `codument/engineering/`（如果存在）。
- `codument/decisions/`、`codument/memory/`。
- 当前 active tracks、missions、archive 中相关历史。
- 相关源码、测试、配置和文档。

## 3. Questioning

使用 `codument/std/sop/questioning.md` 的 severity：

| severity | 行为 |
|---|---|
| `auto` | 不提问，直接基于证据给 route 和保守假设。 |
| `light` | 默认，只问 P0 用户意图或不可逆取舍。 |
| `normal` | 可问 P0/P1，每题给推荐答案与取舍。 |
| `deep` | 适合不确定性大的方向探索，但仍必须把 frontier 收敛到下一步 route。 |

## 4. 分流规则

| route | 条件 | 下一步 |
|---|---|---|
| `quick` | 小范围 bug、测试、局部重构、配置修正；不引入新行为契约和长期规划对象 | `codument-impl-quick` |
| `track` | 新能力、行为变化、架构/模式调整、风险较高或需要 proposal/design/behavior delta | `codument-plan-track` |
| `mission` | 跨多个 track/仓库，长期自动化，执行期需要重规划 | `codument-plan-mission` |
| `blocked` | 关键信息缺失、权限/环境不可用、用户目标冲突 | 先补证据或请求用户决策 |

## 5. 输出格式

最终回复必须包含：

```text
route: quick|track|mission|blocked
reason:
suggested_next_command:
evidence_read:
open_questions:
analysis_files:
```

如果 route 是 `track` 或 `mission`，开始 planning 前清理 `codument/analysis/`。

## 引用

- `codument/std/sop/questioning.md`
- `codument/std/operations/plan-track.md`
- `codument/std/operations/plan-mission.md`
- `codument/std/operations/impl-quick.md`
- `codument/std/attractors/knowledge-tiers.md`
