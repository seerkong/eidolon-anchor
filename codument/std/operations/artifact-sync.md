# skill: codument-artifact-sync（制品同步）

**描述：** 把 track 的 `output` 物料（docs / 制品目录）按规则同步到一个或多个目标位置。**显式触发，不隐式。**

> 本文是完整提示词（口径已对齐当前标准）。**程序化的执行流程**（resolve → generate → 按 policy 写目标，带 dry-run / conflict / provenance 分支）用流程标记块（` ```text ` + `@delimiter: --`，构造词汇见 [`_operation-spec.md`](./_operation-spec.md)）表达；**说明、规则、背景、示例**用 Markdown，内嵌 XML 用 ```` ```xml ```` 围栏。
>
> 口径映射（旧→新）：`codument:artifact-sync`→`codument-artifact-sync`；`<artifact-sync artifact="...">` hook → `<cdt:ArtifactSync use="...">`；`attractor-profiles.json`→`config/attractor-profiles.xml`；`docs-knowledge.md`→`attractors/model-driven-docs.md`；旧 `feature.json` 的 `knowledgeSync.enabled` / `projectMemory.enabled`→`docs` / `memory` profile 的 `enabled`。**`artifacts.xml` 被取代**：来源不再读零散 source/target，而是直接读 track 的 `output` MaterialBundle（track.xml `<Ports>` 里 `role="output"` 的物料目录，如 `docs/`）；目标 = artifact 规则的 base-dir + relative-dir/file。

---

## 1.0 目标

你是 Codument artifact 同步代理。当前任务是**只同步用户指定或 hook 引用的 artifact**。

不要把 artifact-sync 退化为旧 docs-sync 全量同步。docs 类同步只是 artifact 的一种；其内容选择与写作规则由 [attractors/model-driven-docs.md](@codument/attractors/model-driven-docs.md) 以及 artifact 使用的 attractor profile（`docs`）提供，路由/质量/晋升判定见 [std/sop/artifact-sync.md](@codument/std/sop/artifact-sync.md)。

本 skill 是**普通同步流程**，不需要 gap-loop 式 fresh child orchestration；只有用户显式要求独立复检时才考虑委派子代理。

---

## 2.0 Artifact 选择

```text
@delimiter: --
-- #sequence ?select
---- #if ?user-id cond="用户提供了 artifact id"
精确匹配该 artifact 规则（对应某条 output 物料/目标规则）；不模糊匹配
---- /?user-id
---- #else-if ?hook cond="当前来自 operation-hooks.xml 的 archive:after <cdt:ArtifactSync use=\"...\">"
只执行该 hook 引用的 artifact（如 use="docs"）
---- /?hook
---- #else ?ambiguous
------ #fail ?stop reason="无法唯一确定 artifact"
停止并请求用户补充 artifact id
------ /?stop
---- /?ambiguous
-- /?select
```

**关键约束**：不要因为存在 artifact 配置 / 物料目录就同步全部 artifact——只执行被指定或被 hook 引用的那一个。

---

## 3.0 必读输入

必须读取：

- track 的 `output` MaterialBundle（来源——track.xml `<Ports>` 里 `role="output"` 的物料目录，如 `docs/`）。
- artifact 规则的目标（一个/多个目标根：`base-dir` + `relative-dir`/`relative-file`）及其 `policy`。
- [config/attractor-profiles.xml](@codument/config/attractor-profiles.xml)（确认 `docs` profile 是否 `enabled`）。
- [std/sop/artifact-sync.md](@codument/std/sop/artifact-sync.md)（内容选择 / 路由 / 质量规程）。
- artifact 引用的 workflow / skill / attractor-profile / agent resource（`skill` resource 只是规则或提示词来源，不是要写出的 artifact）。

如果 artifact 的 source 指向某个 track（含已归档 track），还应读取该 track 中存在的：

- `proposal.md` 与 `proposal/`
- `design.md` 与 `design/`
- `behavior_deltas/**/*.xml`（旧 track 兼容 `spec.md`）
- `track.xml`
- `decisions/*.md`（旧 track 兼容 `decisions.md`）
- `reports/*.md`
- archive 中的 `summary.md`

**docs 类 artifact** 还必须读取：

- [attractors/model-driven-docs.md](@codument/attractors/model-driven-docs.md)（路由表 / frontmatter / 根结构）
- [attractors/knowledge-tiers.md](@codument/attractors/knowledge-tiers.md) §4–§5（晋升判定）
- [std/docs-modeling-fractal/index.md](@codument/std/docs-modeling-fractal/index.md)
- [std/docs-impl-fractal/index.md](@codument/std/docs-impl-fractal/index.md)
- 现有 `docs/modeling` 与 `docs/impl`（如果目标是本项目 docs）

---

## 4.0 Artifact Sync 规则

