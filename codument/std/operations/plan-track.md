# skill: codument-plan-track（创建变更追踪）

为一个新功能 / Bug 修复 / 变更创建一条 **Track**：引导用户收集信息，生成行为增量（`behavior_deltas/<capability>/delta.xnl`）、提案（`proposal.md`）、设计（`design.md`）和状态真源 `track.xnl`。普通调用创建 pending Track；由 `codument-impl-mission` 以 `QuestionSeverity=auto` 调用时直接创建 active Track，后续始终使用 CLI receipt 返回的目录。

> 本文以 **Markdown 为主**：程序化控制流使用流程标记块，Track 与 BehaviorPatch 资源使用当前 Kind 定义的 XNL。遇到 legacy authority 时先运行 `codument upgrade-resource <path>`。

---

## 0. 意图、触发与产物

**意图。** 为一个新功能 / 变更建 track：收集信息 → 起草行为增量与 `track.xnl` → 同轮收集提交模式 / 校验模式 / 方向审查 → 等待批准。**提案获批前不开始实现**——除非由 `codument-impl-mission` 以 `QuestionSeverity=auto` 调用，此时 mission 层代为批准、创建即激活（见 §3.2 调用方上下文）。

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

**产物（写入 CLI receipt 的 `<track-dir>/`）。**

| 产物 | 必有？ | 内容 |
|---|---|---|
| `track.xnl` | ★必有 | 状态真源（结构 / 调度 / 行为三轴，见 track-xnl-spec） |
| `proposal.md` | ★必有 | 为什么 / 是什么 / 目标-非目标 / 变更内容 / 影响 |
| `behavior_deltas/<cap>/delta.xnl` | ★必有 | CLI scaffold 的版本化 `<BehaviorPatch>` 行为增量 |
| `design.md`（+`design/`） | ★必有 | 方案 / 决策摘要 / 风险 / 兼容 / 迁移 |
| `analysis/{findings,knowledge}.md` | 按需 | 规划期 planning-with-files 外部记忆 |
| `decisions.xnl` | 有决策时 | 过程决策 forest 入口；无 decision 时不创建；首个节点由 `codument decisions create` 生成 |
| `decisions/**/*.xnl` | 按需 | 按 owner/topic 分片的层级 decision forest；与根文件同时参与 |
| `memory/` | 按需 | 长期记忆候选 |
| `reports/` | 运行期生成 | gap-loop / verify 报告 |

完整目录布局与提升时机见 `track-xnl-spec.md` §0.5。

---

## 1. 设置检查（前置）

开始前验证 Codument 已正确初始化：

- 存在 `codument/std/`（含 `std/spec/track-xnl-spec.md`、`std/methods/workflow.md`）；
- 存在项目上下文 `codument/attractors/`（如 `attractors/project.md`、`attractors/product.md`）。

任何一项缺失就**立即停止**，宣告"Codument 未设置。请先运行 `codument init` 初始化工作区。"，**不要**继续建 track。

---

## 2. 产物的可引用范围（硬规则）

生成的产物在引用其他文件时必须遵守：

- **不可引用 `.` 开头隐藏目录**中的文档（如 `.abc/e.md`）。
- 每个 track 目录的内容必须**自包含**：**不可引用 track 目录之外**的说明文档（如 `doc/`、`docs/` 里的解释文档）作为读懂本 track 的必要前提。
- 若仅靠 `behavior_deltas/<capability>/delta.xnl`、`proposal.md`、`design.md`、`track.xnl` 不足以记录关键信息（如 `example.md`、`ui-ux-design.md`），可在**当前 track 目录内**额外建文件，并由上述标准产物引用之。

---

## 3. 新建 Track（主流程）

严格按下面顺序执行。开始时直接读取与当前目标相关的项目 attractor、行为、代码与测试，作为短项目约束上下文；这不是 fresh AttractorCheck。若 `codument/config/operation-hooks.xnl` 显式为 `plan-track:before` 配置 hook，才按 hook DSL 执行。

