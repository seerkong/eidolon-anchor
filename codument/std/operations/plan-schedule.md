# skill: codument-plan-schedule（规划调度 · Schedule DAG）

**描述：** 为 `track.xml` 的某些层配置执行调度——把可并行的层标 `cdt:child-mode="dag"`，并在 `<Schedule>` 里用 `<Dag for><Node id><After ref>` 声明该层直接下层的依赖。wave（波次）不再手维护，是该 DAG 层依赖的**拓扑分层派生视图**，由 `codument-implement` 在执行时推导。

> 本文是完整规划协议（口径已对齐当前标准）。**程序化流程**（逐层分析、标 dag、声明依赖、校验）用流程标记块（` ```text ` + `@delimiter: --`，构造词汇见 `_operation-spec.md`）表达；**说明、规则、背景、示例**用 Markdown。
>
> 本 skill 由旧 `codument:plan-wave` 重命名而来：「波次规划」→「调度规划」。旧版手写 `<waves>` 块 + 每个 task 的 `wave=` 属性；新版只在**需要并行的层**上加 `cdt:child-mode="dag"` 并写**结构化依赖**——一个前驱一行 `<After ref>`，不再有手维护的 wave 列表。
>
> 口径映射：`codument:plan-wave`→`codument-plan-schedule`；`plan.xml`→`track.xml`；phase = `<TaskSpace>` 第一层 `<TaskGroup>`；`execution_mode=wave`/`<waves>`/`wave=`→逐层 `cdt:child-mode="dag"` + `<Schedule><Dag for><Node id><After ref>`；`wave_config`→`<Schedule><Parallel max-concurrent spot-check>`；`context_files`→`<Ports><MaterialBundle role="input">`；`spec_deltas/`→`behavior_deltas/`。`context.md`/`design/`/`proposal/` 规划期外部记忆现归 `tracks/<id>/analysis/`。

---

## 0.0 总纲

调度按**层**配置，**默认零成本**：未标 `cdt:child-mode="dag"` 的层按子节点 `order` 依次执行，大多数小 track **跳过本 skill 即可**。只有某个 phase（或非叶 task）的直接下层确实**可并行**时，才给该节点加 `cdt:child-mode="dag"` 并声明依赖。

你是 Codument 规范驱动开发框架的 AI 代理助手。本任务是为指定 track 的 `track.xml` 配置调度轴，把可并行的层组织为 DAG，优化并行执行。

---

## 1.0 前置检查与 track 选择

### 1.1 设置检查

验证 Codument 环境正确初始化：

- 项目上下文：优先 `codument/attractors/`；该目录不存在时旧项目须同时有 `codument/project.md` + `codument/product.md`。
- `codument/std/`（标准提示词 / spec / sop 已落盘）。
- `codument/tech-stack.md` 是旧兼容文件，新项目不再推荐。

标准工作流文件缺失，或既无 `codument/attractors/` 也无旧项目 `project.md`/`product.md` 组合 → 立即停止，宣布：「Codument 未设置。请使用 `codument-init` skill 设置环境。」**不要**继续 track 选择。

### 1.2 交互式问答

引用 `codument/std/sop/questioning.md` 的 `ask-*` 协议。**重要**：提问 ToolCall 只用于真实澄清 / 选择 / 确认；**禁止**为测试运行环境能力而发占位问题。当前步骤无需立即提问时直接继续。

### 1.3 选择 track

```text
@delimiter: --
-- #sequence ?select
---- #step ?s1
扫描 codument/tracks/ 各 track 的 track.xml <Metadata>；无有效 track 目录或 track.xml → 宣布"没有可规划调度的活跃 track"并停止
---- /?s1
---- #if ?s2 cond="用户提供了 track 名称参数"
------ #sequence ?named
-------- #step ?m1
对 track-id 做精确、不区分大小写匹配
-------- /?m1
-------- #if ?m2 cond="精确且唯一匹配"
直接选中并继续，不需用户确认
-------- /?m2
-------- #else ?m3
无匹配或多个候选 → ask-single-question-free 请求澄清
-------- /?m3
------ /?named
---- /?s2
---- #else ?s3
------ #step ?u1
取第一个 <Metadata><Status> 非 completed/cancelled 的 track；宣布自动选择并继续；若全部已完成则宣布并停止
------ /?u1
---- /?s3
-- /?select
```

未选出 track 则通知用户并等待指示（`ask-single-question-free`）。

---

## 2.0 加载上下文（step 0）

读取选定 track 的文件（路径以 `codument/tracks/<track-id>/` 为根）：

- `track.xml` — 当前任务计划（TaskSpace / Schedule / Hooks / Ports）。
- `behavior_deltas/**/*.xml` — 行为增量（旧 track 兼容 `spec.md`）。
- `design.md` — 方案设计（如存在）。
- `analysis/` — 规划期外部记忆（`findings.md`/`knowledge.md`，大型 track 的子设计 / 子提案现归此）。
- `codument/std/spec/track-xml-spec.md` — `track.xml` schema（特别是 §4 `cdt:child-mode`、§5 `<Schedule>`）。
- `codument/config/operation-hooks.xml` 与 `codument/config/artifacts.xml` — **仅用于**识别显式 hook 触发的 artifact/knowledge sync 任务。

---

## 3.0 调度规划流程

### 3.1 逐层分析并行机会（step 1）

遍历 `<TaskSpace>` 各非叶节点（phase 及嵌套 TaskGroup），逐节点判断其**直接下层**是否存在可并行（无前后依赖）的子节点。对每个非叶节点：

```text
@delimiter: --
-- #loop ?levels for="TaskSpace 每个非叶节点（phase 及嵌套 TaskGroup）"
---- #step ?a1
分析该节点【直接下层】子节点之间的逻辑依赖：据 Description、cdt:Acceptance、技术栈推断；参考 design.md / analysis 决策
---- /?a1
---- #step ?a2
识别并行机会：无依赖关系的子节点可并行（同 wave）；有共同前置的可在同一 wave；有顺序依赖的必须分属不同 wave（拓扑层级不同）
---- /?a2
---- #step ?a3
仅当 plan 已有显式文档/制品同步子节点，或 operation-hooks.xml 显式 <artifact-sync artifact="…"/> 引用 artifacts.xml 中 artifact 时，才把 artifact sync 纳入该层依赖图；不要只因 docs profile 启用推断隐式同步任务
---- /?a3
-- /?levels
```

### 3.2 生成 DAG 分组并展示（step 2）

```text
@delimiter: --
-- #sequence ?group
---- #step ?g1
对每个有可并行子节点的层：拓扑排序其直接下层 → 同一拓扑层级归为同一 wave（派生视图，仅用于展示，不入库）
---- /?g1
---- #step ?g2
向用户展示分组方案并征求确认（ask-single-question-free）；见下方示例
---- /?g2
-- /?group
```

展示示例（wave 仅作直观分层，最终落库的是结构化 `<After>` 依赖）：

> 📋 **Phase P1 调度分组方案**（依赖将以结构化 `<After ref>` 落库；以下 wave 仅为直观分层）
>
> **第 1 层**（无依赖，可并行）
> - T1.1: \<task name>
> - T1.2: \<task name>
>
> **第 2 层**（依赖 T1.1）
> - T1.3: \<task name>
>
> **第 3 层**（依赖 T1.1、T1.2）
> - T1.4: \<task name>
> - T1.5: \<task name>
>
> 此方案是否合理？请建议调整或确认。

### 3.3 写入 track.xml（step 3）

确认后更新 `track.xml` 的**结构轴标记** + **调度轴依赖**：

```text
@delimiter: --
-- #sequence ?write
---- #step ?w1
对存在并行的层，在该 TaskSpace/TaskGroup 上加 cdt:child-mode="dag"；其余层保持默认（不加属性 = sequential）
---- /?w1
---- #step ?w2
对每个 dag 层，在 <Schedule><Dag for="该节点"> 内为有前驱的直接下层各写一个 <Node id>，其前驱用 <After ref> 子元素逐个列出（一个前驱一行）
---- /?w2
---- #step ?w3
旧 context_files（phase 级上下文）→ 收进对应 TaskGroup 的 <Ports><MaterialBundle role="input"> 或 task 物料；不再写独立 <context_files> 块
---- /?w3
---- #step ?w4
并行参数（可选）：ask-single-question-closed 问"是否配置 <Parallel>？A) 默认串行、抽检关 B) 自定义"；选自定义则写 <Schedule><Parallel max-concurrent spot-check>
---- /?w4
-- /?write
```

**结构轴**——给可并行的 phase（或嵌套 TaskGroup）加 `cdt:child-mode="dag"`（默认 `sequential` 可省）：

```xml
<TaskGroup id="P1" name="后端导出端点" status="NOT_STARTED" order="0" cdt:child-mode="dag">
  …
