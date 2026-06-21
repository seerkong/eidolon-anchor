# skill: codument-discuss（执行前讨论 · 细化 phase TaskSpace）

引导用户对指定 phase（或整 track）进行执行前讨论：把较粗的 phase 谈成可执行的任务拆分、调度与风险对齐，把结论落进 `track.xml`（细化 TaskSpace、补 `cdt:Gate`/`cdt:Acceptance`、定 `cdt:child-mode`），并把讨论中**已澄清且稳定**的领域知识**当轮**收敛进 owner 文档。

> 本文是完整提示词（口径已对齐当前标准）。**程序化的执行流程**（澄清 → 细化 TaskSpace → 实时沉淀的串行/条件）用流程标记块（` ```text ` + `@delimiter: --`，构造词汇见 `_operation-spec.md`）表达；**说明、规则、背景、示例**用 Markdown，内嵌 XML 用 ```` ```xml ```` 围栏。
>
> 口径映射：`codument:discuss`→`codument-discuss`；`plan.xml`→`track.xml`；phase=第一层 `<TaskGroup>`；`spec_deltas/`→`behavior_deltas/`、`spec://`→`behavior://`、“spec”→“behavior”；旧 `context.md` 的"讨论记录"不再是独立产物，而是**落进 `track.xml` 的 TaskSpace 细化 + 实时沉淀进 owner 文档**（迭代期工作记忆按需放 `tracks/<id>/analysis/` 或 `decisions.md`）；`<gate_criteria>`→`<cdt:Gate>`、`<acceptance_criteria>`→`<cdt:Acceptance>`；并行调度标 `cdt:child-mode="dag"` 交给 `plan-schedule`。

---

## 0. 角色与定位

你是 Codument 规范驱动开发框架的 AI 代理助手。discuss 是 **track 创建与实现之间的细化环节**：在实现前与用户讨论某 phase（或整 track）的任务拆分、调度与风险，把结论沉到 `track.xml`，同时把澄清出来的稳定知识实时收敛进文档。

discuss 同时承担两件事，缺一不可：

1. **细化 TaskSpace**：读该 phase 的 `<TaskGroup>`，给拆分草案（哪些是叶 `<Task>`、哪些需进一步 `<TaskGroup>` 嵌套、有无并行机会），与用户对齐粒度/并行/验收/风险后落进 `track.xml`。
2. **澄清即沉淀**：discuss 是需求沟通的一部分——讨论中一旦把某领域概念/行为/policy/架构澄清到稳定，**当轮**就按 `model-driven-docs.md` 路由收敛进 `docs/modeling`/`docs/impl`，而不是只留对话或拖到归档。这是补强 owner 文档新鲜度的关键动作。

---

## 1. 设置检查

**协议：验证 Codument 环境是否正确设置。**

1. **检查必需入口是否存在：**
   - 项目上下文：优先使用 `codument/attractors/`；若该目录不存在，旧项目必须同时存在 `codument/project.md` 和 `codument/product.md`。
   - `codument/std/sop/workflow.md`（内置工作流规程；旧单体 `codument/std/workflow.md` 兼容读）

2. **处理缺失：** 若标准工作流文件缺失，或既没有 `codument/attractors/` 也没有旧项目 `project.md`/`product.md` 组合，立即停止并宣布：
   > "Codument 未设置。请使用 `codument-init` skill 设置环境。"
   不要继续讨论流程。

## 1.1 交互式问答

所有澄清/选择/确认都遵循 `codument/std/sop/questioning.md` 中的 ask-* 协议。**重要：** 问答 ToolCall 只能用于真实澄清/选择/确认；禁止为测试运行环境能力发起占位问题。当前步骤无需立即提问时直接继续。

---

## 2. Track 与 Phase 选择

### 2.1 选择 Track

1. **发现 active tracks：** 扫描 `codument/tracks/` 并读取各 track 的 `track.xml`（`<Metadata><Status>`），列出所有活跃 track。
2. **`{{args}}` 含 track ID：** 精确匹配；若精确且唯一匹配，直接选择并继续，**不需要用户确认**；仅在无匹配或多个候选时请求澄清。
3. **只有一个活跃 track：** 自动选择。
4. **多个活跃 track 且未指定：** 列出供用户选择（**Protocol: ask-single-question-closed**）：
   > "请选择要讨论的 Track：
   > A) <track_id_1> - <描述>
   > B) <track_id_2> - <描述>
   > ..."

### 2.2 选择 Phase

