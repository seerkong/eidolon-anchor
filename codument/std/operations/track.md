# skill: codument-track（创建变更追踪）

为一个新功能 / Bug 修复 / 变更创建一条 **Track**：引导用户收集信息，生成行为增量（`behavior_deltas/<capability>/delta.xml`）、提案（`proposal.md`）、可选方案设计（`design.md`），以及状态真源 `track.xml`，并把它们组织在专用的 `tracks/<id>/` 目录中等待批准。

> 本文以 **Markdown 为主**：何时建 track、每步问什么、产物长什么样、各种规则与示例都用 prose / 列表 / 表格 / good-bad 示例完整给出。只有**程序化的控制流**（新建 track 的固定顺序、同轮确认的写入分支）用流程标记块（` ```text ` + `@delimiter: --`，构造词汇见 `_operation-spec.md`）表达；XML 片段用 ` ```xml ` 围栏内嵌（免转义）。
>
> 口径映射（旧→新，全文一致）：`codument:track`→`codument-track`；`list --specs`→`list --behaviors`；`plan.xml`→`track.xml`（根 `<Track xmlns:cdt>`，phase = `<TaskSpace>` 第一层 `<TaskGroup>`，状态枚举 `NOT_STARTED/ACTIVE/DONE…`）；`spec_deltas/`→`behavior_deltas/`、`spec://`→`behavior://`、`<spec-patch>`→`<behavior-patch>`、`specs/`→`behaviors/`，"spec"→"behavior"；`<validation_mode>`/`<confirm>`→`<cdt:GapLoop>`/`<cdt:HumanConfirm>` 节点；`<attractor-check>`→`<cdt:AttractorCheck use="coding|docs">`；`feature.json` 能力开关→profile 的 `enabled`。track.xml 完整口径见 `codument/std/spec/track-xml-spec.md`，track 目录布局见其 §0.5。

---

## 0. 意图、触发与产物

**意图。** 为一个新功能 / 变更建 track：收集信息 → 起草行为增量与 `track.xml` → 同轮收集提交模式 / 校验模式 / 方向审查 → 等待批准。**提案获批前不开始实现。**

**何时建 track（trigger）。** 下列情况建 track：

- 新增功能 / 能力
- 破坏性变更（API、数据结构）
- 架构 / 模式调整
- 改变行为的性能优化
- 安全模式更新

下列情况**跳过 track**，直接做：

- 恢复既有预期行为的 Bug 修复
- 拼写、格式、注释
- 非破坏性依赖更新
- 纯配置变更
- 为既有行为补测试

补充需求若落在某条进行中 track 的范围内，**并入该 track**，不另开。决策树：

```text
新请求？
├─ 恢复规范行为的 Bug 修复？→ 直接修复
├─ 拼写 / 格式 / 注释？      → 直接修复
├─ 新功能 / 能力？          → 创建 track
├─ 破坏性变更？             → 创建 track
├─ 架构变更？               → 创建 track
└─ 不确定？                 → 创建 track（更安全）
```

**产物（写入 `codument/tracks/<id>/`）。**

| 产物 | 必有？ | 内容 |
|---|---|---|
| `track.xml` | ★必有 | 状态真源（结构 / 调度 / 行为三轴，见 track-xml-spec） |
| `proposal.md` | ★必有 | 为什么 / 是什么 / 目标-非目标 / 变更内容 / 影响 |
| `behavior_deltas/<cap>/delta.xml` | ★必有 | 行为增量（`<behavior-patch>`） |
| `design.md`（+`design/`） | 可选 | 方案 / 决策摘要 / 风险 / 兼容 / 迁移 |
| `analysis/{findings,knowledge}.md` | 按需 | 规划期 planning-with-files 外部记忆 |
| `decisions.md`（+`decisions/`） | 按需 | 决策问题 / 选项 / 答复 / 结论 |
| `memory/` | 按需 | 长期记忆候选 |
| `reports/` | 运行期生成 | gap-loop / verify 报告 |

完整目录布局与提升时机见 `track-xml-spec.md` §0.5。

---

## 1. 设置检查（前置）

开始前验证 Codument 已正确初始化：

- 存在 `codument/std/`（含 `std/spec/track-xml-spec.md`、`std/sop/workflow.md`）；
- 存在项目上下文：优先 `codument/attractors/`（如 `attractors/project.md`、`attractors/product.md`）；旧项目兼容 `codument/project.md` + `codument/product.md` 组合。

