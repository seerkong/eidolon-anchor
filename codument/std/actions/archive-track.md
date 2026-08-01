# skill: codument-archive-track（归档已完成的 track）

**描述：** 归档已完成的变更追踪。把 track 的产出"落盘"成持久真源——核心动作是把行为增量提升进行为登记表 `codument/behaviors/`，并把 track 从 `tracks/active/` 移进 `tracks/archived/`；再按开关条件提升 decision / memory、按显式 hook 触发 artifact/docs 同步。

> 本文是完整提示词（口径已对齐当前标准）。**程序化的执行流程**（有序的提升流水线 + 条件门）用流程标记块（` ```text ` + `@delimiter: --`，构造词汇见 [`_action-spec.md`](./_action-spec.md)）表达；**说明、规则、背景、示例**用 Markdown，内嵌 XML 用 ```` ```xml ```` 围栏。
>
> 口径映射（旧→新）：`codument:archive`→`codument-archive-track`（旧 `codument-archive` 为别名）；`plan.xml`→`track.xml`，其 `metadata.status`→`<Metadata><Status>`；`tracks/active/<id>/`→`tracks/archived/YYYY-MM/YYYY-MM-DD-HHmm-<id>/`（时间取 track **最后更新**时间，不是执行归档命令当天）；`spec_deltas/**`→`behavior_deltas/**`、`<spec-patch>`→`<behavior-patch>`、`spec://`→`behavior://`、`codument/specs/`→`codument/behaviors/`；`feature.json` 的 `knowledgeSync.enabled` / `projectMemory.enabled`→`config/attractor-profiles.xml` 里 `docs` / `memory` profile 的 `enabled`；`artifacts.xml` 的零散 source/target → track 的 `output` MaterialBundle（来源）+ artifact 规则的目标根（目标）；`<artifact-sync>` hook → `<cdt:ArtifactSync>`；`<attractor-check>` → `<cdt:AttractorCheck>`。

---

## 1.0 系统指令

你是 Codument 规范驱动开发框架的 AI 代理助手。当前任务是归档一个已完成的 track。

**优先调用 Codument CLI 完成归档。**

- 归档动作优先执行 `codument archive <track-id> --yes`。CLI 会统一处理 archive 路径、behavior registry 提升、decisions、memory 与 artifact-sync 提示。
- 不要手工 `mv` track 目录来代替 CLI 归档。
- 仅当 CLI 不存在或执行失败，才按下文手工归档流程作为 fallback，并在最终结果中**明确说明 fallback 原因**。

归档把 track 的产出落盘成持久真源。behavior、modeling、engineering registry 共享一个 **prepare → validate/conflict-detect → staging → rollback-capable commit** 事务边界；任一失败时 live registries 保持调用前状态、track 不移动，只有 commit 成功后才移动 track。

- **behavior 提升（必做）**——把 `behavior_deltas/**` 应用到 transaction staging 中的 behavior registry，commit 成功后更新 `codument/behaviors/`。
- **modeling / engineering 提升（条件）**——对实际存在的 delta 做真实 base/ours/theirs 三方合并并物化到同一 transaction staging；无 delta 不创建空 registry。
- **track 归档（必做）**——把 `tracks/active/<id>/` 移进 `tracks/archived/YYYY-MM/`，`<Status>completed`。
- **decision 提升（条件）**——有 durable decision 才升 `decision://`。
- **memory 提升（条件）**——`memory` profile `enabled` 且 track 显式给候选时才升 `memory://`。
- **artifact/docs 同步（条件·显式触发）**——只有 `action-hooks.xml` 显式配了 `archive-track:after <cdt:ArtifactSync>` 且 `docs` profile `enabled` 才同步。

> **晋升判定权威**：每类提升（behaviors / docs / decisions / memory）的"该不该升、升到哪层"以 [knowledge-tiers.md](@codument/std/attractors/knowledge-tiers.md) §4–§5 的触发条件为准。归档是**兜底**——discuss / 实现期已实时收敛进 owner 文档的，本步只复查补漏（见 [model-driven-docs.md](@codument/std/attractors/model-driven-docs.md) 的"两个时机，别只在归档"）。

---

## 2.0 确定 Track ID

1. **检查输入：**
   - 如果提示词包含具体 track ID，使用该值。
   - 如果对话中模糊引用了某个 track，运行 `codument list` 显示候选项并确认（用 **Protocol: ask-single-question-closed**）。
   - 否则，询问用户要归档哪个 track（用 **Protocol: ask-single-question-free**）。

2. **验证 Track：**
   - 运行 `codument list` 验证 track ID。
   - 如果 track 缺失、已归档或未准备好，停止并通知用户。

---

## 3.0 归档主流程（提升流水线）

