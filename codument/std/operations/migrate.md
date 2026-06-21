# skill: codument-migrate（迁移旧格式 → 当前标准）

**本提示词供执行迁移的代理阅读。** 它合并了两条旧迁移流程——**旧 archive 布局迁移** 与 **旧 Markdown specs → XML 行为登记表迁移**——成一个统一的 migrate skill。

> 本文是完整协议（口径已对齐当前标准）。**程序化的执行流程**（scan→classify→transform→verify 流水线、按条目分叉）用流程标记块（` ```text ` + `@delimiter: --`，构造词汇见 `codument/std/operations/_operation-spec.md`）表达；**说明、规则、背景、示例**用 Markdown，内嵌 XML 用 ` ```xml ` 围栏。
>
> 口径映射：`codument:migrate-archive` / `codument:migrate-specs`→统一 `codument-migrate`；`spec`→`behavior`；`spec://`→`behavior://`；`<spec-patch>`→`<behavior-patch>`；`spec_deltas/`→`behavior_deltas/`；`codument/specs/`→`codument/behaviors/`；`plan.xml`→`track.xml`；`### Requirement:` / `#### Scenario:` 等 Markdown 层级 → XML `<requirement>` / `<suite>` / `<case>`。

---

## 0. 总纲

你是 Codument 迁移代理。本 skill 把**旧格式的两类工件**迁到当前标准，同时**保留证据、不静默删除、不臆造无法确定的事实**：

1. **旧 archive 布局** → 新 `codument/archive/YYYY-MM/YYYY-MM-DD-HHmm-<track-id>/` 目录规范。
2. **旧 Markdown specs**（`## ADDED Requirements` / `### Requirement:` / `#### Scenario:`，位于 `specs/<cap>/spec.md`）→ **XML 行为登记表** `codument/behaviors/`（见 `codument/std/spec/behavior-registry.md`），并把 track 内的差量表达为 `<behavior-patch>`（见 `codument/std/spec/behavior-delta.md`）。

两条迁移共享同一套安全纪律（§1）。本 skill 是**普通迁移流程**，不需要 gap-loop 式 fresh child orchestration；只有用户显式要求独立复检时才考虑委派子代理（见 `codument/std/operations/gap-loop.md`）。

**入参**（均可选）：

- `what`：`archive` | `specs` | `all`（缺省 `all`，两类都迁）。
- `track-id`：只迁某个 track 相关工件时指定。

---

## 1. 迁移前安全纪律（两类共享）

无论迁 archive 还是 specs，先做这些：

1. 读取 `codument/std/AGENTS.md`（如存在）与项目 workflow，确认当前规范与 CLI 能力。
2. **先 inventory，不要直接覆盖**：列出所有候选源、推断出的目标、风险与不确定点。
3. 创建备份 / 迁移记录：
   - 优先写入 `.tmp/codument/migrate-<timestamp>/`；
   - 或在最终报告中记录用户已有备份位置。
4. 只有在**源路径与目标路径都明确**时才移动 / 转换。
5. **不安全或无法解释的内容**复制到 legacy 区（archive → `codument/legacy/archive/...`；specs → `codument/legacy/specs/...`），**不直接删除**。
6. **不把猜测当事实**：无法确定的时间、track ID、需求边界，显式标记待确认，不伪造。

---

## 2. Archive 迁移

### 2.1 识别旧布局

扫描这些旧形态：

- `codument/archive/<YYYY-MM-DD-track-id>/`（缺 `YYYY-MM/` bucket）
- `codument/archive/<track-id>/`（连日期前缀都没有）
- 任何缺少 `YYYY-MM/` bucket 的 archive 目录
- 只有 `metadata.json`、`tasks.xml`、`spec.md` 或 `summary.md`、缺 `track.xml`（或旧 `plan.xml`）的归档目录

新布局是：

```text
codument/archive/YYYY-MM/YYYY-MM-DD-HHmm-track-id/
```

### 2.2 迁移规则

- **更新时间优先级**：`track.xml`（旧 `plan.xml`）的 `metadata.updated_at` → `metadata.json` 的 `updated_at` → 归档目录名日期 → 目录内文件最大 mtime。
- 若目录名日期、`track.xml`/`plan.xml` 时间、`metadata.json` 时间**互相不一致**，必须在迁移记录中**显式标记风险**；仍优先使用 `track.xml`/`metadata.json` 中可验证的更新时间。
- 能确定分钟时用真实分钟；只能确定日期时用 `0000` 并记录原因。
- **目标目录已存在时不要覆盖**：记录冲突并请求用户处理。
- 若旧 archive 缺 `track.xml`：从可用 `metadata`/`tasks` 生成**最小 `track.xml`**（即把旧 `plan.xml` 做最小修复为 `track.xml`）；无法生成时保留原文并记录。
- 旧 `spec.md`、summary、reports、decisions、memory 内容应**随 archive 保留**。