任何一项缺失就**立即停止**，宣告"Codument 未设置。请使用 `codument-init` skill 设置环境。"，**不要**继续建 track。

---

## 2. 产物的可引用范围（硬规则）

生成的产物在引用其他文件时必须遵守：

- **不可引用 `.` 开头隐藏目录**中的文档（如 `.abc/e.md`）。
- 每个 track 目录的内容必须**自包含**：**不可引用 track 目录之外**的说明文档（如 `doc/`、`docs/` 里的解释文档）作为读懂本 track 的必要前提。
- 若仅靠 `behavior_deltas/<capability>/delta.xml`、`proposal.md`、`design.md`、`track.xml` 不足以记录关键信息（如 `example.md`、`ui-ux-design.md`），可在**当前 track 目录内**额外建文件，并由上述标准产物引用之。

---

## 3. 新建 Track（主流程）

严格按下面顺序执行。每个"起草 + 用户确认"步骤都用 **ask-single-question-free**（见 `codument/std/sop/questioning.md`）等待确认后再继续。

```text
@delimiter: --
-- #sequence ?create
---- #step ?s1
§3.1 取得 track 描述、推断类型、加载项目上下文
---- /?s1
---- #step ?s2
§3.2 起 track-id、查重、用户确认、建目录与 analysis/ decisions/ memory/，写 Metadata
---- /?s2
---- #step ?s3
§3.3 交互式起草 behavior_deltas/<cap>/delta.xml → 用户确认
---- /?s3
---- #if ?s3m cond="config/modeling.xml 存在且 enabled=true"
§3.3b 参考 behavior_deltas，起草 modeling_deltas/<plane>/<context>.xnl（目标态节点，XNL）；记录当前 codument/modeling 的宿主 git commit 作 3-way base（写入 track 元信息）。规范见 std/spec/modeling-{registry,delta,node-schema}.md（其 §9 语言约定：描述/注释/pseudo/mermaid 标签用中文，interface/字段/kind/枚举/#id 等标识符保持英文）。modeling 未启用则跳过。
§3.3b 自检：写完 / 编辑 modeling_deltas 后，运行 `codument modeling validate --deltas <track_id>`；若报 error，按报告（file/line/layer/reason）修正 modeling_deltas 再继续，直到 0 error。本自检与 §3.3b 同样 gated on config/modeling.xml——modeling 未启用（无 config/modeling.xml 或 enabled=false）则跳过。
---- /?s3m
---- #step ?s4
§3.4 起草 proposal.md → 用户确认
---- /?s4
---- #if ?s5 cond="满足 §3.5 的 design 触发条件"
§3.5 起草 decisions.md（如需）+ design.md → 用户确认
---- /?s5
---- #step ?s6
§3.6 起草 track.xml（结构 + 调度）
---- /?s6
---- #step ?s7
§3.7 同一轮确认：提交模式 + 校验模式（+gap-loop 粒度）+ 方向审查 → 写 Hooks
---- /?s7
---- #step ?s8
§3.8 收尾：validate（best-effort）+ 宣布完成与下一步
---- /?s8
-- /?create
```

### 3.1 取得描述、确定类型、加载上下文

1. **加载项目上下文**：优先读 `codument/attractors/` 下与任务相关的吸引子；旧项目无 attractors 时兼容读 `codument/project.md` + `codument/product.md`。先 `codument list` / `codument list --behaviors` 看现状，避免重复能力——**能改既有 behavior 就不要新建**。
2. **取得 Track 描述**：`{{args}}` 含描述则用之；为空则问"请提供你想开始的变更追踪的简要描述（功能、Bug 修复、重构等）。"并等待回复（**ask-single-question-free**）。
3. **推断类型**：分析描述判定"功能"或"其他（Bug、重构等）"，**不要**让用户分类。

> **提问纪律**：问答 ToolCall 只用于真实澄清 / 选择 / 确认；**禁止**为测试运行环境能力发占位问题。当前没有要问的就直接往下。

### 3.2 建目录与元信息

