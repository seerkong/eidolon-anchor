# skill: codument-revise-track（修订现有 Track 产物）

在 implement、gap-loop、归档准备或其他**非线性工作**中，**修订已有 track 的自包含产物**——增删改 phase/task、调依赖、改 hook，或更新 proposal/design/behavior_deltas/analysis/decisions。它是显式的"改 track 自身"操作，**不替代** implement/gap-loop/archive。

> 本文以 **Markdown 为主**。只有修订的固定执行顺序（前 hook → 定位 → 应用 → 后 hook）与"按变更类型改哪个文件"的分发用流程标记块表达；XML 片段用 ` ```xml ` 围栏内嵌。
>
> 口径映射（旧→新，全文一致）：`codument:revise-track`→`codument-revise-track`；`plan.xml`→`track.xml`；`spec_deltas/`→`behavior_deltas/`、`<spec-patch>`→`<behavior-patch>`、"spec"→"behavior"；`attractor-profiles.json`→`config/attractor-profiles.xml`（缺失默认 profile = `coding` → `attractors/project.md`）；`<attractor-check>`/`<confirm>` hook →`<cdt:AttractorCheck use="coding">`/`<cdt:HumanConfirm>`。track.xml 口径见 `codument/std/spec/track-xml-spec.md`，目录布局见其 §0.5。

---

## 0. 意图与触发

**意图。** 修订现有 track 的产物：`proposal` / `design` / `behavior_deltas` / `track.xml`（增删改 phase/task、调度依赖、hook），以及 `analysis` / `decisions`。不替代 implement/gap-loop/archive。

**触发。** 需求细化、范围调整、发现遗漏的阶段 / 任务、调度需改、出现新决策或新上下文时。**动态加入 / 删除 phase**（随任务细化）也走本 skill。

**为什么 revise 在新 track.xml 下很轻。** `<TaskSpace>` 是 **id 寻址、状态标在节点上**的工作树：增删一个 Task = 改一处（加 / 删一个 `<Task>`/`<TaskGroup>` + 必要的一条 `<After>`），不触动他人结构、无全局重编号——这正是新 `track.xml` 相对旧固定三层 `plan.xml` 的优势。

---

## 1. 设置检查（前置）

1. 验证存在 `codument/attractors/`、`codument/std/sop/workflow.md`。
2. 读 `codument/config/attractor-profiles.xml`；缺失时用默认 profile `coding`（对照 `attractors/project.md`；旧项目兼容 `project.md` + `product.md`）。
3. 如存在 `codument/config/operation-hooks.xml`，读其中 `operation name="revise-track"` 的 hook 配置。

---

## 2. 选择 Track

```text
@delimiter: --
-- #switch ?pick on="用户如何指定 track"
---- #case ?exact when="给了 track id"
精确匹配 codument/tracks/<track_id>/
---- /?exact
---- #case ?fuzzy when="给了模糊描述"
列出候选并请求确认
---- /?fuzzy
---- #default ?none
无法唯一确定目标 track → 停止并请求用户补充
---- /?none
-- /?pick
```

---

## 3. 修订前 Hook（revise:before）

若 `operation-hooks.xml` 中存在 `operation name="revise-track"` 的 `point="before-revise"` hook，则在修改**任何** track 文件**之前**执行它。常见配置是**方向审查**（默认 `cdt:AttractorCheck use="coding"`）：

```xml
<operation name="revise-track">
  <hook point="before-revise">
    <cdt:AttractorCheck use="coding" when="before" status="TODO" executor="fresh-subagent">
      <result-policy on-gap="confirm-before-fix">
        <cdt:HumanConfirm when="after" status="TODO"/>
      </result-policy>
    </cdt:AttractorCheck>
  </hook>
</operation>
```

**若 hook 返回 `BLOCKED`，不要修改 track 文件**——按 result-policy 处理（如等待用户确认）后再决定是否继续。

---

## 4. 修订 Track

**读取目标 track 的现有产物**（修订依据必须来自 track 目录内）：

- `proposal.md`（与 `proposal/`）
- `design.md`（与 `design/`，如存在）
- `behavior_deltas/**/*.xml`
- `track.xml`
- `analysis/**`（findings / knowledge）
- `decisions.md`（与 `decisions/`）

**据 intent 更新最小必要文件**——保 id 稳定，尽量增量编辑（加 / 删一个 `Task`/`TaskGroup`、调一条 `<After>`、改一个 `<Hook>`），不做全局重排：

```text
@delimiter: --
-- #switch ?route on="本次修订的性质"
---- #case ?behavior when="需求 / 行为变化"
更新 behavior_deltas/<cap>/delta.xml（<behavior-patch>，<upsert|delete|move> wrapper + behavior:// selector）
---- /?behavior
---- #case ?design when="方案变化"
更新 design.md 或 design/
---- /?design
---- #case ?tasks when="任务 / 阶段 / 调度变化"
编辑 track.xml：增删 phase（第一层 TaskGroup）/ task；新增节点 status="NOT_STARTED"；
调度变化则改 cdt:child-mode 与 <Schedule><Dag for><Node><After ref>；hook 变化则改对应 <Hooks>
---- /?tasks
---- #case ?context when="新发现 / 新上下文"
更新 analysis/findings.md 或 analysis/knowledge.md（外部记忆）
---- /?context
---- #case ?decision when="待确认决策"
追加到 decisions.md（不新建分散决策记录；durable 决策同时落 decisions/<slug>.md）
---- /?decision
---- #default ?multi
以上多类同时变化时，逐一应用最小编辑
---- /?multi
-- /?route
```

**自包含硬规则**：所有必要上下文必须保留在目标 track 目录内。**不引用 `.` 开头隐藏目录，也不引用 track 目录外的说明文档**作为理解本次修订的必需来源。

---

## 5. 校验

- 跑 `codument validate <id> --strict`（结构 / 调度 / 引用；找不到 `codument` 命令则跳过并明确说明）。校验点见 `track-xml-spec.md` §9（id 唯一、`<Dag for>` 指向 dag 层且 `<After ref>` 只引用直接下层且无环、`<Hook on>` 合法、`<cdt:AttractorCheck use>` 能解析到 profile 等）。
- 更新 `track.xml` 的 `Metadata.UpdatedAt`。

---

## 6. 修订后 Hook（revise:after）

若 `operation-hooks.xml` 中存在 `point="after-revise"` hook，修订完成后执行——可用于人工确认、吸引子复检或生成下一步建议。

---

## 7. 输出

报告：

- **修改过的 track 文件**（哪些 behavior_deltas / design / track.xml / analysis / decisions）；
- **修订原因**；
- **是否执行了 operation hook**（before / after，及结果）；
- **推荐下一步**：继续 `codument-implement`、运行 `codument-gap-loop`、再次 `codument-revise-track`，或 `codument-archive`。

---

## 8. 引用

- `codument/std/spec/track-xml-spec.md` —— track.xml 三轴规范与目录布局（§0.5）
- `codument/config/operation-hooks.xml` —— `operation name="revise-track"` 的 before/after hook
- `codument/config/attractor-profiles.xml` —— `coding`/`docs`/`memory` profile 定义