整个归档是一条**事务化提升流水线**——前置门 → 三类 registry prepare → validate/conflict-detect → staging → rollback-capable commit → 成功后移动 track → 条件提升（decision / memory）→ 显式 artifact 同步 → 校验。每步带条件门，门不满足就跳过该 target；不得把 track move 放到 registry commit 之前。

```text
@delimiter: --
-- #sequence ?archive
---- #step ?precheck
读 track.xml <Metadata><Status>；status=completed 才直接归档
---- /?precheck
---- #if ?notdone cond="Status 不是 completed"
警告用户该 track 未完成，询问是否仍要归档（Protocol: ask-single-question-closed）；用户拒绝则 #exit
---- /?notdone
---- #if ?before cond="action-hooks.xml 为 archive-track 配了 archive-track:before（如 <cdt:AttractorCheck use=\"docs\">）"
------ #step ?run-before
先执行 archive-track:before hook（常见用途：用 docs profile 做归档前吸引子方向审查）
------ /?run-before
---- /?before
---- #step ?prepare
prepare 三类 registry：解析全部 behavior_deltas/**；对实际存在的 modeling_deltas/**、engineering_deltas/** 物化 base/ours/theirs 并做真实节点级 3-way merge；modeling 缺失配置时默认 enabled，显式 enabled=false 才跳过；无 delta 不创建 target
---- /?prepare
---- #step ?validate-conflicts
在任何 live 写入前完成 patch 解析、schema/结构校验与全部冲突检测；任一失败清理临时产物并返回，live registries 不变、active track 保持原路径、archive destination 不存在
---- /?validate-conflicts
---- #step ?stage
复制每个适用 live registry（不存在则以空树开始）到 transaction-owned staging；把 behavior patch 与 modeling/engineering 合并结果全部物化到 staging
---- /?stage
---- #step ?commit
为所有将替换的 target 建 backup 后提交 staged trees；任一步失败则逆序 rollback，恢复每个 target 原先的存在/不存在和字节内容，并保留 track 原路径；仅全部 commit 成功才继续
---- /?commit
---- #step ?mkdir
commit 成功后创建 tracks/archived/YYYY-MM/ 目录（不存在则建）；YYYY-MM 取 track 最后更新时间
---- /?mkdir
---- #step ?move
仅在 registry commit 成功后，把 tracks/active/<id>/ 移到 tracks/archived/YYYY-MM/YYYY-MM-DD-HHmm-<id>/（时间取 track 最后更新）；track.xml <Metadata><Status>completed
---- /?move
---- #if ?decision cond="track 有明确标记为 durable / 长期项目决策的单文件决策"
------ #step ?promote-decision
把 durable 决策提升到 codument/decisions/YYYY-MM/YYYY-MM-DD-HHmm-slug/decision.md，用 decision://<slug> 作长期引用；普通过程决策只留 archive，不提升
------ /?promote-decision
---- /?decision
---- #if ?memory cond="memory profile enabled 且 track 显式存在 memory/{lessons,incidents,patterns,summaries}/*.md 候选"
------ #step ?promote-memory
提升 memory:// 内容；不要从 proposal 或普通日志自动合成 memory
------ /?promote-memory
---- /?memory
---- #if ?sync cond="action-hooks.xml 为 archive-track:after 显式配了 <cdt:ArtifactSync use=\"...\"> 且 docs profile enabled"
------ #step ?artifact-sync
读 track 的 output MaterialBundle（如 docs 目录），按 actions/artifact-sync.md / codument-artifact-sync skill 同步到目标；只同步 hook 引用的 artifact
------ /?artifact-sync
---- /?sync
---- #else ?no-sync cond="缺显式 archive-track:after <cdt:ArtifactSync> hook 或 docs profile 未 enabled"
不同步：不因为 docs profile enabled 或 artifact 配置存在就隐式同步
---- /?no-sync
---- #step ?validate
尝试 codument validate --strict 确认归档后状态正确
---- /?validate
---- #if ?nocli cond="系统中找不到 codument 命令"
跳过该外部 CLI validate 步骤（不阻塞归档）；并在最终结果中明确说明：外部 codument validate --strict 未执行，原因是找不到 codument 命令
---- /?nocli
---- #return ?done value="宣布：Track '<track-id>' 已成功归档到 tracks/archived/YYYY-MM/YYYY-MM-DD-HHmm-<track-id>/"
---- /?done
-- /?archive
```

> **不维护额外 registry**：归档通过移动 `tracks/active/<id>/` 完成，不维护额外的活跃目录入口文件。

---

## 4.0 behavior 提升逻辑（核心动作）