1. **查重**：列出 `codument/tracks/` 现有目录；若提议短名与现有重复，停止并建议换名。
2. **生成 Track ID**：小写英文 + 中横线的简短描述，**动词开头**（`add-`、`update-`、`remove-`、`refactor-`），如 `add-user-auth`、`fix-login-bug`。**不含日期**（日期只在归档时加）；若已被占用，追加 `-2`、`-3`。
3. **用户确认 ID**：展示起草的 track-id —— "我已起草了新的 Track ID：`<track_id>`。这是否准确捕获了需求？请建议更改或确认。" 等待并修改至确认。
4. **建目录**：`codument/tracks/<track_id>/`。
5. **建 `analysis/`（外部记忆）**：建 `analysis/findings.md` 与 `analysis/knowledge.md`。
   - **硬规则：仅缺失时创建，绝不覆盖已有内容**——目录已存在则不删不重写；文件已存在则绝不改写（哪怕你觉得不完整），不存在才按模板创建。
   - 按 planning-with-files 把关键结论写入文件作为外部记忆，**避免长对话或多轮工具调用丢失重要信息**；内容必须与本 track 相关、避免泛化；不引用 `.` 开头隐藏目录。
   - `findings.md` 记录本次分析直接找到的事实、约束、问题与结论；`knowledge.md` 记录阅读代码 / 文档 / 行为后沉淀的知识上下文、术语、机制理解与可复用认知。

   `analysis/findings.md` 模板：
   ```markdown
   # Findings

   ## Found Facts
   -

   ## Constraints
   -

   ## Open Questions
   -

   ## Conclusions
   -
   ```

   `analysis/knowledge.md` 模板：
   ```markdown
   # Knowledge Context

   ## Source Notes
   | Source | Summary | Relevance |
   |--------|---------|-----------|
   |        |         |           |

   ## Codebase Knowledge
   -

   ## Domain Knowledge
   -

   ## Terms
   | Term | Meaning |
   |------|---------|
   |      |         |
   ```
6. **建决策与记忆目录**（已存在则跳过）：
   - `decisions/` —— archive-ready 的 durable 单文件决策（每个长期决策一个 `.md`，归档可提升 `decision://`）。
   - 需用户确认的过程决策仍用根级 `decisions.md` 作为评审入口。
   - `memory/` —— 记忆上下文，按类型分子目录 `lessons/`、`incidents/`、`patterns/`、`summaries/`（归档且 `memory` profile 启用时提升 `memory://`）。
7. **写 Metadata**（在 `track.xml` 的 `<Metadata>`，§3.6 一并落盘）：

   ```xml
   <Metadata>
     <Status>new</Status>                  <!-- new | in_progress | completed | cancelled -->
     <Goal>初始目标</Goal>
     <Description>初始描述</Description>
     <CommitMode>manual</CommitMode>       <!-- §3.7 据用户选择写 auto | manual -->
     <CreatedAt>2026-06-14T10:00:00Z</CreatedAt>
     <UpdatedAt>2026-06-14T10:00:00Z</UpdatedAt>
   </Metadata>
   ```

   `track-id` 是 `<Track id="...">` 根属性，不再放 Metadata（见 track-xml-spec §1–§2）。

### 3.3 交互式行为增量（XML behavior delta）

1. **说明目标**："现在我将通过一系列问题帮你构建全面的行为规范（`behavior_deltas/<capability>/delta.xml`）。为提速，我会在一轮里给出多个问题，并用 Q1、Q2… 标记，按标记回答即可。"
2. **提问阶段**（**ask-multi-question-free**）：按 track 类型收集 delta 细节。
   - 参考 `codument/attractors/` 相关吸引子提**上下文感知**的问题（旧项目兼容参考 `product.md`/`project.md`）；
   - 每问给简要解释 + 清晰示例；**强烈建议**尽量给 2-3 个选项供选。
   - **功能**：问 3-5 个问题澄清需求（功能澄清、实现方式、交互、输入/输出等），按具体请求定制。
   - **其他（Bug / 重构等）**：问 2-3 个问题（复现步骤、重构范围、成功标准等）。
