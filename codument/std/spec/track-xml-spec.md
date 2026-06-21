# Track XML 规范（重构后的 track 文件，取代 plan.xml）

`tracks/<id>/track.xml`（根 `<Track>`）是 codument 的**任务规划 + 执行 + 任务状态**文件。它是 dynamic-workflow 三层标准的一个**领域落地**：复用 Layer 1（Imports/Ports/MaterialBundle/Extension）、Layer 2（Hook）、Layer 3（TaskSpace 任务树）；codument 领域特有的东西用 `cdt:`（`urn:codument:v1`）命名空间。

> 内核规范见 `../dynamic-workflow/spec/`（`kernel-pointer.md` 说明复用关系）。本文档只定义 `<Track>` 这个领域根与 codument 的 `cdt:` 概念。

## 0. 三轴解构（设计要旨）

旧 `plan.xml` 把"结构 / 调度 / 行为"混在一棵固定三层树 + 一堆并列块里。新 `track.xml` 拆成三条**正交轴**：

```
<Track>
  <Metadata/>            轨道元信息（id 在根属性；status/goal/commit-mode…）
  <Imports/>             （可选）vfs:// 引入外部流程/定义（一般 track 不需要）
  <Ports/>               ① 轨道作用域 input/output/state + MaterialBundle（物料目录）
  <TaskSpace>            ② 结构轴：工作树（做什么 + 状态），phase=第一层 TaskGroup，可任意层级嵌套
    <SubNodes> … </SubNodes>
  </TaskSpace>
  <Schedule>             ③ 调度轴：怎么跑（mode + 依赖边 Needs）；与 TaskSpace 并列
  <Hooks/>               ④ 行为轴：轨道级生命周期 hook（校验/纠偏/确认）
</Track>
```

- **结构**只描述任务层级与状态；**调度**只描述执行顺序/并行；**行为**只描述生命周期校验。三者互不嵌套污染。
- 这比旧的固定 Phase→Task→Subtask（3 层封顶）**理论上限更高**：TaskSpace 的 `TaskGroup`/`Task` 可递归任意深；调度是 DAG；行为是统一 hook。

---

## 0.5 track 目录结构（`tracks/<id>/` 文件布局）

`track.xml` 是状态真源，但一个 track 目录还承载迭代期的工作记忆与可提升候选。完整布局：

```text
tracks/<id>/
  track.xml               ★ 状态真源（结构/调度/行为三轴）
  proposal.md             为什么 / 是什么 / 目标-非目标 / 影响
  design.md               （可选）方案 / 决策摘要 / 风险 / 兼容 / 迁移
  behavior_deltas/<cap>/delta.xml   行为增量（<behavior-patch>，归档提升进 behaviors/）
  analysis/               规划/分析期的 planning-with-files 外部记忆（避免长对话丢上下文）
    findings.md             直接找到的事实、约束、问题与结论
    knowledge.md            阅读后沉淀的知识上下文、术语与机制理解
  decisions.md            决策问题/选项/用户答复/结论与理由（需要决策时建）
  decisions/              archive-ready 的 durable 单文件决策（归档可提升 decision://）
  memory/                 （可选）长期记忆候选，按类别分子目录（归档且 memory profile 启用时提升 memory://）
  reports/                gap-loop / verify 的结构化报告（track://reports/...，按轮累积）
```

规则：
- `track.xml`/`proposal`/`behavior_deltas` 必有；其余按需。
- `analysis/` 是**迭代期外部记忆**，不是 owner 真源——稳定结论按 `knowledge-tiers.md` 晋升进 `docs/`/`behaviors/`，不滞留 analysis。
- `analysis/findings.md` 应记录可复用的事实锚：spot-check 证据、测试/指标结果、失败归因、环境约束、机制漏洞、phase/wave 完成小结。新会话接手或续跑时优先读取它，避免只依赖对话记忆。
- `decisions/`→`decision://`、`memory/`→`memory://`、`behavior_deltas/`→`behaviors/` 的提升时机见 `std/sop/archive.md` 与 `knowledge-tiers.md` §4–§5。
- 子代理只接收**路径/引用**自读（见 `implement.md`），不把这些目录正文塞进编排者上下文。