### 2.3 Archive 迁移流程

```text
@delimiter: --
-- #sequence ?archive-migrate
---- #step ?a-scan
扫描 §2.1 列出的所有旧布局候选，inventory 出 (源路径, 推断 track-id, 推断更新时间, 风险)
---- /?a-scan
---- #loop ?a-each for="每个候选 archive 目录"
------ #step ?a-time
按 §2.2 优先级链确定更新时间；多源不一致时标记风险，决定 HHmm（真实分钟 / 0000+原因）
------ /?a-time
------ #if ?a-conflict cond="目标 archive/YYYY-MM/YYYY-MM-DD-HHmm-<id>/ 已存在"
-------- #step ?a-skip
不覆盖：记录冲突到迁移记录，请求用户处理，跳过本条目
-------- /?a-skip
------ /?a-conflict
------ #else ?a-do
-------- #sequence ?a-move
---------- #step ?a-plan
缺 track.xml 时，从 metadata.json/tasks.xml 生成最小 track.xml（旧 plan.xml 最小修复）；不能生成则保留原文并记录
---------- /?a-plan
---------- #step ?a-keep
spec.md / summary / reports / decisions / memory 随 archive 一并迁移保留
---------- /?a-keep
---------- #step ?a-legacy
不安全 / 无法解释的内容复制到 codument/legacy/archive/...，不删除
---------- /?a-legacy
---------- #step ?a-target
移动目录到 codument/archive/YYYY-MM/YYYY-MM-DD-HHmm-<track-id>/
---------- /?a-target
-------- /?a-move
------ /?a-do
---- /?a-each
-- /?archive-migrate
```

---

## 3. Specs → XML 行为登记表迁移

### 3.1 输入读取

读取（**先 inventory，不要直接覆盖**）：

- `codument/specs/**/*.md`（旧 Markdown specs）
- `codument/specs/**/*.xml`（已有 XML）
- `codument/tracks/**/spec.md`
- `codument/archive/**/spec.md`
- `codument/legacy/specs`
- `codument/std/AGENTS.md` 与 workflow

> 注意区分**长期 registry** 与 **track delta**：不要把某个 track 的 `spec.md`（差量）误当成长期登记表，**除非它已归档且语义明确**。track 级差量应迁为 `behavior_deltas/<cap>/delta.xml` 的 `<behavior-patch>`（见 §3.4），合并后的真源才进 `codument/behaviors/`。

### 3.2 Markdown → XML 映射

把旧 Markdown 层级映射为行为登记表节点（节点规范见 `codument/std/spec/behavior-registry.md`）：

| 旧 Markdown | 新 XML |
|---|---|
| `### Requirement: Name` | `<requirement id="slug">` |
| Requirement 正文 | `<statement>` |
| `#### Scenario: Name` | `<suite>` 下的 `<case id="slug">` |
| Given / When / Then 列表 | `<given>` / `<when>` / `<then>` |

`id` 规则：

- 生成的 `requirement` / `suite` / `case` 的 `id` 必须**稳定**且在**同一 capability 内全局唯一**。
- slug 冲突时加父级 requirement / suite / 主题前缀，例如 `create-success` → `invoice-create-success`。
- **无法映射**的正文保留为 XML 注释或 legacy 原文，并标记待确认，**不丢弃**。

转换后的登记表形态示例：

```xml
<behaviors capability="billing" version="1">
  <requirement id="invoice-create">
    <statement>系统 SHALL 在校验通过后创建发票并返回 201。</statement>
    <suite name="invoice-create">
      <case name="create-success">
        <given>合法的发票输入 F</given>
        <when>POST /invoices 携带 F</when>
        <then>返回 201 且持久化一条发票</then>
      </case>
    </suite>
  </requirement>
</behaviors>
```

### 3.3 XML 文件组织（单文件 ↔ 同名文件夹）

小 capability：

```text
codument/behaviors/billing.xml
```

大 capability（行为多时拆分，沿用分形习惯）：