3. **起草 behavior delta**：按 capability 拆分，写 `codument/tracks/<track_id>/behavior_deltas/<capability>/delta.xml`。

   **格式规则（必须遵守）：**
   - 根节点必须是 `<behavior-patch capability="<capability>" version="1">`。
   - 每个变更点用 mutation wrapper 表达：`<upsert selector="behavior://...">`、`<delete selector="behavior://..." />`、`<move selector="behavior://..." to="behavior://..." />`，**不发明其他 mutation 类型**。
   - 定位只用 `selector="behavior://<capability>/requirements/<id>/suites/<id>/cases/<id>"`；移动用 `to="behavior://..."`。
   - 新增 / 修改用 `<upsert>`，把 `<requirement>`、`<suite>`、`<case>` 等业务节点作为其子节点；删除用 `<delete>`（无正文）；移动用 `<move>`（必须给 `to`）。
   - BDD / 测试场景用**可嵌套**的 `<suite>` 与 `<case>`；`<case>` 内用 `<given>`、`<when>`、`<then>`、可选 `<and>`。
   - 需求正文用 `<statement>`，**不要**再用 Markdown 的 `## ADDED Requirements` / `### Requirement:` / `#### Scenario:`。
   - 需求措辞：规范性需求用 **SHALL / MUST**（除非故意非规范，否则避免 should / may）。每个 capability 至少一个 `<requirement>`，每个可测试需求至少一个 `<case>`。
   - 如果 `docs` profile 启用，可在相关 `<requirement>`、`<suite>` 或 `<case>` 内加可选 `<knowledge-hint target="..." href="behavior://..." strength="hint" />`，帮助后续 docs/knowledge sync 定位候选文档——它是**弱链接**（hint），不是强外键，链接失效不应默认阻断归档。`docs` profile 停用或缺失时**不生成** `knowledge-hint`，也不生成 docs 联动信息。

   **示例：**
   ```xml
   <behavior-patch capability="provider.deepseek" version="1">
     <upsert selector="behavior://provider.deepseek/requirements/cache-support">
       <requirement id="cache-support">
         <statement>系统 SHALL 支持 DeepSeek provider 的前缀缓存能力。</statement>
         <suite id="request-build" name="请求构建">
           <case id="inject-cache-control">
             <given>provider 为 deepseek 且 model 声明 supports_context_cache</given>
             <when>系统构造 chat completion 请求</when>
             <then>系统 SHALL 在静态系统提示末尾插入 cache_control 块</then>
             <knowledge-hint target="main-docs" href="behavior://main-docs/provider.deepseek/cache-support" strength="hint" />
           </case>
         </suite>
       </requirement>
     </upsert>
   </behavior-patch>
   ```

   **拆分规则：**
   - 每个 capability 一个目录：`behavior_deltas/<capability>/delta.xml`。
   - capability 很大时，拆成 `behavior_deltas/<capability>/requirements/<topic>.xml`，并保留 `delta.xml` 作为索引说明或主 patch；所有 patch 文件都必须是 `<behavior-patch>`。
   - 不引用当前 track 外的说明文档作为理解本 track 的必要条件。

   **ADDED vs MODIFIED 的选择**（影响归档时如何合并进 `behaviors/`）：
   - **ADDED**：引入可独立存在的新能力 / 子能力。变更正交（如加"API 配置"）而非改既有需求语义时优先 ADDED。
   - **MODIFIED**：改既有需求的行为 / 范围 / 验收。**必须粘贴完整的更新后需求**（标题 + 所有场景）——归档会用你提供的内容**完全替换**原需求。
   - **RENAMED**：仅名称变更时用；若同时改行为，用 RENAMED（名称）+ MODIFIED（引用新名称的内容）。
   - **常见陷阱**：用 MODIFIED 加新关注点却不含原文本 → 归档时细节丢失。若并未明确改既有需求，请在 ADDED 下加新需求。

4. **写入文件** → `codument/tracks/<track_id>/behavior_deltas/<capability>/delta.xml`。
5. **用户确认**："我已起草了行为规范。请审查：文件路径在 `codument/tracks/<track_id>/behavior_deltas/<capability>/delta.xml`。这是否准确捕获了需求？请建议更改或确认。" 等待并修改至确认。

> Track 至少要有一个 delta。常见错误 **"Track must have at least one delta"**：检查 `behavior_deltas/**/*.xml` 是否存在、根是否 `<behavior-patch capability="<capability>" version="1">` 且至少一个带 `selector="behavior://..."` 的 `<upsert>` / `<delete>` / `<move>` mutation。**"root must be <behavior-patch>"**：别误写成 Markdown delta，把 Requirement/Scenario 改写为 `<requirement>`/`<statement>`/`<suite>`/`<case>`。

### 3.4 交互式提案（proposal.md）

behavior delta 确认后："现在我将创建完整的变更提案"。按下面格式基于描述生成 `proposal.md`：