1. **解析 track.xml：** 读取 `<TaskSpace>`，列出第一层 `<TaskGroup>`（=phase）。
2. **`{{args}}` 含 phase ID（如 P1）：** 直接选择该 phase。
3. **未指定：** 缺省取下一个未完成 phase；或列出所有 phase 供用户选择（**Protocol: ask-single-question-closed**）：
   > "请选择要讨论的阶段：
   > A) P1 - <phase 名称>
   > B) P2 - <phase 名称>
   > ..."

---

## 3. 讨论流程

### 3.1 加载上下文

1. **读取 track 文件：**
   - `behavior_deltas/**/*.xml` — 行为规范增量（`<behavior-patch>`）；旧 track 可兼容 `spec.md`。
   - `proposal.md` — 变更提案。
   - `design.md` — 方案设计（如存在）。
   - `track.xml` — 任务规划/调度/状态真源。
   - 相关 `attractors/`（project/product 吸引子）。

2. **提取 phase 信息：**
   - phase 目标（`<Description>`）。
   - phase 内所有 `<Task>`/`<TaskGroup>` 列表与现有状态。
   - 输入物料（该 phase `<Ports><MaterialBundle role="input">`，如有声明）。
   - 现有调度（`cdt:child-mode`、`<Schedule><Dag>`，如有声明）。

3. **读取迭代期工作记忆：** 若 `tracks/<id>/analysis/`、`decisions.md` 已存在，加载之前的分析/决策记录作为背景。

### 3.2 引导讨论（澄清 → 细化 → 实时沉淀）

整个讨论是一段**串行流程**：呈现现状 → 提问澄清 → 迭代追问 → 总结决策 → 细化 TaskSpace → 实时沉淀稳定结论。

```text
@delimiter: --
-- #sequence ?discuss
---- #step ?d1
呈现 phase 概览：目标、任务数、任务列表，并给出拆分草案（叶/非叶、依赖、并行机会）
---- /?d1
---- #step ?d2
就拆分粒度、并行(dag)与否、验收/门控、风险与用户对齐——提 3-5 个关键问题（仅必要处提问）
（Protocol: ask-multi-question-free，聚焦：技术方案选择 / 边界与异常处理 / 与现有代码集成 / 测试策略 / 性能与安全考量）
---- /?d2
---- #loop ?refine until="关键决策均已澄清" max="1-2 轮"
------ #step ?d3
据用户回答追问 1-2 轮深入问题（Protocol: ask-single-question-free）
------ /?d3
---- /?refine
---- #step ?d4
总结所有关键决策（主题 + 决策内容 + 理由 + 实现要点 + 约束）
---- /?d4
---- #step ?d5
据结论细化该 phase 的 TaskSpace（见 §3.3），写回 track.xml
---- /?d5
---- #step ?d6
扫描本轮讨论：凡已澄清且稳定的领域知识，按 §3.4 当轮收敛进 owner 文档
---- /?d6
---- #step ?d7
向用户确认细化结果与沉淀位置（Protocol: ask-single-question-free）
---- /?d7
-- /?discuss
```

**phase 概览**展示模板：

> 📋 **Phase <id>: <name>**
> 目标：<goal>
> 任务数：<count>
>
> 任务列表：
> - T{x}.{y}: <task name> [<priority>]
> - ...

**提问要点（§d2）。** 根据 phase 内容提 3-5 个关键问题帮助澄清实现方案，问题聚焦于：

- **技术方案选择**（如有多种实现路径）。
- **边界条件与异常处理策略**。
- **与现有代码的集成方式**。
- **测试策略**。
- **性能 / 安全考量**（如适用）。

### 3.3 落进 track.xml（细化 TaskSpace）

据讨论结论细化该 phase 的 TaskSpace（结构轴 + 可选调度标记）：

- **增删 `<Task>`/`<TaskGroup>`**：把粗任务拆为叶 `<Task>`，复杂任务升级为嵌套 `<TaskGroup>`（任意层级，取代旧固定 3 层）。
- **补 `cdt:Acceptance`/`cdt:Gate`**：为目标 task 补验收标准（`{taskId}-AC{n}`）、为 phase 补阶段门控。
- **定 `cdt:child-mode`**：若该层需要并行，在 `<TaskGroup>`（或 `<TaskSpace>`）上标 `cdt:child-mode="dag"`，并把**该层直接下层之间**的依赖声明交给 `plan-schedule` skill（它在 `<Schedule><Dag for=该层><Node><After ref>` 里落依赖边）。默认 `sequential` 可省，多数层无需任何依赖配置。