开始时按 `codument/std/protocols/decision-tree.md` 解析 severity、依赖图和当前拓扑问题批次。`auto` 模式下不提问、不等待确认，改为写入假设并选择保守默认；其他模式才按 **ask-multi-question-free** / **ask-multi-question-closed** 一次询问同批 ready 问题。

```text
@delimiter: --
-- #sequence ?create
---- #if ?before cond="operation-hooks.xnl 为 plan-track 显式配置了 plan-track:before"
执行显式 plan-track:before hook
---- /?before
---- #step ?s1
§3.0 解析 questioning severity（默认 light；auto=无问答）并建立 decision-tree 初稿；§3.1 取得 track 描述、推断类型、加载项目上下文
---- /?s1
---- #step ?s2
§3.2 起 track-id、查重、按 severity 决定是否确认、用 CLI scaffold 建版本化骨架，按需建立 analysis/ decisions/ memory/
---- /?s2
---- #step ?s3
§3.3 按 severity 起草 behavior_deltas/<cap>/delta.xnl；auto 不确认，其他模式按需确认
---- /?s3
---- #if ?s3m cond="modeling 默认启用（config/modeling.xnl 缺失或未显式 enabled=false），且 track 改变对象、状态机、policy、模块边界、事实源、actor/component IO 等结构知识"
§3.3b 参考 behavior_deltas 与代码/owner 文档，起草 modeling_deltas/<plane>/<context>.xnl（目标态节点，XNL）；仅在实际生成 delta 时记录当前 codument/modeling 的宿主 git commit 作 3-way base（写入 track 元信息）。规范见 std/spec/modeling-{registry,delta,node-schema}.md（其 §9 语言约定：描述/注释/pseudo/mermaid 标签用中文，interface/字段/kind/枚举/#id 等标识符保持英文）。显式 enabled=false 时跳过；modeling 虽启用但 track 无结构变化时也跳过，不生成空 delta / registry。
§3.3b 自检：写完 / 编辑 modeling_deltas 后，运行 `codument modeling validate --deltas <track_id>`；若报 error，按报告（file/line/layer/reason）修正 modeling_deltas 再继续，直到 0 error。missing/empty registry 是合法初态并只报 warning；非空 registry 仍要求 domain plane。
---- /?s3m
---- #if ?s3e cond="config/engineering.xnl 存在且 enabled=true"
§3.3c 参考 docs-engineering-fractal 与 engineering specs，起草 engineering_deltas/<plane>/<category>/<topic>.xnl（长期工程知识目标态节点，XNL）；记录当前 codument/engineering 的宿主 git commit 作 3-way base（写入 track 元信息）。规范见 std/spec/engineering-{registry,delta,node-schema}.md。engineering 未启用则跳过。
§3.3c 自检：写完 / 编辑 engineering_deltas 后，运行 `codument engineering validate --deltas <track_id>`；若报 error，按报告（file/line/layer/reason）修正 engineering_deltas 再继续，直到 0 error。本自检与 §3.3c 同样 gated on config/engineering.xnl。
---- /?s3e
---- #step ?s4
§3.4 起草 proposal.md；auto 不确认，其他模式按需确认
---- /?s4
---- #step ?s5
§3.5 起草 design.md；只有存在真实 decision 时才创建 decisions.xnl；auto 不确认，其他模式按需确认
---- /?s5
---- #step ?s6
§3.6 起草 track.xnl（结构 + 调度）
---- /?s6
---- #step ?s7
§3.7 按 severity 处理提交模式 + 校验模式（+gap-loop 粒度）+ 方向审查 → 写 Hooks；auto 使用默认值不提问
---- /?s7
---- #step ?s8
§3.8 收尾：validate（best-effort）+ 宣布完成与下一步
---- /?s8
-- /?create
```

### 3.0 Decision-tree pass

遵循 `std/protocols/decision-tree.md`：未指定 severity 时使用 `light`，先用本地证据消除问题，再计算当前拓扑 ready set 并一次询问该批次。多个根问题必须并列进入可用批次，只有依赖已解决的子问题才能在后续批次出现。`auto` 不提问，默认 `CommitMode=manual`，也不默认挂 `HumanConfirm`、`AttractorCheck` 或 `GapLoop`。