track 完成后更新行为登记表 `codument/behaviors/`（旧称 spec registry / `codument/specs/`）是归档的**核心动作**——但所有 patch 必须先应用到 transaction staging，不能逐 patch 直接写 live registry。全部 behavior/modeling/engineering prepare 与 staging 成功后才统一 commit。详细的登记表布局与节点结构见 [std/spec/behavior-registry.md](@codument/std/spec/behavior-registry.md)。

### 4.1 应用 XML behavior patch

```text
@delimiter: --
-- #sequence ?apply-delta
---- #step ?scan
扫描 behavior_deltas/**/*.xml（track 的 input 物料）
---- /?scan
---- #step ?validate-root
验证每个文件根节点为 <behavior-patch>
---- /?validate-root
---- #loop ?each for="每个 mutation wrapper"
------ #step ?read-mutation
读取 wrapper 标签（upsert|delete|move）、selector（behavior://…）、可选 to
------ /?read-mutation
------ #switch ?op on="wrapper 标签"
-------- #case ?upsert when=upsert
新增或替换 selector 指向的行为节点
-------- /?upsert
-------- #case ?delete when=delete
删除 selector 指向的行为节点
-------- /?delete
-------- #case ?move when=move
把 selector 指向的节点移动到 to
-------- /?move
------ /?op
------ #if ?missing cond="selector 目标 capability 不存在"
创建 codument/behaviors/<capability>.xml（行为较多时演化为 <capability>/index.xml + 子文件）
------ /?missing
---- /?each
---- #step ?register
能力变化先登记到 staged behavior registry；统一 transaction commit 成功后才更新 live 行为登记表真源
---- /?register
-- /?apply-delta
```

每个 delta 文件是一份 `<behavior-patch>`，示例：

```xml
<behavior-patch capability="csv-export" version="1">
  <upsert selector="behavior://csv-export/requirements/export-endpoint">
    <requirement id="export-endpoint">
      <statement>系统 SHALL 提供 GET /reports/export.csv …</statement>
      <suite name="csv-export">
        <case name="字段转义"><given>…</given><when>…</when><then>…</then></case>
      </suite>
    </requirement>
  </upsert>
</behavior-patch>
```

如果是纯工具变更（无行为增量），跳过 behavior 提升步骤。

### 4.2 旧 Markdown 兼容

旧 track 可能只有 `spec.md` 和 `## ADDED|MODIFIED|REMOVED Requirements`。可以**兼容读取**这种 Markdown delta，但**不要**为新 track 创建这种格式——新 track 一律用 `behavior_deltas/**/*.xml`（`<behavior-patch>`）。

---

## 5.0 条件提升（decision / memory）

- **承重决策 → `decision://`**：优先读取根级 `decisions.xnl` 中 `durable_candidate = true` 且 `status = "accepted"|"resolved"` 的决策；历史 track 兼容读取 `decisions/*.md` 中明确标记为 durable / 长期项目决策的单文件决策，以及旧根级 `decisions.md`。把 durable 决策提升到 `codument/decisions/YYYY-MM/YYYY-MM-DD-HHmm-slug/decision.md`，并用 `decision://<slug>` 作长期引用；普通过程决策只保留在 archive。触发条件：一个原本一次性的取舍变成"以后都按这个来"的承重决策（见 [knowledge-tiers.md](@codument/std/attractors/knowledge-tiers.md) §5）。
- **长期记忆 → `memory://`**：**仅当** `config/attractor-profiles.xml` 的 `memory` profile `enabled=true` **且** track 中显式存在 `memory/{lessons,incidents,patterns,summaries}/*.md` 候选时，才提升 `memory://` 内容。**不要**从 proposal 或普通日志自动合成 memory。

> `docs` profile `enabled` 本身**不**代表复制 durable decision 记录，也**不**触发隐式 docs/knowledge sync；旧 `feature.json` 的 `knowledgeSync.targets` 应由 `upgrade-workspace`/`migrate` 迁移为 docs profile + artifact 规则的目标。

---

## 5.5 modeling 合并（默认启用 · 有 delta 才加入事务）

缺失 `config/modeling.xml` 时按 enabled 处理，fresh init 也默认 `enabled=true`；只有显式 `enabled=false` 才跳过 modeling。enablement 与 delta obligation 分离：仅当 track 实际包含结构知识变化对应的 `modeling_deltas/**` 时加入 archive transaction；无 delta/空文件集不创建空 registry。