---

## 1. `<Track>` 根

```xml
<Track id="add-csv-export" version="1" xmlns:cdt="urn:codument:v1">
  …
</Track>
```

- `id`：track 标识（kebab、动词开头），唯一真源（旧的 `metadata/track_id` 上提为根属性）。
- `version`：schema 版本。
- 只声明 `cdt`（`urn:codument:v1`）命名空间。**不引入 `xmlns:config`**——track.xml 当前不引用 bt-instant-ctrl-flow 的 `config:` 配置。

---

## 2. `<Metadata>` — 轨道元信息

```xml
<Metadata>
  <Status>in_progress</Status>          <!-- new | in_progress | completed | cancelled -->
  <Goal>为报表新增 CSV 导出</Goal>
  <Description>后端端点 + 前端按钮 + docs 同步</Description>
  <CommitMode>manual</CommitMode>       <!-- auto | manual -->
  <CreatedAt>2026-06-14T10:00:00Z</CreatedAt>
  <UpdatedAt>2026-06-14T15:00:00Z</UpdatedAt>
</Metadata>
```

- **不含** `execution_mode`（→ `<Schedule mode>`）、`validation_mode`/`validation_granularity`/`gap_loop_round`（→ `<Hooks>` 见 §6），也不含手维护的 `summary`（工具从 TaskSpace 派生）。
- 可选 `cdt:`：`<cdt:Milestones>`、`<cdt:Risks>`（旧 milestones/risks 降级；大多数 track 放 proposal.md 即可）。

---

## 3. `<Ports>`（Layer 1；`<Imports>` 可选）

```xml
<Ports scope="track">
  <!-- 轨道作用域只用目录物料（多入多出）；不需要 JSON input/output 端口 -->
  <MaterialBundle role="input"  name="behavior-deltas" domain="behavior"     path="vfs://./behavior_deltas/"/>
  <MaterialBundle role="output" name="docs"        domain="doc"      path="vfs://@/docs/"/>
  <!-- track 完成后行为增量提升进 behavior registry -->
  <MaterialBundle role="output" name="behavior"        domain="codument" path="vfs://@/codument/behaviors/"/>
</Ports>
```

- Ports/MaterialBundle 语义同内核 Layer 1 §2。这把"轨道吃哪些目录、产出落哪"显式化，**取代** artifacts.xml 里零散的 source/target——artifact sync 直接读 track 的 output MaterialBundle。
- 轨道作用域**不设 JSON `input`/`output` 端口**；track 的输入输出就是这些目录物料：`spec-deltas`（输入）、`docs` + `spec`（输出，后者即 `codument/behaviors/` 行为登记表）。
- **`<Imports>` 可选**：cdt: check 自包含（配置在节点上）、`AttractorCheck.use` 直接指 `attractor-profiles.xml` 的 profile（按约定解析，无需 import），故一般 track 无需 `<Imports>`。仅当 track 要 import 外部流程/定义（如 `workflows/` 的 BTWorkflow）时才写。
- 旧 `context_files`（phase 级）→ 收进对应 TaskGroup 的 `<Ports><MaterialBundle role="input">` 或 task 的物料。

---

## 4. `<TaskSpace>` — 结构轴（工作树 + 状态）★

复用 Layer 3 的 TaskSpace（Task DSL，`<Description>` 元素、status 标在 XML）。codument 约定：