### 3.1 取得描述、确定类型、加载上下文

1. **加载项目上下文**：读 `codument/attractors/` 下与任务相关的吸引子。先 `codument list` / `codument list --behaviors` 看现状，避免重复能力——**能改既有 behavior 就不要新建**。
2. **取得 Track 描述**：`{{args}}` 含描述则用之；为空时按 severity 处理：`auto` 模式从当前用户请求和上下文推断，不提问；其他模式问"请提供你想开始的变更追踪的简要描述（功能、Bug 修复、重构等）。"并等待回复（**ask-single-question-free**）。
3. **推断类型**：分析描述判定"功能"或"其他（Bug、重构等）"，**不要**让用户分类。

> **提问纪律**：问答 ToolCall 只用于真实澄清 / 选择 / 确认；**禁止**为测试运行环境能力发占位问题。当前没有要问的就直接往下。

### 3.2 建目录与元信息及调用方上下文（mission 连续执行）

1. **查重**：在 `codument/tracks/{pending,active,archived}/` 查重；若提议短名与任一生命周期目录中的 track 重复，停止并建议换名。
2. **生成 Track ID**：小写英文 + 中横线的简短描述，**动词开头**（`add-`、`update-`、`remove-`、`refactor-`），如 `add-user-auth`、`fix-login-bug`。**不含日期**（日期只在归档时加）；若已被占用，追加 `-2`、`-3`。
3. **按 severity 处理 ID 歧义**：`auto` 模式直接采用生成的 track-id，并把命名依据写入 `analysis/findings.md`。其他模式只有在命名确实会改变范围或与现有 id 难以区分时，才把它作为一个 ready decision 加入当前拓扑 batch；不得为单独确认 id 打断其他独立问题。命名依据不是决策节点，不得为它单独创建 `analysis/decision-tree.xnl`。
4. **用 CLI 建版本化骨架**：普通规划运行 `codument track create <track_id> --stage pending`；由 `codument-impl-mission` 以 `QuestionSeverity=auto` 调用时运行 `codument track create <track_id> --stage active`。CLI 只接收 ID 与 stage，生成当前 Kind `apiVersion` 对应的 `track.xnl`、`proposal.md`、`design.md`，拒绝覆盖已有目录且不创建空 `decisions.xnl`。后续路径一律使用 CLI receipt 的 `directory`；Mission 调用方再运行 `codument mission bind-track`。
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
6. **建决策与记忆目录**（仅有合格内容时创建，已存在则跳过）：
   - `decisions/` —— 仅在 decision forest 需要按 owner/topic 分片时创建，内容使用递归 `*.xnl`；它与根 `decisions.xnl` 共同组成 source set。
   - 根级 `decisions.xnl` 只在首次出现真实 decision 时创建：运行 `codument decisions create <track-dir>/decisions.xnl <decision-id>`，再填写语义并运行 `codument decisions validate <file>`；无 decision 时不落空文件。嵌套 decision 使用 `--parent <decision-id>`。
   - `memory/` —— 记忆上下文，按类型分子目录 `lessons/`、`incidents/`、`patterns/`、`summaries/`（归档且 `memory` profile 启用时提升 `memory://`）。
7. **填写 Track 骨架**（§3.6 一并落盘）：保留 CLI 创建的 identity、Kind version 与通道结构，按 `track-xnl-spec.md` 填写业务字段。

### 3.3 交互式行为增量（BehaviorPatch XNL）

1. **说明目标**："现在我将通过一系列问题帮你构建全面的行为规范（`behavior_deltas/<capability>/delta.xnl`）。为提速，我会在一轮里给出多个问题，并用 Q1、Q2… 标记，按标记回答即可。"
2. **提问阶段**（**ask-multi-question-free**）：按 track 类型收集 delta 细节。
   - 参考 `codument/attractors/` 相关吸引子提**上下文感知**的问题；
   - 每问给简要解释 + 清晰示例；**强烈建议**尽量给 2-3 个选项供选。
   - **功能**：问 3-5 个问题澄清需求（功能澄清、实现方式、交互、输入/输出等），按具体请求定制。
   - **其他（Bug / 重构等）**：问 2-3 个问题（复现步骤、重构范围、成功标准等）。