```markdown
# 变更：<变更的简要标题>

## 背景和动机 (Context And Why)
<背景和动机，几句话说明问题 / 机会>

## "要做"和"不做" (Goals / Non-Goals)
**目标:**
- <Goal 1>
- ...

**非目标:**
- <Non-Goal 1>
- ...

## 变更内容（What Changes）
- [变更列表]
- [用 **BREAKING** 标记破坏性变更]

## 影响范围（Impact）
- 受影响的能力（behaviors）：[列出能力]
- 受影响的代码：[关键文件 / 系统]
```

- 写入 `codument/tracks/<track_id>/proposal.md`。
- 若背景 / 范围 / 兼容 / 迁移 / rollout 内容较多，建 `proposal/` 子目录把子方向写入子文件，由 `proposal.md` 作为总览引用。
  - **Good**：`proposal.md` 概述目标并链接 `proposal/problem-statement.md`、`proposal/scope-and-compatibility.md`。
  - **Bad**：把 200 行兼容性分析全塞进 `proposal.md`；或引用 track 外部文档才能读懂提案。
- **用户确认**："我已起草了变更提案。请审查：`codument/tracks/<track_id>/proposal.md`。此提案是否正确？请建议更改或确认。" 等待并修改至确认。

### 3.5 交互式方案设计（design.md，按需）

满足**任一**条件时建 `design.md`，否则省略：

- 跨切面变更（多服务 / 模块）或新架构模式；
- 新外部依赖或重大数据模型变更；
- 安全、性能或迁移复杂性；
- 编码前需技术决策消歧；
- 设计点很多需按子方向拆分。

设计内容大时建 `design/` 子目录，根级 `design.md` 作总览引用子设计。

- **Good**：`design.md` 总览方案与影响面；`design/spec-vfs-and-xml.md`、`design/archive-memory.md` 承载子方向细节。
- **Bad**：`design.md` 变成难维护的超长文档；子设计放在 track 目录外导致不自包含。

**决策记录（decisions.md，如有需用户确认的决策）：**

1. 存在需用户确认的技术 / 产品 / 交互决策时，建 `codument/tracks/<track_id>/decisions.md`，它是决策评审主入口——**无论创建 / 设计还是后续执行阶段，只要出现新决策都追加回写到该文件**，不新建分散的决策记录。某决策若属未来仍需遵守的 durable 长期项目决策，同时在 `decisions/<slug>.md` 建单文件记录并标 `Durable` / `长期项目决策`，供 archive 提升 `decision://`。
   - 问题标题**避免用字母作前缀**（字母仅用于选项）；每个问题标题用 `【Pn】` 标重要度，如 `### 1. 【P0】文件内容来源`。
2. **起草 decisions.md**：先梳理待决策问题列表并标 `P0`/`P1`/`P2`，把问题、候选选项、当前建议写入。模板：
   ```markdown
   # Decisions

   ## Usage
   - 用于记录需要用户确认的决策问题、选项、最终结论与理由
   - 问题标题不用字母前缀；字母只用于选项
   - 后续执行过程中出现的新决策，也继续追加到本文件，不新建分散的决策记录

   ### 1. 【P0】文件内容来源
   - 背景：
   - 需要决定：
   - 选项：
     - A) [选项 A]
     - B) [选项 B]
     - C) [其他（可填写）]
   - 当前建议：
   - 用户答复：
   - 最终决策：
   - 决策理由：
   - 状态：pending
   ```
3. **按问题数选交互方式**：统计尚未确认的决策问题数。
   - **≤5 且环境支持一次性多问题 ToolCall**：用内置多问题 ToolCall 一次性发问（格式遵循 **ask-multi-question-free**）；每个问题仍在 `decisions.md` 保留条目，收到答复后回写"用户答复 / 最终决策 / 决策理由 / 状态"。
   - **>5 或环境不支持**：不拆成多轮零散提问，引导用户**直接编辑** `decisions.md`；用户编辑后再据文档补全"最终决策 / 决策理由 / 状态"。

**起草 design.md：** 最小骨架：
```markdown
## 上下文
[背景、约束、利益相关者]

## 方案概览
1. [方案设计点 - 一级]
  - [方案设计点 - 二级]
    - [方案设计点 - 三级]
2. [方案设计点 - 一级]
  - [方案设计点 - 二级]
3. [...]

## 影响范围与修改点（Impact）
- 受影响的文件 / 模块：[关键文件 / 系统]

## 决策摘要
- 详见 `codument/tracks/<track_id>/decisions.md`
- 当前关键结论：[已确认的决策摘要]

## 风险 / 权衡
- [风险] → 缓解措施

## 兼容性设计 [**需要时创建**]
- [兼容性设计项]

## 迁移计划 [**需要时创建**]
[步骤、回滚]

## 待解决问题
- [...]
```