- **phase = `SubNodes` 第一层 `TaskGroup`**（不引入独立 `<Phase>` 标签）。
- phase 之下 `Task`（叶）/`TaskGroup`（非叶）**任意层级嵌套**（取代旧固定 3 层）。
- 任务状态枚举沿用：`NOT_STARTED | ACTIVE | DELEGATED | FORWARDED | DONE | REFUSED | ABANDONED`。
- codument 领域扩展用 `cdt:` 子节点：`<cdt:Gate>`（阶段门控）、`<cdt:Acceptance>`（验收标准）、`<cdt:Priority>`/`priority` 属性。
- **层级执行模式 `cdt:child-mode`**：在 `<TaskSpace>` 或任一 `<TaskGroup>` 上加 `cdt:child-mode="sequential|dag"`（**默认 `sequential`，可省**），标记其**直接下层节点**是依次执行还是 DAG。**默认无需任何依赖配置**；只有标 `dag` 的层，才在 `<Schedule>` 里声明该层直接下层之间的依赖（§5）。可对多个非叶节点分别标 `dag`。

```xml
<TaskSpace id="space_add-csv-export" name="add-csv-export" version="1">
  <Description>为报表新增 CSV 导出</Description>
  <SubNodes>

    <!-- 第一层 TaskGroup = phase -->
    <TaskGroup id="P1" name="后端导出端点" status="ACTIVE" order="0">
      <Description>新增 /reports/export.csv，复用现有查询</Description>
      <cdt:Gate>                              <!-- 阶段门控（旧 gate_criteria） -->
        <cdt:Criterion>所有 P0 任务 DONE</cdt:Criterion>
        <cdt:Criterion>转义场景有测试覆盖</cdt:Criterion>
      </cdt:Gate>
      <SubNodes>
        <Task id="T1.1" name="CSV 序列化器" ownerAccount="agent:impl" status="DONE" order="0" priority="P0">
          <Description>RFC 4180 序列化，处理表头/转义</Description>
          <cdt:Acceptance>
            <cdt:Criterion id="T1.1-AC1" checked="true">逗号/引号/换行被正确转义</cdt:Criterion>
          </cdt:Acceptance>
        </Task>
        <!-- 非叶 task → 多层嵌套（旧 subtasks 的泛化） -->
        <TaskGroup id="T1.2" name="导出端点" status="ACTIVE" order="1" priority="P0">
          <Description>GET /reports/export.csv，流式返回</Description>
          <SubNodes>
            <Task id="T1.2.1" name="路由与参数复用" status="DONE" order="0"/>
            <Task id="T1.2.2" name="流式写出" status="ACTIVE" order="1"/>
          </SubNodes>
        </TaskGroup>
      </SubNodes>
      <!-- phase 级行为 hook（见 §6） -->
      <Hooks>
        <Hook on="phase:after"><cdt:AttractorCheck use="coding"/></Hook>
      </Hooks>
    </TaskGroup>

    <TaskGroup id="P2" name="前端导出按钮" status="TODO" order="1">
      <Description>报表页"导出 CSV"按钮</Description>
      <SubNodes>
        <Task id="T2.1" name="按钮与下载" status="TODO" order="0" priority="P0"/>
      </SubNodes>
    </TaskGroup>

    <TaskGroup id="P3" name="docs 同步与收尾" status="TODO" order="2">
      <Description>同步 docs，终态人工确认</Description>
      <SubNodes>
        <Task id="T3.1" name="同步 docs/modeling 与 docs/impl" status="TODO" order="0" priority="P1">
          <Hooks><Hook on="task:after"><cdt:AttractorCheck use="docs"/></Hook></Hooks>
        </Task>
      </SubNodes>
      <Hooks><Hook on="phase:after"><cdt:HumanConfirm/></Hook></Hooks>   <!-- 终态校验=人工确认 -->
    </TaskGroup>

  </SubNodes>
</TaskSpace>
```

ID 约定（沿用旧规范的可读性）：phase=`P{n}`、task=`T{phase}.{n}`、嵌套继续追加 `.{n}`、验收=`{taskId}-AC{n}`。这些是 `id`/`order` 属性值约定，不是结构约束。

---

## 5. `<Schedule>` — 调度轴（怎么跑）

与 `<TaskSpace>` **并列的兄弟节点**。调度按**层级**表达：默认每层依次执行（无需配置）；只有被 `cdt:child-mode="dag"` 标记的层（§4），才在这里声明**那一层直接下层节点之间**的依赖。