3. **CLI 生成版本化骨架**：对每个 capability 运行 `codument behavior-patch create <track_id> <capability>`。CLI 解析 pending/active owner 并创建当前 Kind 版本的 `behavior_deltas/<capability>/delta.xnl`。
4. **在骨架中起草 behavior delta**：保留根 `#id`、`apiVersion`、`version` 与 `capability`，只编写 mutation 和行为正文。

   XNL 结构、mutation 与 BDD 节点由 `std/spec/behavior-delta.md` 定义，并由 `codument validate <track-id> --strict` 校验。AI 负责写清 SHALL/MUST 行为、场景和业务 selector，不在 operation 中复制 schema 清单。

   **示例：**
   ```xnl
   <BehaviorPatch #track.add-cache.behavior_patch.provider.deepseek apiVersion="codument.tech/v1alpha1" version="1" { capability = "provider.deepseek" } (
     <Mutations [
       <Upsert { selector = "behavior://provider.deepseek/requirements/cache-support" } (
         <Requirement #cache-support (
           <Statement ?>系统 SHALL 支持 DeepSeek provider 的前缀缓存能力。</?>
           <Suites [
             <Suite #request-build { name = "请求构建" } (
               <Cases [
                 <Case #inject-cache-control (
                   <Given ?>provider 为 deepseek 且 model 声明 supports_context_cache</?>
                   <When ?>系统构造 chat completion 请求</?>
                   <Then ?>系统 SHALL 在静态系统提示末尾插入 cache_control 块</?>
                 )>
               ]>
             )>
           ]>
         )>
       )>
     ]>
   )>
   ```

   **拆分规则：**
   - 每个 capability 一个目录：`behavior_deltas/<capability>/delta.xnl`。
   - 当前每个 capability 只有 CLI scaffold 的 `delta.xnl` 是 BehaviorPatch authority。内容过大时先按稳定业务边界拆成多个 capability，再分别运行 `codument behavior-patch create`；不要手工新增没有 CLI receipt 的 patch 文件。
   - 不引用当前 track 外的说明文档作为理解本 track 的必要条件。

5. **处理新决策，不做逐产物确认**：`auto` 模式不提问，直接继续；普通假设写入 `analysis/findings.md`、`proposal.md` 或 `design.md`，只有真实取舍才写入 Decision forest。复杂前沿可使用 `analysis/decision-tree.xnl`；写入后运行 `codument decisions validate <file>` 与 `codument decisions frontier <file> --json`，按 CLI 返回的 ready batch 继续。其他模式把真正新增且未解决的取舍加入下一批，不只为“审查行为文件”单独等待确认。

> Track 至少要有一个 delta。运行 `codument validate <track-id> --strict` 校验 BehaviorPatch 和 selector；legacy 资源先用 `codument upgrade-resource` 升级。

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

- 写入 `<track-dir>/proposal.md`。
- 若背景 / 范围 / 兼容 / 迁移 / rollout 内容较多，建 `proposal/` 子目录把子方向写入子文件，由 `proposal.md` 作为总览引用。
  - **Good**：`proposal.md` 概述目标并链接 `proposal/problem-statement.md`、`proposal/scope-and-compatibility.md`。
  - **Bad**：把 200 行兼容性分析全塞进 `proposal.md`；或引用 track 外部文档才能读懂提案。
- **处理新决策，不做逐产物确认**：`auto` 模式不提问，直接继续，并把未确认假设保留在提案 / decision-tree；其他模式仅把提案暴露出的新增 scope / 不可逆取舍加入下一拓扑 batch，不为单独审查 proposal 阻塞规划。

### 3.5 方案与决策（design.md 必有，decisions.xnl 按需）

每个新 track 都由 CLI scaffold 创建 `design.md`。只有出现真实 decision 时才创建 `decisions.xnl` 并默认写入根文件；无待决事项时不落空 forest。forest 需要按 owner/topic 分片时可建立递归 `decisions/**/*.xnl`，但根文件与递归文件始终作为一个 source set 读取。

