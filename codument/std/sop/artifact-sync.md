# 制品同步规程（std/sop/artifact-sync.md）

> `codument-artifact-sync`（及 `archive:after` 的 `cdt:ArtifactSync` hook）的执行套路。**显式触发，不隐式。**

## 步骤

```text
@delimiter: --
-- #sequence ?sync
---- #step ?resolve
解析来源/目标：来源 = track 的 output MaterialBundle（如 docs 目录）；目标 = artifact 规则的一个/多个目标根（base-dir + relative-dir/file）
---- /?resolve
---- #step ?generate
按 docs profile（attractor-profiles.xml 的 docs）+ 本规程，从已归档 track 选要同步的 docs（modeling/impl），fresh-subagent 生成/更新
---- /?generate
---- #step ?write
按 policy 写每个目标（多目标保持同一相对结构）
------ #if ?dry cond="dry-run（首次预览）"
仅预览不落盘
------ /?dry
------ #if ?conflict cond="conflict=diff-confirm"
输出 diff 等用户确认
------ /?conflict
------ #if ?prov cond="provenance=manifest"
写来源清单 manifest
------ /?prov
---- /?write
-- /?sync
```

## docs 路由（启用 docs 同步时）

- 先按 [knowledge-tiers.md](@codument/attractors/knowledge-tiers.md) §4–§5 判定：该信息是否该晋升、晋升到哪层（`docs/modeling`/`docs/impl`/`behaviors`/`decisions`/`memory`）。
- 建模/本体 → `docs/modeling/...`；设计实现 → `docs/impl/...`（领域中立，按 `std/docs-{modeling,impl}-fractal/index.md` 规范，不写死 web 结构）。
- 文件级路由用 `model-driven-docs.md` 的 Routing Table；单文件过大按"同名文件夹"拆分；frontmatter/命名/时效性按规范。
- **新建目录**：按 [folder-manifest.md](@codument/std/spec/folder-manifest.md) 为新目录写「目录职责」块；可顺手对缺块目录跑一次补齐（backfill）。

## 规则

- 只在显式 hook 或用户手动调用时执行；`docs` profile 未 `enabled` 则不同步。
- **优先实时、归档兜底**：discuss 期已实时收敛的稳定结论，本步只做全量复查/补漏，不重复劳动；只把尚未沉淀的稳定知识补上。
- 本规程负责 docs 内容选择/路由/质量 + 晋升判定 + 目录职责补齐；`codument-artifact-sync` skill 负责选 artifact、解析来源目标、执行写入。
