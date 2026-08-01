# skill: codument-archive-mission（归档 mission）

归档一个已完成、取消、废弃或被替代的 mission。归档会把 mission 从 `pending/` 或 `active/` 移入 `archived/YYYY-MM-DD-<mission-id>/`，并按配置提升 durable decisions / memory。

> 本 operation 复用 `codument-archive-track` 的收口经验，但 mission 不提升 behavior delta。mission 是长周期控制面；behavior 真源仍由各落地 track 归档时提升。

## 1. 前置

- 优先归档 `codument/missions/active/<mission-id>/`。
- 如果用户明确要求，也可以归档 pending / cancelled / superseded mission。
- 未完成 active mission 归档前必须确认。

## 2. 主流程

```text
@delimiter: --
@node: #
@marker: ?
-- #sequence ?archive_mission
---- #step ?select
定位 mission：优先 active/<mission-id>，其次 pending/<mission-id>；若已在 archived 则停止。
---- /?select
---- #step ?precheck
读取 mission.xml Metadata.Status；completed/cancelled/superseded 可直接归档，active 未完成则请求用户确认。
---- /?precheck
---- #step ?validate
best-effort 校验 mission.xml XML 格式、必备 proposal.md/design.md、reports/mission-complete.md 或等价收口证据。
---- /?validate
---- #step ?track_precheck
扫描 mission.xml 中所有 `cdt:TrackLink state="bound"`：通过 id 解析 active track（codument/tracks/active/<id>/track.xml）或 archived track（codument/tracks/archived/**/<timestamp>-<id>/track.xml）。若存在 active 或 missing 的 bound track，issues-first 列出并请求用户选择：逐个调用 codument-archive-track 归档 eligible active tracks、保留不归档并继续、或停止归档。
---- /?track_precheck
---- #step ?promote_decisions
若 decisions/ 中有 durable 决策，按 knowledge-tiers 与 archive-track 经验提升到 codument/decisions/。
---- /?promote_decisions
---- #step ?promote_memory
若 memory profile enabled 且 memory/ 中有候选，按类别提升 memory。
---- /?promote_memory
---- #step ?move
移动到 codument/missions/archived/YYYY-MM-DD-<mission-id>/。
---- /?move
---- #step ?finish
宣布归档路径；提示 mission 不提升 behavior，behavior 已由落地 tracks 各自归档。
---- /?finish
-- /?archive_mission
```

## 3. 归档路径

```text
codument/missions/archived/YYYY-MM-DD-<mission-id>/
```

日期使用执行归档当天的本地日期。若目标路径已存在，追加 `-2`、`-3`。

## 4. 不做事项

- 不把 mission 当作 behavior delta 提升。
- 不删除 analysis / reports。
- 不静默批量归档 mission 引用的 tracks；归档前必须 precheck `cdt:TrackLink state="bound"`，并在用户明确选择时才逐个调用 `codument-archive-track`。
- 不把 `roadmap.md` 作为新 mission 必备文件。

## 5. 输出

```text
Mission '<mission-id>' 已归档到 codument/missions/archived/YYYY-MM-DD-<mission-id>/。
```