```text
codument/behaviors/billing/
  index.xml                  入口，include 子文件
  requirements/invoice.xml
  suites/create.xml
```

- `index.xml` 保留 capability 根节点，通过 `<include href="..."/>` 引用拆分文件。
- 若旧 spec 已经位于 `codument/specs/<capability>/spec.md` 这种**目录内**，优先迁为**同目录的 folder registry** `codument/behaviors/<capability>/index.xml`；**不要**为了生成单文件 XML 把已有 capability 目录折叠成 `codument/behaviors/<capability>.xml`。

### 3.4 track delta：`<behavior-patch>`（wrapper + behavior://）

track 内的差量不是登记表本身，而是对登记表的增删改，迁为 `tracks/<id>/behavior_deltas/<capability>/delta.xml`（规范见 `codument/std/spec/behavior-delta.md`）：

- 根节点 `<behavior-patch capability="<capability>" version="1">`；一个 capability 一个 delta 目录。
- **mutation = wrapper 标签 + `selector`**：`<upsert|delete|move selector="behavior://...">`；`selector` 用 **`behavior://`** 虚拟路径定位登记表节点（取代旧 `spec://`）；`move` 还必须带 `to="behavior://..."`。
- 行为用例用可嵌套 `<suite>` / `<case>`（Given/When/Then）。

```xml
<behavior-patch capability="billing" version="1">
  <upsert selector="behavior://billing/requirements/invoice-create">
    <requirement id="invoice-create">
      <statement>系统 SHALL 在校验通过后创建发票并返回 201。</statement>
      <suite name="invoice-create">
        <case name="create-success">
          <given>合法的发票输入 F</given>
          <when>POST /invoices 携带 F</when>
          <then>返回 201 且持久化一条发票</then>
        </case>
      </suite>
    </requirement>
  </upsert>
</behavior-patch>
```

### 3.5 安全策略

- **不覆盖已有 XML 登记表**，除非用户明确要求并有备份。
- 转换前把原 Markdown 复制到 `codument/legacy/specs/...`。
- 若 Markdown 层级不规范、场景缺少 Given/When/Then、需求边界不清：先生成**迁移草案并请求确认**，不直接落盘真源。
- 不把 track delta 误当成长期 registry（见 §3.1）。

### 3.6 Specs 迁移流程

```text
@delimiter: --
-- #sequence ?specs-migrate
---- #step ?s-scan
inventory §3.1 列出的所有 md/xml spec 源；分类：长期 registry 候选 vs track 级差量
---- /?s-scan
---- #loop ?s-each for="每个 spec 源"
------ #step ?s-backup
转换前把原 Markdown 复制到 codument/legacy/specs/...（保留可追溯原文）
------ /?s-backup
------ #if ?s-illformed cond="Markdown 层级不规范 / 场景缺 GWT / 需求边界不清"
-------- #step ?s-draft
生成迁移草案，标记待确认点，请求用户确认；本条目暂不落盘真源
-------- /?s-draft
-------- #continue ?s-next if="草案未获确认"
跳过本条目真源落盘，继续下一个 spec 源
-------- /?s-next
------ /?s-illformed
------ #switch ?s-kind on="该源是长期 registry 还是 track 差量"
-------- #case ?s-reg when="长期 registry（含已归档且语义明确者）"
---------- #step ?s-reg-map
按 §3.2 映射为 <behaviors>；id 稳定且 capability 内唯一，冲突加前缀；无法映射正文转 XML 注释/legacy 并标待确认
---------- /?s-reg-map
---------- #if ?s-folder cond="旧 spec 位于 specs/<cap>/spec.md 目录内"
------------ #step ?s-folder-reg
迁为同目录 folder registry codument/behaviors/<cap>/index.xml（不折叠成单文件）
------------ /?s-folder-reg
---------- /?s-folder
---------- #else ?s-single
------------ #step ?s-single-reg
小 capability 迁为 codument/behaviors/<cap>.xml；过大时升级为 <cap>/index.xml + include 子文件
------------ /?s-single-reg
---------- /?s-single
-------- /?s-reg
-------- #case ?s-delta when="track 级差量"
---------- #step ?s-delta-map
迁为 tracks/<id>/behavior_deltas/<cap>/delta.xml 的 <behavior-patch>（<upsert|delete|move> wrapper + behavior:// selector）
---------- /?s-delta-map
-------- /?s-delta
------ /?s-kind
------ #if ?s-exists cond="目标 XML 登记表已存在"
-------- #step ?s-no-overwrite
不覆盖（除非用户明确要求并有备份）：记录冲突，请求确认
-------- /?s-no-overwrite
------ /?s-exists
---- /?s-each
-- /?specs-migrate
```