设计内容大时建 `design/` 子目录，根级 `design.md` 作总览引用子设计。

- **Good**：`design.md` 总览方案与影响面；`design/spec-vfs-and-xml.md`、`design/archive-memory.md` 承载子方向细节。
- **Bad**：`design.md` 变成难维护的超长文档；子设计放在 track 目录外导致不自包含。

**决策记录（decisions.xnl）：**

1. 首次出现真实 decision 时运行 `codument decisions create <track-dir>/decisions.xnl <decision-id>`；普通新决策默认回写根文件，嵌套节点使用 `--parent`。只有明确需要 owner/topic 分片时才写入递归 `decisions/**/*.xnl`。长期项目决策按 stable id 合并进长期 registry。
2. **起草 decisions.xnl**：先梳理待决策 forest 并标 `P0`/`P1`/`P2`，把问题、候选选项、当前建议写入。嵌套 `<decision>` 表示需要先解决父问题的细化；跨分支前置条件用 `depends_on = ["decision-id"]`，不要滥用 `blocks`。下例是 `codument decisions create` 生成骨架后的填写结果；保留命令写入的 `#id` 与 `apiVersion`，不要从示例复制版本：
   ```xnl
   <decision #track.example.decision_1 apiVersion="codument.tech/v1alpha1" {
     priority = "P0"
     status = "pending"
     blocks = ["design.md" "track.xnl"]
   }
   (
     <question ?>需要决定的问题是什么？</?>
     <options { } [
       <option { key = "A" recommended = true }
       (
         <title ?>选项 A 标题</?>
         <description ?>选项 A 的详细说明。</?>
         <tradeoff ?>选项 A 的代价、风险或取舍。</?>
       )
       >
       <option { key = "B" }
       (
         <title ?>选项 B 标题</?>
         <description ?>选项 B 的详细说明。</?>
         <tradeoff ?>选项 B 的代价、风险或取舍。</?>
       )
       >
       <option { key = "C" }
       (
         <title ?>其他方案</?>
         <description ?>用户可补充的其他可行方案。</?>
         <tradeoff ?>需要补充其影响和取舍。</?>
       )
       >
     ]>
     <recommendation ?>当前建议是什么？</?>
     <answer { }
     (
       <raw-answer ?>待用户答复。</?>
       <decision-text ?>待确认。</?>
       <rationale ?>待补充决策理由。</?>
       <evidence ?>支撑当前问题和推荐的代码、文档或用户要求。</?>
     )
     >
   )
   >
   ```
3. **按拓扑批次选交互方式**：先根据 `decision-tree.md` 计算 ready set，而不是统计全部 pending 问题。
   - 从每个未阻塞根和每个依赖已解决的分支各取可用节点，按 `P0 → P1 → P2` 及稳定 id 排序；按 severity 的每轮上限形成一个 batch。即使一个根已有更多细化问题，也不得先追问它而遗漏同批其他根。
   - **环境支持多问题 ToolCall**：对该 batch 用 **ask-multi-question-closed**（有 options）或 **ask-multi-question-free**（开放题）一次性发问；每个问题仍在 `decisions.xnl` 保留条目，收到答复后回写 `<answer>` 下的 `<raw-answer>` / `<decision-text>` / `<rationale>` / `<evidence>` 以及 `status`，然后重算下一 batch。
   - **环境不支持批量 ToolCall**：仍按同一 batch 的稳定顺序展示问题并提示用户一次回复多个 Q 编号；不得改为沿单一分支的多轮追问。

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
- 详见 `<track-dir>/decisions.xnl`
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

写入 `<track-dir>/design.md`。`<track-dir>` 始终取 `codument track create` receipt；`auto` 模式直接继续，其他模式仅将设计新发现的、尚不能用本地证据解决的依赖选择加入下一拓扑 batch，不为单独审查 design.md 阻塞规划。

### 3.6 起草 track.xnl（核心）

