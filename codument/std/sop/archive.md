# 归档规程（std/sop/archive.md）

> `codument-archive` 的执行套路。

## 步骤

```text
@delimiter: --
-- #sequence ?archive
---- #if ?before cond="operation-hooks.xml 配了 archive:before hook（如 cdt:AttractorCheck use=docs 方向审查）"
先执行该 hook
---- /?before
---- #step ?promote-behavior
提升 behavior（必做）：把 behavior_deltas/**（track input 物料）按 <upsert|delete|move> wrapper + behavior:// selector 应用进 codument/behaviors/（track output name="behavior" 物料根；见 behavior-registry.md）
---- /?promote-behavior
---- #step ?move
移 track：tracks/<id>/ → archive/YYYY-MM/YYYY-MM-DD-HHmm-<id>/（时间取 track 最后更新）；track.xml <Status>completed
---- /?move
---- #if ?decision cond="存在 durable decision"
提升 → decision://
---- /?decision
---- #if ?memory cond="memory profile 启用 且 track 显式给候选"
提升 → memory://
---- /?memory
---- #if ?after cond="operation-hooks 显式配了 archive:after cdt:ArtifactSync 且 docs profile enabled"
按 artifact-sync.md 读 track output MaterialBundle 同步到目标（不隐式同步）
---- /?after
---- #step ?validate
尝试 codument validate --strict（无命令则跳过并说明）
---- /?validate
-- /?archive
```

## 规则

- behavior 提升是归档的核心动作（更新行为登记表真源）。
- 四类提升各有开关；除 behavior 提升与 track 归档外，其余都需显式启用/配置。
- **晋升判定权威**：每类提升（behaviors / docs / decisions / memory）的"该不该升、升到哪"以 [knowledge-tiers.md](@codument/attractors/knowledge-tiers.md) §4–§5 的触发条件为准。归档是**兜底**——discuss/实现期已实时收敛进 owner 文档的，本步只复查补漏；`memory` 中反复复发的 pattern 才考虑再升为可复用 sop/skill/check。