写入 `codument/tracks/<track_id>/design.md`，**用户确认**："我已起草了方案设计。请审查：`codument/tracks/<track_id>/design.md`。此方案设计是否正确？请建议更改或确认。" 等待并修改至确认。

### 3.6 起草 track.xml（核心）

proposal 获批后："现在我将根据规范创建结构化实现计划（`track.xml`）。" 读取已确认的 `proposal.md`、`behavior_deltas/**/delta.xml`、`design.md`，以及 `codument/std/sop/workflow.md`，**严格按 `track-xml-spec.md`** 生成。三轴解构（结构 / 调度 / 行为正交，互不嵌套）：

- **结构轴 `<TaskSpace>`**：工作树 + 状态。**phase = 第一层 `<TaskGroup>`**（不引入独立 `<Phase>` 标签）；phase 之下用 `<Task>`（叶）/`<TaskGroup>`（非叶）按需**多层嵌套**——**不再受旧 plan.xml 三层封顶限制**。新建时任务 `status="NOT_STARTED"`；描述用 `<Description>` 元素；阶段门控写 `<cdt:Gate>`，验收写 `<cdt:Acceptance>`。ID 约定：phase=`P{n}`、task=`T{phase}.{n}`、嵌套追加 `.{n}`、验收=`{taskId}-AC{n}`。
- **关键**：计划结构必须遵循 `workflow.md` 的方法论（如 TDD 的"编写测试"与"实现"成对任务）。
- **调度轴 `<Schedule>`**：见 §3.6 末尾"调度（可选）"。
- **行为轴 `<Hooks>`**：见 §3.7（同轮确认后据选择写入）。

最小骨架（顺序执行、终态 phase 人工确认）：

```xml
<Track id="add-user-auth" version="1" xmlns:cdt="urn:codument:v1">
  <Metadata>
    <Status>new</Status>
    <Goal>实现用户登录和注册功能</Goal>
    <Description>添加用户认证功能</Description>
    <CommitMode>manual</CommitMode>
    <CreatedAt>2026-06-14T10:00:00Z</CreatedAt>
    <UpdatedAt>2026-06-14T10:00:00Z</UpdatedAt>
  </Metadata>

  <Ports scope="track">
    <MaterialBundle role="input"  name="behavior-deltas" domain="behavior"  path="vfs://./behavior_deltas/"/>
    <MaterialBundle role="output" name="behavior"        domain="codument"  path="vfs://@/codument/behaviors/"/>
  </Ports>

  <TaskSpace id="space_add-user-auth" name="add-user-auth" version="1">
    <Description>实现用户登录和注册功能</Description>
    <SubNodes>
      <!-- 第一层 TaskGroup = phase -->
      <TaskGroup id="P1" name="基础设施" status="NOT_STARTED" order="0">
        <Description>搭建认证基础架构</Description>
        <cdt:Gate>
          <cdt:Criterion>所有 P0 任务 DONE</cdt:Criterion>
        </cdt:Gate>
        <SubNodes>
          <Task id="T1.1" name="创建用户数据模型" status="NOT_STARTED" order="0" priority="P0">
            <Description>定义 User 模型结构并实现基本 CRUD 操作</Description>
            <SubNodes>
              <Task id="T1.1.1" name="编写测试用例" status="NOT_STARTED" order="0"/>
              <Task id="T1.1.2" name="实现 User 模型" status="NOT_STARTED" order="1"/>
            </SubNodes>
            <cdt:Acceptance>
              <cdt:Criterion id="T1.1-AC1" checked="false">User 模型通过测试</cdt:Criterion>
            </cdt:Acceptance>
          </Task>
        </SubNodes>
      </TaskGroup>
    </SubNodes>
  </TaskSpace>

  <!-- §3.7 据校验模式选择，把 <cdt:GapLoop>/<cdt:HumanConfirm>/<cdt:AttractorCheck> 挂进对应 phase 的 <Hooks> -->
</Track>
```