proposal 获批后："现在我将在 CLI 已生成的当前版本 `track.xnl` 骨架内填写结构化实现计划。"读取已确认的 `proposal.md`、`behavior_deltas/**/delta.xnl`、`design.md` 与 `workflow.md`，保留 scaffold 写入的 `apiVersion`、`version`、`#id` 与 XNL 通道结构，严格按 `track-xnl-spec.md` 填充三轴内容：

- **结构轴 `<TaskSpace>`**：工作树 + 状态。phase 是 `SubNodes []` 第一层 `<TaskGroup>`；其下可递归 `<Task>` / `<TaskGroup>`。新任务在 `{ status = "NOT_STARTED" priority = "P0|P1|P2" }`；有真实阻塞时写非空 `blocker`，auto commit 后写 `commit` 证据。singleton `Description` 放 `()`，集合 `Gate` / `Acceptance` 放 `[]`。ID 约定：phase=`P{n}`、task=`P{phase}-T{n}`、验收=`{taskId}-AC{n}`。
- **关键**：计划结构必须遵循 `workflow.md` 的方法论（如 TDD 的"编写测试"与"实现"成对任务）。
- **调度轴 `<Schedule>`**：见 §3.6 末尾"调度（可选）"。
- **行为轴 `<Hooks>`**：见 §3.7（同轮确认后据选择写入）。

最小骨架必须沿用 CLI scaffold，并按 `track-xnl-spec.md` 的 canonical DSL 扩写。下例展示 scaffold 输出被填写后的核心形态；其中 `#id`、`apiVersion`、`version` 与时间字段均来自 CLI，不从示例复制：

```xnl
<Track #add-user-auth apiVersion="codument.tech/v1alpha1" version="1" {
  status = "new"
  goal = "实现用户登录和注册功能"
  description = "添加用户认证功能"
  question_mode = "decision-tree"
  question_severity = "light"
  commit_mode = "manual"
  created_at = "2026-08-15T10:00:00Z"
  updated_at = "2026-08-15T10:00:00Z"
} (
  <Ports { scope = "track" } [
    <MaterialBundle #behavior_deltas { role = "input" name = "behavior-deltas" domain = "behavior" path = "vfs://./behavior_deltas/" }>
  ]>
  <TaskSpace #space_add-user-auth { name = "add-user-auth" version = "1" } (
    <SubNodes [
      <TaskGroup #P1 { name = "基础设施" status = "NOT_STARTED" priority = "P0" order = 0 } (
        <Description ?>搭建认证基础架构。</?>
        <SubNodes [
          <Task #P1-T1 { name = "创建用户数据模型" status = "NOT_STARTED" priority = "P0" order = 0 }>
        ]>
      )>
    ]>
  )>
  <Schedule []>
  <Hooks []>
)>
```

**调度（可选）。** 默认每层依次执行。某层直接下层需并行时，在该 `TaskGroup`（或 `TaskSpace`) 的 `{}` 写 `child_mode = "dag"`，再在 `<Schedule []>` 声明该层直接下层之间的依赖：

```xnl
<Schedule { max_concurrent = 3 spot_check = true } [
  <Dag { for = "P1" } [
    <Node #P1-T3 [
      <After { ref = "P1-T1" }>
      <After { ref = "P1-T2" }>
    ]>
  ]>
]>
```

一个 `<Dag>` 只描述一个父节点的直接下层之间的边（不跨层、不跨父）；`Schedule.max_concurrent` 是正整数，`spot_check` 是 boolean。后续也可由 `codument-maintain-track` 的 `schedule` mode 补这一步。

写入 CLI receipt 返回的 `<track-dir>/track.xnl`。

### 3.7 一个拓扑批次：提交模式 + 校验模式 + 方向审查

这是关键交互：展示起草的 `track.xnl`，在**同一条**回复里让用户给出全部选择。若 severity 为 `auto`，跳过本交互，使用默认值：`CommitMode=manual`，不挂 `HumanConfirm`、`GapLoop` 或 `AttractorCheck`：