</TaskGroup>
```

**调度轴**——`<Schedule>` 是与 `<TaskSpace>` **并列的兄弟节点**，每个 `<Dag for>` 只管**一个父节点的直接下层**，前驱用 `<After ref>` 子元素逐行声明：

```xml
<!-- <Schedule> 与 <TaskSpace> 并列，同为 <Track> 的直接子节点 -->
<Schedule>
  <Dag for="P1">
    <Node id="T1.3">
      <After ref="T1.1"/>
    </Node>
    <Node id="T1.4">
      <After ref="T1.1"/>
      <After ref="T1.2"/>
    </Node>
  </Dag>
  <!-- 要给多个非叶节点配依赖就写多个 <Dag for=...>；不跨层、不跨父 -->
  <Parallel max-concurrent="3" spot-check="true"/>   <!-- 取代旧 wave_config，可选 -->
</Schedule>
```

### 3.4 校验（step 4）

```text
@delimiter: --
-- #sequence ?validate
---- #step ?v1
检查每个 <Dag for="X"> 的 X 指向一个 cdt:child-mode="dag" 的节点
---- /?v1
---- #step ?v2
检查 <Node id> 与 <After ref> 只引用该节点的【直接下层】id（不跨层、不跨父）
---- /?v2
---- #step ?v3
检查该层 DAG 无环
---- /?v3
---- #step ?v4
尝试 codument validate <id> --strict（找不到命令则跳过并说明）
---- /?v4
-- /?validate
```

---

## 4.0 完成

宣布规划完成：

> 调度规划完成，track.xml 已更新。
> - 已标 dag 的层：\<count>
> - 总依赖边：\<count>
>
> 你现在可以运行 `请使用 codument-implement skill, 执行 track: <track_id>` 开始执行——wave 由依赖在执行时派生。

---

## 5.0 设计要点（为什么这样）

- **默认零配置**：未标 `dag` 的层按 `order` 依次执行——大多数 track 不必写任何依赖，跳过本 skill。
- **依赖完全结构化**：前驱用 `<After ref="…">` **子元素**表达，一个前驱一行——**不用空格分隔的属性字符串**（避免 id 含空格 / 解析歧义）；新增一条依赖 = 加一行 `<After>`，对 AI 编辑最省力、最不易错。
- **作用域单一**：一个 `<Dag>` 只描述**一个父节点的直接下层**之间的边；要给多个非叶节点配依赖就写多个 `<Dag for=...>`，**不跨层、不跨父**——避免旧 `<Needs task on>` 那种全局扁平边的歧义。
- **wave 是派生视图**：不再手维护 `<waves>`/`wave=`。某 `dag` 层的依赖经拓扑分层即得 wave，由 `codument-implement` 执行时推导；并发上限 / 抽检放 `<Parallel>`。具体派发套路见 `codument/std/sop/wave-exec.md`。

---

## 附录 A：引用

- `codument/std/spec/track-xml-spec.md` — §4 `cdt:child-mode`、§5 `<Schedule><Dag for><Node><After>`、§9 校验规则。
- `codument/std/sop/wave-exec.md` — DAG 层的派生 wave 调度循环。
- `codument/std/sop/questioning.md` — `ask-*` 提问协议。