**调度（可选）。** 默认每层依次执行（可不写 `<Schedule>`，wave 由依赖派生，不手维护 `<waves>`/`wave=`）。某层直接下层需并行时：给该 `TaskGroup`（或 `TaskSpace`）加 `cdt:child-mode="dag"`，再在 `<Schedule>` 声明**那一层直接下层之间**的依赖——前驱用 `<After ref>` **子元素**（一个前驱一行，不用空格分隔的属性串）：

```xml
<Schedule>
  <Dag for="P1">                <!-- for 必须指向一个 cdt:child-mode="dag" 的节点 -->
    <Node id="T1.3">
      <After ref="T1.1"/>
      <After ref="T1.2"/>
    </Node>
  </Dag>
  <Parallel max-concurrent="3" spot-check="true"/>
</Schedule>
```

一个 `<Dag>` 只描述一个父节点的直接下层之间的边（不跨层、不跨父）；后续 `codument-plan-schedule` skill 也可补这一步。

写入 `codument/tracks/<track_id>/track.xml`。

### 3.7 同轮确认：提交模式 + 校验模式 + 方向审查

这是关键交互：展示起草的 `track.xml`，在**同一条**回复里让用户给出全部选择：

> "我已起草了实现计划。请审查：`codument/tracks/<track_id>/track.xml`。如需修改请直接说明。
>
> 请选择本次 Track 的**提交模式**：
> **A. 自动提交（auto）** — 任务完成后自动 commit + Git Notes
> **B. 手动提交（manual）** — 由你自行控制提交时机
>
> 请选择本次 Track 的**校验模式**：
> **C. 人工确认（cdt:HumanConfirm）** — 由用户在确认点审阅后继续
> **D. Gap Loop（cdt:GapLoop）** — 当前 agent 到达确认点后结束，由父层 fresh-spawn 新的 gap-loop agent 做目标对比、gap 报告和修正
>
> 若选 **D**，再选**校验粒度**：
> **E. 仅最后一个 phase 校验（final_phase，默认）**
> **F. 每个 phase 都校验（every_phase）**
>
> **方向审查**默认开启：每个第一层 phase 完成后执行 `coding` AttractorCheck，即在每个第一层 `<TaskGroup>` 写入 `<Hook on="phase:after"><cdt:AttractorCheck use="coding"/></Hook>`。
> 如需覆盖默认，请明确选择：**否** | **仅终态 phase** | **每个 phase**（profile：编码用 `coding`；docs 同步 track 可改用 `docs`）
>
> 你可以在同一条回复里同时给出「修改意见 + 提交模式（A/B）+ 校验模式（C/D）+ 可选粒度（E/F）+ 方向审查范围」。"（**ask-single-question-free**）

等待反馈、修改 `track.xml` 至确认，然后据选择写入。若用户没有明确覆盖方向审查范围，**默认每个第一层 `TaskGroup` 都挂 `phase:after` 的 `<cdt:AttractorCheck use="coding"/>`**。**校验模式塌缩到 track.xml 节点**：旧 `validation_mode`/`validation_granularity` = "在终态 phase（或每个 phase）挂哪个 typed check"——`final_phase` = 仅最后一个第一层 `TaskGroup` 挂；`every_phase` = 每个都挂。这些 typed check **配置直接写在节点上，无独立定义文件**（见 track-xml-spec §6）：

| typed check | 配置（在节点属性上） | 取代旧 |
|---|---|---|
| `<cdt:GapLoop max-rounds="5" on-exhausted="block"/>` | `max-rounds` 上限、`on-exhausted` | `validation_mode=yield-gap-loop` + `<confirm protocol="yield-gap-loop">` |
| `<cdt:HumanConfirm/>` | 暂无属性 | `validation_mode=yield-human-confirm` + `<confirm protocol="yield-human-confirm">` |
| `<cdt:AttractorCheck use="coding\|docs"/>` | `use` = `config/attractor-profiles.xml` 的 profile 名；审查器固定 **fresh-subagent**（std 约定，不配置） | `<attractor-check>` |

写入分支：