> "我已起草了实现计划。请审查：`<track-dir>/track.xnl`。如需修改请直接说明。
>
> 请选择本次 Track 的**提交模式**：
> **A. 自动提交（auto）** — 任务完成后自动 commit + Git Notes
> **B. 手动提交（manual）** — 由你自行控制提交时机
>
> 请选择本次 Track 的**校验模式**：
> **C. 人工确认（HumanConfirm）** — 由用户在确认点审阅后继续
> **D. Gap Loop（GapLoop）** — 当前 agent 到达确认点后结束，由父层 fresh-spawn 新的 gap-loop agent 做目标对比、gap 报告和修正
>
> 若选 **D**，再选**校验粒度**：
> **E. 仅最后一个 phase 校验（final_phase，默认）**
> **F. 每个 phase 都校验（every_phase）**
>
> 若选 **D**，再选**是否启用 gap-loop 验证轮（`verify_round`）**——即首轮无 gap（`NO_GAP`）后是否再 fresh-spawn 一轮（轻量）验证轮做首轮怀疑：
> **G. 启用（`verify_round = true`）** — 首轮 `NO_GAP` 后再追一轮轻量验证
> **H. 不启用（`verify_round = false`，默认）** — 首轮 `NO_GAP` 直接收口
>
> **方向审查**默认关闭。只有明确属于架构、安全或数据一致性高风险的 track，才在最后一个第一层 phase 写入 `<Hook { on = "phase:after" } (<AttractorCheck { use = "coding" }>)>`；docs 维护仅使用 `docs` profile 的显式 hook。
>
> 你可以在同一条回复里同时给出「修改意见 + 提交模式（A/B）+ 校验模式（C/D）+ 可选粒度（E/F）+ 验证轮（G/H）+ 方向审查范围」。"（**ask-multi-question-closed**）

将这些 ready 配置问题与同批其他独立问题一起等待反馈、回写 `track.xnl`，然后重算是否出现依赖于校验模式的新问题。若用户没有明确要求且 track 不属于架构、安全或数据一致性高风险，**不挂 AttractorCheck**。高风险 track 默认只在最后一个第一层 `TaskGroup` 挂一个 `phase:after` 的 `<AttractorCheck { use = "coding" }>`。`final_phase` 表示仅最后一个第一层 `TaskGroup` 挂 check，`every_phase` 表示每个都挂。typed check 直接写在节点上，无独立定义文件（见 track-xnl-spec §6）：

| typed check | 当前 XNL 配置 |
|---|---|
| `<GapLoop { max_rounds = 5 on_exhausted = "block" verify_round = false }>` | 轮次上限、耗尽策略与首轮怀疑验证轮开关 |
| `<HumanConfirm>` | 无属性 |
| `<AttractorCheck { use = "coding\|docs" }>` | `use` 指向 `config/attractor-profiles.xnl` 的 profile；审查器固定 fresh-subagent |

写入分支：

```text
@delimiter: --
-- #sequence ?apply
---- #step ?w0
据 A/B 写 Track 根 `{ commit_mode = "auto|manual" }`；生命周期时间字段仍由 CLI 维护
---- /?w0
---- #switch ?mode on="校验模式"
------ #case ?gap when="D（gap-loop）"
-------- #step ?g1
未明确选粒度时默认 final_phase；未明确选验证轮（G/H）时 `verify_round` 取全局默认 false
-------- /?g1
-------- #step ?g1b
据 G/H 定 `verify_round` 值（G→true、H/默认→false）；所挂的每个 `<GapLoop>` 都写 `{ verify_round = <该值> }`
-------- /?g1b
-------- #if ?g2 cond="粒度 = final_phase"
仅在最后一个第一层 TaskGroup 的 `<Hooks>` 挂 `<Hook { on = "phase:after" } (<GapLoop { max_rounds = 5 on_exhausted = "block" verify_round = <G/H 值> }>)>`
-------- /?g2
-------- #else ?g3
每个第一层 TaskGroup 的 `<Hooks>` 都挂同样的 `<GapLoop { ... verify_round = <G/H 值> }>`
-------- /?g3
------ /?gap
------ #case ?human when="C（人工确认）"
不再询问粒度；默认仅在最后一个第一层 TaskGroup 挂 `<Hook { on = "phase:after" } (<HumanConfirm>)>`
------ /?human
---- /?mode
---- #switch ?attr on="方向审查范围"
------ #case ?a0 when="未明确且非高风险"
不挂 AttractorCheck
------ /?a0
------ #case ?a1 when="否"
不挂 AttractorCheck
------ /?a1
------ #case ?a2 when="高风险或明确选择仅终态 phase"
仅最后一个第一层 TaskGroup 挂 `<Hook { on = "phase:after" } (<AttractorCheck { use = "coding|docs" }>)>`
------ /?a2
------ #case ?a3 when="明确选择每个 phase"
每个第一层 TaskGroup 都挂 `<Hook { on = "phase:after" } (<AttractorCheck { use = "coding|docs" }>)>`
------ /?a3
---- /?attr
-- /?apply
```