---

## 4. 验证（统一）

迁移后逐项验证。**外部 CLI 不可用 / 不支持新格式时降级为本地验证，并在报告中写明能力限制——不要把降级判为失败。**

### 4.1 Archive 验证

1. 尝试 `codument validate --strict`；找不到外部 `codument` 命令时说明跳过原因。
2. 额外做 archive 布局扫描（`codument validate --strict` **不保证**检查旧 archive 目录形态）：
   - 查找 `codument/archive/*` 下仍直接含 `track.xml`/`plan.xml` 或 `metadata.json` 的**根级**旧 archive 目录；
   - 查找不匹配 `codument/archive/YYYY-MM/YYYY-MM-DD-HHmm-track-id/` 的目录；
   - 报告**所有**剩余旧布局候选，即使本次只迁了其中一个。
3. 检查新 archive 路径是否符合 `YYYY-MM/YYYY-MM-DD-HHmm-track-id`。

### 4.2 Specs 验证

先识别当前 CLI 是否支持 XML 登记表：

1. 尝试 `codument list --behaviors`、`codument show <capability>`、`codument validate <capability> --strict`。
2. 若上述命令仍只识别旧 `spec.md`，说明当前 CLI 版本不支持 XML 登记表或未升级到本 track 所需版本 → **不要判为失败**，降级本地验证，并在报告中明确写出 CLI 版本/能力限制。

本地降级验证至少包括：

- XML well-formedness（`xmllint --noout` 或等价解析检查）。
- `requirement` / `case` 数量与原 Markdown 场景数量对照。
- `codument/legacy/specs/...` 中的原文备份存在且内容一致。
- generated XML 的 `requirement` / `suite` / `case` `id` 稳定、capability 内全局唯一、无重复。

> `codument validate --strict` 可能格式化或补写 active track metadata；运行后必须检查 `git diff`，并在报告中**区分验证副作用与本次迁移修改**。

### 4.3 验证流程

```text
@delimiter: --
-- #sequence ?verify
---- #if ?v-arch cond="what ∈ {archive, all} 且本次迁了 archive"
------ #step ?v-arch-cli
尝试 codument validate --strict；无命令则记录跳过原因
------ /?v-arch-cli
------ #step ?v-arch-scan
额外扫描残留旧 archive 布局；报告所有剩余候选 + 新路径合规性
------ /?v-arch-scan
---- /?v-arch
---- #if ?v-spec cond="what ∈ {specs, all} 且本次迁了 specs"
------ #if ?v-cli-ok cond="CLI 支持 XML 行为登记表"
-------- #step ?v-spec-cli
跑 codument list --behaviors / show <cap> / validate <cap> --strict
-------- /?v-spec-cli
------ /?v-cli-ok
------ #else ?v-cli-degrade
-------- #step ?v-spec-local
降级本地验证：xmllint well-formedness + 数量对照 + legacy 原文一致 + id 稳定唯一；报告写明 CLI 能力限制
-------- /?v-spec-local
------ /?v-cli-degrade
------ #step ?v-spec-diff
检查 git diff，区分 validate 副作用与本次迁移修改
------ /?v-spec-diff
---- /?v-spec
---- #step ?v-report
汇总：迁移列表 / 跳过列表 / 冲突列表 / legacy 保留项 / 待确认问题
---- /?v-report
-- /?verify
```

---

## 5. 输出

- **archive**：迁移后的 `codument/archive/YYYY-MM/YYYY-MM-DD-HHmm-<id>/`（内含最小修复的 `track.xml`、保留的 spec/summary/reports）。
- **specs**：`codument/behaviors/**`（XML 登记表，单文件或同名文件夹）+ `tracks/<id>/behavior_deltas/**`（`<behavior-patch>`）+ `codument/legacy/specs/**` 原文备份。
- **报告**：迁移 / 跳过 / 冲突 / 待确认四类清单。

## 引用

- 行为登记表布局与节点：`codument/std/spec/behavior-registry.md`
- behavior delta（wrapper + `behavior://`）：`codument/std/spec/behavior-delta.md`
- 独立复检（仅用户显式要求时）：`codument/std/operations/gap-loop.md`
- 流程标记块语法：`codument/std/operations/_operation-spec.md`