```xml
<Schedule>
  <!-- 每个 <Dag for="<父节点 id>"> 只管该父节点的【直接下层】依赖（单层、可有多个父） -->
  <Dag for="P1">
    <Node id="T1.3">                        <!-- 有前驱的直接下层各一个 <Node> -->
      <After ref="T1.1"/>                    <!-- 前驱用 <After ref> 子元素，一个前驱一行 -->
      <After ref="T1.2"/>
    </Node>
  </Dag>
  <!-- 顶层（phase 间）若也并行，再加 <Dag for="<TaskSpace id>">；本例 phase 默认顺序，不需要 -->
  <Parallel max-concurrent="3" spot-check="true"/>   <!-- 旧 wave_config -->
</Schedule>
```

设计要点（回应"更直观、对 AI 更省力、足够结构化"）：
- **默认零配置**：未标 `dag` 的层按 `order` 依次执行——大多数 track 不必写任何依赖。
- **依赖完全结构化**：前驱用 `<After ref="...">` **子元素**表达，一个前驱一行——**不用空格分隔的属性字符串**（避免 id 含空格 / 解析歧义），新增一条依赖 = 加一行 `<After>`，对 AI 编辑最省力、最不易错。
- **作用域单一**：一个 `<Dag>` 只描述**一个父节点的直接下层**之间的边；要给多个非叶节点配依赖，就写多个 `<Dag for=...>`。**不跨层、不跨父**，避免旧 `<Needs task on>` 那种全局扁平边带来的歧义。
- 不再有全局 `mode`（执行模式是**逐层**的 `cdt:child-mode`）；不再手维护 `<waves>`/`wave=`，wave = 某 dag 层依赖的拓扑分层（派生视图，不入库）。
- **波次调度执行细节**由 `std/sop/wave-exec.md` 和 `std/operations/implement.md` 定义；本规范只约束结构位置与格式。

---

## 6. `<Hooks>` — 行为轴（校验 / 纠偏 / 确认）

复用 Layer 2 Hook（`<Hooks><Hook on><typed-child/></Hook></Hooks>`）。可挂在 `<Track>`（track 级）、phase（第一层 TaskGroup）、task 级。typed-child 是 codument **内置**的 `cdt:` check——**配置直接写在节点上，无独立定义文件**：

| typed-child | 配置（在节点上） | 取代旧 |
|---|---|---|
| `<cdt:AttractorCheck use="<profile>"/>` | `use` = `attractor-profiles.xml` 的 profile 名（如 `coding`/`docs`）。执行器固定 **fresh-subagent**（由 std 提示词约定，不配置） | `<attractor-check>` |
| `<cdt:GapLoop max-rounds="5" on-exhausted="block"/>` | `max-rounds` 上限、`on-exhausted`（`block`/…）直接写在属性上 | `validation_mode=yield-gap-loop` + `<confirm protocol="yield-gap-loop">` |
| `<cdt:HumanConfirm/>` | 暂无属性 | `validation_mode=yield-human-confirm` + `<confirm protocol="yield-human-confirm">` |

- `on` 取值：`track:before|after`、`phase:before|after`、`task:before|after`。
- **自包含**：check 的配置全在节点属性上；**无 `agents/` 定义注册表**。`AttractorCheck` 唯一的外部 ref 是 `use=` → `attractor-profiles.xml` 的 profile 名（决定校验对照哪些吸引子文件）；其审查方式（用 fresh-subagent）由 `std` 提示词统一约定。
- **新建 track 默认方向审查**：每个第一层 phase（`TaskSpace` 的直接下层 `TaskGroup`）默认都应包含 `<Hook on="phase:after"><cdt:AttractorCheck use="coding"/></Hook>`；只有用户在创建 track 时明确选择关闭、改为终态 phase，或改用其他 profile（如 `docs`）时才覆盖。
- **校验模式塌缩**：旧 `validation_mode`/`validation_granularity` = "在终态 phase（或每个 phase）挂哪个 typed check"。`every_phase` = 每个第一层 TaskGroup 都挂；`final_phase` = 仅最后一个挂。
- track 级生命周期 hook（如归档前 docs 审查）也可写在 `<Track><Hooks>`；命令级（无 track 文件的操作）走 `config/operation-hooks.xml`（同语法）。