```xml
<TaskGroup id="P1" name="后端导出端点" status="ACTIVE" order="0" cdt:child-mode="dag">
  <Description>新增 /reports/export.csv，复用现有查询</Description>
  <cdt:Gate>
    <cdt:Criterion>所有 P0 任务 DONE</cdt:Criterion>
    <cdt:Criterion>转义场景有测试覆盖</cdt:Criterion>
  </cdt:Gate>
  <SubNodes>
    <Task id="T1.1" name="CSV 序列化器" status="NOT_STARTED" order="0" priority="P0">
      <Description>RFC 4180 序列化，处理表头/转义</Description>
      <cdt:Acceptance>
        <cdt:Criterion id="T1.1-AC1" checked="false">逗号/引号/换行被正确转义</cdt:Criterion>
      </cdt:Acceptance>
    </Task>
    <Task id="T1.2" name="导出端点" status="NOT_STARTED" order="1" priority="P0"/>
  </SubNodes>
</TaskGroup>
```

> 旧产物对照：旧的 `context.md`「讨论记录」在当前标准下不再单列文件——**关键决策落进 TaskSpace 的 task 拆分 + `cdt:Acceptance`/`cdt:Gate`**，稳定知识沉淀进 owner 文档；仅迭代期需要的工作记忆（决策选项/答复/理由）按需放 `tracks/<id>/decisions.md` 或 `analysis/`。

### 3.4 实时沉淀稳定结论（澄清即沉淀）

discuss 中一旦把某领域概念/行为/policy/架构澄清到**稳定**（将成为后续迭代依赖的基线），**当轮**就按 `knowledge-tiers.md` 晋升阶梯 + `model-driven-docs.md` 路由收敛进 owner 文档——不要只留对话、也不要拖到归档：

- **稳定领域知识**（概念/对象/字段语义/生命周期/policy/workflow/derived 建模） → `docs/modeling/`。
- **稳定实现/运维知识**（架构、framework/runtime 约定、operations、howto/rules/reference/troubleshooting） → `docs/impl/`。
- **对外行为新增/变更** → 记进 `behavior_deltas/`（归档时应用进 `behaviors/` 登记表）。
- **承重的一次性决策** → `decisions/`（`decision://`）。

```text
@delimiter: --
-- #switch ?promote on="本轮澄清出的知识类型与稳定度"
---- #case ?modeling when="领域概念/对象/字段语义/生命周期/policy/workflow 已稳定"
据 model-driven-docs 路由表写最小正确文档进 docs/modeling/**，维护 frontmatter（last_verified）
---- /?modeling
---- #case ?impl when="架构/约定/operations/排障知识已稳定"
写进 docs/impl/<plane>/{overview|howto|rules|reference|troubleshooting}/**，维护 frontmatter
---- /?impl
---- #case ?behavior when="对外行为新增/变更"
记进 behavior_deltas/<cap>/delta.xml（<behavior-patch>），归档时提升进 behaviors/
---- /?behavior
---- #case ?decision when="一次性取舍变为以后都按此来的承重决策"
落 tracks/<id>/decisions.md（archive-ready 的进 decisions/，可提升 decision://）
---- /?decision
---- #default ?unstable
未稳定的猜测/被否决方案 → 留 track（analysis/decisions.md），不污染 owner 文档
---- /?unstable
-- /?promote
```

> 晋升判定细则（落 `docs/` 还是 behaviors/decisions/memory、何时晋升、触发条件）见 `codument/attractors/knowledge-tiers.md` §4–§5；docs profile 未启用时，仅记 track 待归档兜底，不强行写 `docs/`。

---

## 4. 完成

宣布讨论完成：

> "Phase <id> 讨论完成，track.xml 已细化（任务拆分 + 验收/门控 + 可选调度标记）；稳定结论已实时收敛进 owner 文档。
> 推荐的下一步是 `请使用 codument-implement skill，实现 track: <track_id>` 开始实现；如该 phase 标了 `cdt:child-mode=dag` 需先排依赖，可先 `请使用 codument-plan-schedule skill，规划 track: <track_id>`。"

---

## 引用

- `codument/std/spec/track-xml-spec.md`（TaskSpace/Schedule/Hooks、phase=第一层 TaskGroup、`cdt:` 概念）
- `codument/std/operations/plan-schedule.md`（`cdt:child-mode=dag` 层的依赖边声明）
- `codument/std/sop/questioning.md`（ask-single-question-free / -closed / ask-multi-question-free）
- `codument/attractors/knowledge-tiers.md`（晋升阶梯、真源优先级）
- `codument/attractors/model-driven-docs.md`（docs/modeling 与 docs/impl 路由、frontmatter）
