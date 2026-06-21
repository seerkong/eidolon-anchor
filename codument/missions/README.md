# codument/missions —— 跨 track 路线图

> 目录职责 · holds: 跨多个 track 的 mission/roadmap、阶段目标、track 编排关系、进度证据 · excludes: 单次变更需求(→tracks/<id>/proposal.md)、执行状态(→track.xml)、长期 owner 真源(→docs/behaviors/decisions/memory) · tier: 活的路线层（就地改，非行为真源） · ⬆from: backlog/用户战略目标/复盘 · ⬇to: 多个 tracks

本目录用于表达**一组相关 track 的长期路线**。当一个目标无法在单个 track 内安全完成，或需要 P0/P1/P2... 分阶段推进时，建立一个 mission：

```text
missions/<mission-id>/
  roadmap.md
```

`roadmap.md` 记录：

- mission 目标、Non-Goals、约束与成功判据；
- 阶段切分与每阶段对应的 track id；
- track 间依赖、交付顺序与可并行点；
- 当前进度、阻塞、移交项；
- 每个阶段完成后的关键证据链接（track reports / findings / archive）。

## 使用规则

- mission 只回答"多个 track 如何排布"，不替代单个 track 的 proposal/design/track.xml。
- 选中某个阶段真正执行时，必须创建或续跑对应 `tracks/<id>/`。
- 每个 track 完成/归档后，更新 mission 的进度、证据链接和下一阶段判断。
- 发现稳定领域知识、承重决策、复用教训时，仍按 `attractors/knowledge-tiers.md` 晋升到 owner 层；不要让 mission 成为长期知识垃圾桶。

## roadmap.md 骨架

```md
# <mission-id>

## 目标

- ...

## Non-Goals

- ...

## 阶段路线

| 阶段 | track | 目标 | 依赖 | 状态 | 证据 |
|---|---|---|---|---|---|
| P0 | `<track-id>` | `<目标>` | `<无/track-id>` | planned | `<links>` |

## 当前判断

- 下一步：
- 阻塞：
- 风险：

## 移交项

- ...
```