```xml
<Track …>
  …
  <Hooks>
  </Hooks>
</Track>
```

> 注意：校验/纠偏的 `<cdt:GapLoop>` 应挂在 phase（终态或每个第一层 TaskGroup）的 `phase:after`，**不要**在 `<Track><Hooks>` 再挂 `track:after` 的 `<cdt:GapLoop>`——否则会和终态 phase 的 `phase:after` GapLoop 叠加，导致末尾 gap-loop 重复执行一次。`<Track><Hooks>` 只放真正的 track 级生命周期 hook（如归档前 docs 审查）。

---

## 7. 状态与派生

- **任务/阶段状态**：`<TaskGroup>`/`<Task>` 的 `status` 属性（枚举）。父 TaskGroup 状态应反映子节点（`ACTIVE` 若有子在跑、`DONE` 若全 DONE）。
- **track 状态**：`<Metadata><Status>`（`new|in_progress|completed|cancelled`）。
- **summary 不入库**：阶段/任务计数、按优先级统计等由工具遍历 TaskSpace 派生（旧 `<summary>` 删除）。
- **commit / blocker**：完成任务的 commit SHA、阻塞原因可作 `<Task>` 的 `cdt:commit` / `cdt:blocker` 属性或 `<Config>` 字段。

---

## 8. 与旧 plan.xml 的迁移映射（upgrade-track 自动转换）

| 旧 | 新 |
|---|---|
| `<plan>` / `<metadata>` | `<Track id=>` / `<Metadata>` |
| `<phases><phase>` | `<TaskSpace><SubNodes><TaskGroup>`（第一层） |
| `<tasks><task>` / `<subtasks><subtask>` | 嵌套 `<Task>`/`<TaskGroup>`（任意层级） |
| 文本/`<description>` | `<Description>` 元素 |
| `status`（TODO/IN_PROGRESS/DONE/…） | 枚举（NOT_STARTED/ACTIVE/DONE/…）；`TODO→NOT_STARTED`、`IN_PROGRESS→ACTIVE` |
| `<gate_criteria>` | `<cdt:Gate>` |
| `<acceptance_criteria>` | `<cdt:Acceptance>` |
| `execution_mode`/`<waves>`/`wave=`/`<wave_config>` | 逐层 `cdt:child-mode="sequential|dag"` + `<Schedule><Dag for><Node after>` + `<Parallel>` |
| `validation_mode`/`<confirm>`/`<attractor-check>` | `<Hooks>` + `cdt:` typed check |
| `context_files` | `<Ports><MaterialBundle role="input">` |
| `milestones`/`risks`/`validations`/`summary` | `cdt:` 可选节点 / proposal.md / 工具派生（summary 删除） |

迁移是 breaking，由 `codument upgrade-track` 执行；过渡期 validate 兼容读旧 `plan.xml` 并提示。

---

## 9. 校验规则（strict）

1. 根 `<Track id>`；`<Metadata><Status>` 合法枚举。
2. `<TaskSpace>` 必需；第一层 SubNodes 至少一个 TaskGroup（phase）；id 全局唯一。
3. `status` 属性为枚举。
4. 每个 `<Schedule><Dag for="P">` 的 `for` 必须引用一个 `cdt:child-mode="dag"` 的节点；其 `<Node id>` 与子 `<After ref>` 只能引用该节点的**直接下层** id；该层内 DAG 无环。
5. `<Hook on>` 取值合法；`<cdt:AttractorCheck use>` 能在 `config/attractor-profiles.xml` 解析到 profile；`<cdt:GapLoop>` 的 `max-rounds`/`on-exhausted` 合法。
6. 格式良好的 XML；`cdt:` 命名空间已声明（track.xml 不需要 `config:`）。