```text
@delimiter: --
-- #sequence ?apply
---- #step ?w0
据 A/B 写 Metadata.CommitMode（auto | manual）；更新 Metadata.UpdatedAt
---- /?w0
---- #switch ?mode on="校验模式"
------ #case ?gap when="D（gap-loop）"
-------- #step ?g1
未明确选粒度时默认 final_phase
-------- /?g1
-------- #if ?g2 cond="粒度 = final_phase"
仅在最后一个第一层 TaskGroup 的 <Hooks> 挂 <Hook on="phase:after"><cdt:GapLoop max-rounds="5" on-exhausted="block"/></Hook>
-------- /?g2
-------- #else ?g3
每个第一层 TaskGroup 的 <Hooks> 都挂同样的 <cdt:GapLoop>
-------- /?g3
------ /?gap
------ #case ?human when="C（人工确认）"
不再询问粒度；默认仅在最后一个第一层 TaskGroup 挂 <Hook on="phase:after"><cdt:HumanConfirm/></Hook>
------ /?human
---- /?mode
---- #switch ?attr on="方向审查范围"
------ #case ?a0 when="未明确"
每个第一层 TaskGroup 都挂 <Hook on="phase:after"><cdt:AttractorCheck use="coding"/></Hook>
------ /?a0
------ #case ?a1 when="否"
不挂 AttractorCheck
------ /?a1
------ #case ?a2 when="仅终态 phase"
仅最后一个第一层 TaskGroup 挂 <Hook on="phase:after"><cdt:AttractorCheck use="coding|docs"/></Hook>
------ /?a2
------ #case ?a3 when="每个 phase"
每个第一层 TaskGroup 都挂 <Hook on="phase:after"><cdt:AttractorCheck use="coding|docs"/></Hook>
------ /?a3
---- /?attr
-- /?apply
```

挂好后 `<Hooks>` 形如：

```xml
<TaskGroup id="P3" name="docs 同步与收尾" status="NOT_STARTED" order="2">
  ...
  <Hooks>
    <Hook on="phase:after"><cdt:GapLoop max-rounds="5" on-exhausted="block"/></Hook>
    <Hook on="phase:after"><cdt:AttractorCheck use="docs"/></Hook>
  </Hooks>
</TaskGroup>
```

> 旧 `gap_loop_round` 不再写计划：gap-loop 轮次由父层在运行期记到 `<Metadata>` 的 `gap-round`（见 `gap-loop.md`），创建阶段无需初始化。

### 3.8 收尾

1. **确认真相源**：`track.xml` 的 `<Metadata>` 已含 track 元信息与状态。**不**创建 / 更新 `codument/tracks.md`，**不**创建 / 更新 `metadata.json`。
2. **best-effort validate**：尝试 `codument validate <id> --strict`；若系统找不到 `codument` 命令，**跳过并明确说明**（"外部 codument validate 未执行，原因是系统中找不到 codument 命令"），不因此阻塞。validate 会检查：根 `<Track id>`、`<Metadata><Status>` 合法、`<TaskSpace>` 第一层至少一个 phase、id 全局唯一、`status` 是枚举、每个 `<Dag for>` 指向 `dag` 层且其 `<After ref>` 只引用直接下层且无环、`<Hook on>` 合法、`<cdt:AttractorCheck use>` 能解析到 profile（见 track-xml-spec §9）。
3. **宣布完成**：
   > "新 track '<track_id>' 已创建。
   > 状态真源：`codument/tracks/<track_id>/track.xml`
   > 提交模式：<auto|manual>
   > 校验模式：<cdt:HumanConfirm|cdt:GapLoop>
   > 你现在可以运行 `请使用 codument-implement skill, 实现 track: <track_id>` 开始实现。"

---

## 4. 门控（gates）

- **提案获批前不开始实现**（这是 `codument-implement` 的前置门控）。
- 若 `codument/config/operation-hooks.xml` 为 `operation name="track"` 配置了 `track:after-design` 或 `track:after-plan` hook（如设计后方向审查），按其 hook DSL 执行——这是**命令级 hook**（无 track.xml 宿主的操作走 `operation-hooks.xml`），与 track.xml 里的节点级 `<Hook>` **同语法、不同宿主**。`operation-hooks.xml` 缺失时按默认流程继续，不加额外等待。

---

## 5. 引用

- `codument/std/spec/track-xml-spec.md` —— track.xml 三轴规范与目录布局（§0.5）
- `codument/std/sop/questioning.md#ask-single-question-free` / `#ask-multi-question-free`
- `codument/config/attractor-profiles.xml` —— `coding`/`docs`/`memory` profile 定义（取代旧 feature.json）
- `codument/config/operation-hooks.xml` —— 命令级 hook