挂好后 `<Hooks []>` 形如：

```xnl
<TaskGroup #P3 { name = "docs 同步与收尾" status = "NOT_STARTED" order = 2 } (
  <Hooks [
    <Hook { on = "phase:after" } (
      <GapLoop { max_rounds = 5 on_exhausted = "block" verify_round = false }>
    )>
    <Hook { on = "phase:after" } (
      <AttractorCheck { use = "docs" }>
    )>
  ]>
)>
```

> `verify_round` 一经在 §3.7 据用户答复（G/H，缺省取全局默认 false）确定，**本 track 所有 GapLoop 节点沿用同一设置**；后续追加 phase 时新挂的 `<GapLoop>` 也沿用同一值。它控制「首轮 `NO_GAP` 后是否再追一轮（轻量）验证轮」，运行期语义见 `gap-loop.md`。
>
> GapLoop 只按上述粒度挂在第一层 phase 的 `phase:after`。只要任一 phase 已配置 GapLoop，就不得再在 Track 根配置 `track:after GapLoop`，避免同一收敛检查执行两次。
>
> GapLoop 每轮运行 `codument track gap-round <track-id> <round>`，由 CLI 写入 Track 根 `gap_round` 与更新时间；创建阶段无需初始化。

### 3.8 收尾

1. **确认真相源**：`track.xnl` 的 `#id`、系统 metadata 与根 `{}` 已含资源身份、版本、普通属性和状态。
2. **best-effort validate**：尝试 `codument validate <id> --strict`；若系统找不到命令则跳过并明确说明，不因此阻塞。validate 检查 XNL 通道、根字段、TaskSpace、DAG、Hooks、引用与 required files（见 `track-xnl-spec.md` §8）。
3. **宣布完成**：
   > "新 track '<track_id>' 已创建。
   > 状态真源：`<track-dir>/track.xnl`
   > 提交模式：<auto|manual>
   > 校验模式：<HumanConfirm|GapLoop>
   > 你现在可以运行 `请使用 codument-impl-track skill, 实现 track: <track_id>` 开始实现。"

---

## 4. 门控（gates）

- **提案获批前不开始实现**（这是 `codument-impl-track` 的前置门控）。例外：由 `codument-impl-mission` 在 `QuestionSeverity=auto` / 连续执行模式下调用时，mission 层代为批准，track 创建即激活后即可进入 `codument-impl-track`（见 §3.2 调用方上下文）。
- 若 `codument/config/operation-hooks.xnl` 为 `operation name="plan-track"` 显式配置了 `plan-track:before` hook，才在规划前执行；没有 hook 时直接以项目上下文继续。命令级 hook 与 track.xnl 的节点级 `<Hook>` 同语法、不同宿主。

---

## 5. 引用

- `codument/std/spec/track-xnl-spec.md` —— track.xnl 三轴规范与目录布局（§0.5）
- `codument/std/protocols/questioning.md#ask-multi-question-free` / `#ask-multi-question-closed`
- `codument/config/attractor-profiles.xnl` —— `coding`/`docs`/`memory` profile 定义
- `codument/config/operation-hooks.xnl` —— 命令级 hook