1. 物化三方：base（track 元信息记录的宿主 git commit，`git show <commit>:codument/modeling/...`）+ ours（当前 `codument/modeling/` 工作树）+ theirs（track 的 `modeling_deltas/**`）。
2. 节点级 3-way 合并（临时引擎，不持久化平行 vcs）：复用 `xnl-vfs` `xnlFileHandler.merge` / `xnl-core` `diffNodes`+`applyMutations`（`metadataIdMode:"identity"`，按 `#id` 命中）。
3. 冲突按 `config/modeling.xml` 的 `<MergePolicy>` 处置：默认保守（`human`=issues-first 报告并暂停，不静默覆盖），可配 `ours|theirs|base`。
4. 合并结果先物化进 transaction staging，与 behavior / engineering 一起通过校验和冲突检测；首次有效 delta 可从空 ours 创建 staged registry。
5. 统一 rollback-capable commit 成功后才更新 `codument/modeling/` 并移动 track；任一失败 live registry 不变。missing/empty registry validate 只报 warning，非空 registry 仍要求 domain plane。
6. commit 成功后跑 `codument modeling lint` 给分形拆分建议。

> 详细规程见 `std/spec/modeling-delta.md`。modeling 是**结构真源**层；与 behaviors（行为契约）互不重复，modeling 节点引用 `behavior://`。

## 5.6 engineering 合并（条件 · engineering 启用）

**仅当** `config/engineering.xml` 存在且 `enabled=true` 时执行；否则整步跳过、行为不变。

1. 物化三方：base（track 元信息记录的宿主 git commit，`git show <commit>:codument/engineering/...`）+ ours（当前 `codument/engineering/` 工作树）+ theirs（track 的 `engineering_deltas/**`）。
2. 节点级 3-way 合并（临时引擎，不持久化平行 vcs）：复用 `xnl-core` `diffNodes`+`applyMutations`（`metadataIdMode:"identity"`，按 `#id` 命中）。
3. 冲突按 `config/engineering.xml` 的 `<MergePolicy>` 处置：默认保守（`human`=issues-first 报告并暂停，不静默覆盖），可配 `ours|theirs|base`。
4. 合并结果先物化进与 behavior/modeling 共用的 transaction staging；统一 rollback-capable commit 成功后才更新 `codument/engineering/`，失败则恢复全部 live targets 且不移动 track。
5. commit 成功后跑 `codument engineering lint` 给分形拆分建议。

> 详细规程见 `std/spec/engineering-delta.md`。engineering 是**工程知识真源**层；与 modeling（结构真源）、behaviors（行为契约）、decisions（承重决策）互不重复，通过 `engineering://` / `modeling://` / `behavior://` / `decision://` 引用连接。

---

## 6.0 artifact / docs 同步（显式触发，不隐式）

**只有**当 `config/action-hooks.xml` 为 `archive-track` 的 `archive-track:after` hook point 显式配了 `<cdt:ArtifactSync use="...">` **且** `docs` profile `enabled` 时才触发同步：

- 来源 = track 的 `output` MaterialBundle（如 docs 目录）——**直接读 track 的 output MaterialBundle，不再引用 `artifacts.xml` 作为单独配置**。
- 目标 = artifact 规则里的一个/多个目标根（base-dir + relative-dir/file）。
- 同步只针对 hook 引用的那个 artifact，按 `actions/artifact-sync.md` 的内容选择 / 路由 / 质量 + 写入 policy（dry-run / conflict=diff-confirm / provenance=manifest）执行；多目标保持同一相对结构。

**关键约束**：缺失显式 hook 时，**不要**因为 `docs` profile `enabled` 或 artifact 配置存在就隐式同步。

完整 artifact-sync 规程见 [codument-artifact-sync skill](./artifact-sync.md)（含 §4.5 docs 路由）。

---

## 7.0 校验与宣布

1. **校验**：优先运行 `codument validate --strict` 确认归档后状态正确。如果系统中找不到 `codument` 命令，**跳过**这个外部 CLI validate 步骤（不要因此阻塞归档），并在最终结果中明确说明：外部 `codument validate --strict` 未执行，原因是找不到 `codument` 命令。
2. **宣布完成：**
   > "Track '<track-id>' 已成功归档到 `tracks/archived/YYYY-MM/YYYY-MM-DD-HHmm-<track-id>/`。"

---

## 8.0 参考

- 使用 `codument list` 确认 track ID。
- 使用 `codument list --behaviors` 查看更新后的行为登记表（XML registry）。
- behavior 登记表布局 / delta 应用：[std/spec/behavior-registry.md](@codument/std/spec/behavior-registry.md)。
- 归档执行套路：本文（codument-archive-track skill 即完整归档规程；codument-archive 为旧名别名）。
- 晋升阶梯与触发条件：[knowledge-tiers.md](@codument/std/attractors/knowledge-tiers.md) §4–§5。
- 显式 artifact 同步：[codument-artifact-sync skill](./artifact-sync.md)（含 §4.5 docs 路由）。
- 检查归档后 `codument validate --strict` 通过；如果系统找不到 `codument` 命令，则记录该外部 CLI validate 步骤已跳过。
