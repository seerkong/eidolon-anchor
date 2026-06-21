# codument/backlog —— 候选工作清单 + AI 自主度

> 目录职责 · holds: 跨 track 的候选工作项 + 优先级 + AI 自主度标签 · excludes: 需求(→track proposal)、owner 真源(→docs/behaviors)、执行计划(→track.xml) · tier: 活的工作面（就地改、不带日期，非真源） · ⬆from: 用户/复盘提出的下一步 · ⬇to: 选中后开 track

本目录是 codument 对 AGE `docs/backlog/` 的对应物：一份**活的、可变的**"下一步该做什么"清单。它**不替代** track 的 proposal/behavior_deltas（需求）、`docs/`+`behaviors/`（owner 真源）、`track.xml`（执行计划），只用来**选下一个 track**。

## 工作项表

| 优先级 | 工作项 | 关联 behavior/需求 | owner 文档 | track | 状态 | AI 自主度 | 阻塞 | 最后检查 |
|---|---|---|---|---|---|---|---|---|
| P0 | `<一句话>` | `behaviors/<cap>` 或 `<待澄清>` | `docs/...` 或 `<无>` | `tracks/<id>` 或 `<未开>` | `needs-track` | `blocked` | `<占位未替换>` | `<YYYY-MM-DD>` |

## AI 自主度（沿用 codument 校验/审查语义）

- `implement` — 已读关联需求/owner 文档/校验命令后可直接开 track 并实现。
- `plan-first` — 可起草 track.xml，但实现前要过校验（cdt:GapLoop/HumanConfirm）或受保护区批准。
- `ask-first` — 改代码/用户可见行为前必须先问。
- `research-only` — 只能调研/总结/提选项，不改产品行为。
- `blocked` — 阻塞未解前不动。

## ready 不变量（可被选中执行的前提）

`ready` 当且仅当：
- 关联 behavior/需求已明确、有可测验收（或能在开 track 的澄清里立刻定清）；
- owner 文档存在且对该 slice 不是已知 stale（见 `knowledge-tiers.md` 新鲜度）；
- 不触发受保护区（破坏性/数据/权限/外部集成）或已有批准路径；
- 阻塞为空或显式标注非阻塞。

## 选择规则

用户让"继续"但没点名任务时：选**优先级最高、自主度=`implement`、无阻塞**的工作项开 track。无安全 `implement` 项时，总结最高优先级的 `blocked`/`plan-first`/`ask-first` 项并请用户定夺。AI 可凭证据把 `ready` 降级为 `needs-*`/`blocked`；**不得**在无人确认下把项升为 `ready`、把自主度调成 `implement`、或清除阻塞。

> 本文件是单一可变清单（就地改），不要按日期拆分；跨 track 复发的教训应进 `memory/`，稳定真源应进 `docs/`/`behaviors/`，都不留在这里。
