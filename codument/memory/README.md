# codument/memory —— 长期项目记忆

> 目录职责 · holds: 跨 track 的耐久 lessons/incidents/patterns/summaries · excludes: 任务日志(→track reports)、behaviors/docs/源码里的事实、未解决的猜测 · tier: stable·追加（每条目录自包含，无全局 index） · ⬆from: track 复盘提供的候选 · ⬇to: 复发的固化为 sop/skill/check

记忆规则、类别语义、提升判定见吸引子 [attractors/project-memory.md](../attractors/project-memory.md)；分层与晋升阶梯见 [attractors/knowledge-tiers.md](../attractors/knowledge-tiers.md)。

## 结构

```text
memory/<category>/YYYY-MM/YYYY-MM-DD-HHmm-slug/   # category ∈ lessons|incidents|patterns|summaries
```

每条目录自包含；**不建全局 `index.md`**（跨分支会冲突）。归档时若该 track 无耐久教训，不造条目。仅当 `memory` profile 启用且 track 显式给出候选时才提升（见 `std/sop/archive.md`）。