- 来源是 track 的 `output` MaterialBundle（取代旧 `artifacts.xml` 的零散 source/target）；**不要**再把 `artifacts.xml` 当成单独的来源/目标配置去读。
- artifact resource 只允许 `workflow`、`skill`、`attractor-profile`、`agent`。`skill` resource 是规则或提示词来源，不是要写出的 artifact；`attractor-profile` resource 只引用 profile 名称（指向 `config/attractor-profiles.xml`），不要把直接 attractor 文件路径写在 resource 属性上。
- artifact 规则只关心 `uses`、`targets`、`policy`。
- **多个 target 表示同一 artifact 内容生成一次后分发到多个目标**，不表示多个独立 artifact。
- 每个 target 必须有 `id`、`kind`（`local-dir|web|command`）、`base-dir`，并且在 `relative-dir` 和 `relative-file` 中**二选一**：目录型 artifact 用 `relative-dir`（同步到目标根目录下的一个目录）；文件型 artifact 用 `relative-file`（同步到目标根目录下的单个文件）。
- **多 target 分发必须保持相同的相对路径结构**：如果 artifact 生成多个有层级关系的文件，先得到**一套相对文件树**，再把同一套相对文件树写入每个 target 的 `base-dir/relative-dir` 下。文件型 artifact 的多个 target 也必须用相同生成内容，只是写到各自 `base-dir/relative-file`。
- **不要**因为存在多个 target 就为不同 target 生成不同文件集合、不同文件名或不同层级——除非 artifact 的 workflow / skill resource 明确要求 target-specific 差异。
- 按 `<policy>` 处理 dry-run、conflict 和 provenance。

---

## 5.0 执行流程

整个同步是 resolve → source → generate → 按 policy 写目标的流程，写入阶段按 policy 分出 dry-run（首次预览）、conflict（diff-confirm）、provenance（manifest）三类分支。

```text
@delimiter: --
-- #sequence ?sync
---- #step ?scope
确认 artifact id、触发来源（用户 / archive:after hook）和目标范围
---- /?scope
---- #if ?disabled cond="docs profile 未 enabled（docs 类 artifact）"
------ #return ?skip value="不同步：对应 profile 未启用"
------ /?skip
---- /?disabled
---- #step ?resolve
解析 resources、attractor profile、targets 和 policy
---- /?resolve
---- #step ?source
读取来源 = track 的 output MaterialBundle + §3 相关上下文
---- /?source
---- #step ?generate
按 workflow / skill / docs profile 规则生成 artifact 内容——先得到一套相对文件树（docs/modeling、docs/impl 等）；docs 路由 / 晋升判定按 sop/artifact-sync.md
---- /?generate
---- #if ?dry-run cond="policy 含 dry-run（或首次同步）"
------ #step ?preview
先输出 diff / report 预览，不落盘；等确认后再继续
------ /?preview
---- /?dry-run
---- #loop ?targets for="每个 target"
------ #step ?map
把同一套相对文件树映射到该 target 的 base-dir/relative-dir（目录型）或 base-dir/relative-file（文件型）
------ /?map
------ #if ?conflict cond="policy conflict=diff-confirm 且目标已存在冲突内容"
输出 diff 等用户确认；未确认则不覆盖该 target
------ /?conflict
------ #step ?write
写入该 target（多目标保持同一相对结构）
------ /?write
---- /?targets
---- #if ?prov cond="policy provenance=manifest"
------ #step ?manifest
写 provenance manifest（来源清单 / inline 来源信息）
------ /?manifest
---- /?prov
---- #step ?report
列出 artifact id、各 target 输出、变更文件、跳过原因、待确认项
---- /?report
-- /?sync
```

如果项目尚无 `docs/modeling` 或 `docs/impl`，docs 类 artifact 只能创建与当前 artifact source **直接相关**的小文档；**不要**退化为全量 docs bootstrap。

---

## 6.0 约束

- 不要执行未被指定或未被 hook 引用的 artifact。
- 不要因为 `docs` / `memory` profile `enabled` 或 artifact 配置存在就**隐式**同步。
- 不要把普通实现细节写入 docs modeling（建模真源只装本体 / 心智模型 / 派生设计，不复述实现细节）。
- 如果同步存在争议，优先输出**待确认事项**而不是断言。
- `codument validate ...` 可能会格式化或补写 track metadata；运行验证后必须检查 `git diff`，并在报告中**区分**验证副作用和本次 artifact sync 修改。

---

## 7.0 参考

- 内容选择 / 路由 / 质量 / 晋升判定 + 目录职责补齐：[std/sop/artifact-sync.md](@codument/std/sop/artifact-sync.md)（本 skill 只负责选 artifact、解析来源目标、执行写入）。
- docs 路由表 / frontmatter / 根结构：[attractors/model-driven-docs.md](@codument/attractors/model-driven-docs.md)。
- 晋升阶梯与触发条件：[knowledge-tiers.md](@codument/attractors/knowledge-tiers.md) §4–§5。
- profile 开关（`docs` / `memory` 的 `enabled`）：[config/attractor-profiles.xml](@codument/config/attractor-profiles.xml)。
- 新建目录写"目录职责"块：[std/spec/folder-manifest.md](@codument/std/spec/folder-manifest.md)。
- 归档时如何触发本同步：[codument-archive skill](./archive.md) §6 / [std/sop/archive.md](@codument/std/sop/archive.md)。
