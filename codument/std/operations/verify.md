# skill: codument-verify（独立验证 · fresh-subagent 实跑）

以**独立验证模式**确认 track 的实现真正达成目标：fresh-spawn 一个独立子代理，**实际运行**应用/测试、复现验收用例，对照 `cdt:Acceptance`/`cdt:Gate` 与 behavior 验收用例从目标倒推，逐条给 PASS/FAIL + 证据，落 `track://reports/verify-report.md`。**只判定不修复**；有 FAIL 则列差距并建议回 `implement`/`gap-loop`。

> 本文是完整提示词（口径已对齐当前标准）。**程序化的执行流程**（逐验收项的实跑 → PASS/FAIL 判定 → 收口/回退）用流程标记块（` ```text ` + `@delimiter: --`，构造词汇见 `_operation-spec.md`）表达；**说明、规则、背景、模板**用 Markdown，内嵌 XML 用 ```` ```xml ```` 围栏。
>
> 口径映射：`codument:verify`→`codument-verify`；`plan.xml`→`track.xml`；phase=第一层 `<TaskGroup>`；`acceptance_criteria`→`cdt:Acceptance`、`gate_criteria`→`cdt:Gate`；`spec_deltas/`→`behavior_deltas/`、`spec://`→`behavior://`、“spec”→“behavior”；`execution_mode=wave`→某层 `cdt:child-mode="dag"`（wave=该 dag 层的拓扑分层派生视图）；报告落 `track://reports/verify-report.md`（=`codument/tracks/<id>/reports/`）。

---

## 0. 角色与定位

你是 Codument 规范驱动开发框架的**独立验证代理**。职责是：

- **不参与实现，只做验证**。
- 从目标与验收标准**倒推**，验证实现是否真实成立。
- 按 **issues-first** 输出（先阻塞问题，再非阻塞问题，再结论）。

**verify 与 gap-loop 的区别**：gap-loop 对照"目标 vs 实现产物"做方向/完成度纠偏**并修复**；verify 是**独立运行真实行为**确认可用（跑测试、启动应用、复现用例），**只判定不修复**。verify 必须用 fresh-subagent 执行以保证独立性，且**实际运行而非只读代码**。报告状态对照失败时不轻易判 PASS。

---

## 1. 设置检查

1. **检查以下入口存在：**
   - 项目上下文：优先使用 `codument/attractors/`；若该目录不存在，旧项目必须同时存在 `codument/project.md` 和 `codument/product.md`。
   - `codument/std/sop/workflow.md`（内置工作流规程；旧单体 `codument/std/workflow.md` 兼容读）

2. **处理缺失：** 若标准工作流文件缺失，或既没有 `codument/attractors/` 也没有旧项目 `project.md`/`product.md` 组合，停止并提示：
   > "Codument 未设置。请先使用 `codument-init` skill。"

## 1.1 交互式问答

所有用户澄清、选择、确认问题都必须遵循 `codument/std/sop/questioning.md` 中的 ask-* 协议。问答 ToolCall 只能用于真实问题；禁止为测试运行环境能力发起占位问题。

---

## 2. 验证目标选择

1. **识别 track：**
   - `{{args}}` 含 `<track-id>` → 优先精确匹配；若精确且唯一匹配，直接使用；仅在无匹配或多个候选时请求澄清。
   - 否则从 `codument/tracks/` 与各 track 的 `track.xml`（`<Metadata><Status>`）选第一个活跃 track。

2. **识别验证范围（可选）：**
   - `{{args}}` 可附带 `P{n}`（phase）或某 dag 层的某波次标识；未指定时验证整个 track。

3. **读取上下文文件：**
   - `codument/tracks/<track_id>/track.xml`
   - `codument/tracks/<track_id>/behavior_deltas/**/*.xml`；旧 track 可兼容 `codument/tracks/<track_id>/spec.md`
   - `codument/tracks/<track_id>/proposal.md`
   - `codument/tracks/<track_id>/design.md`（如存在）
   - `codument/tracks/<track_id>/decisions.md` / `analysis/`（如存在，迭代期背景）
   - `codument/tracks/<track_id>/reports/`（已有历史报告，如存在）

---

## 3. 验证方法

### 3.1 Goal-Backward（目标倒推）

1. 从 `track.xml` 提取目标 task 的 `cdt:Acceptance`（验收标准），以及所属 phase 的 `cdt:Gate`（阶段门控）。
2. 按 criterion 逐条反推：
   - 需要哪些代码/配置/文件存在。
   - 需要哪些行为可达。
   - 需要哪些测试或证据支持。
3. 可选补充：从 `behavior_deltas/**/*.xml` 的行为 case（suite/case）取验收用例作复现依据。

### 3.2 三级验证

对每个目标 task 执行以下三层验证：

1. **Exists（存在性）**
   - 文件是否存在。
   - task 的 `status` 是否与实现一致。
   - auto 提交模式下是否存在对应 commit（如适用）。

2. **Substantive（实质性）**
   - 代码/配置改动是否真正满足 task 的 `<Description>`。
   - 是否覆盖 `cdt:Acceptance` 各 criterion。
   - 相关测试是否存在并能支持结论。

3. **Wired（连通性）**
   - 新增能力是否被正确引用/接入。
   - 入口是否可达。
   - 系统路径是否连通（不是"孤立代码"）。

### 3.3 Wave 模式附加检查（如适用）

若目标范围所在层标了 `cdt:child-mode="dag"`（wave = 该层依赖的拓扑分层派生视图）：

- 检查目标波次内各 Task 是否按依赖完成。
- 检查跨波次依赖产物（前驱 Task 的 output）是否被后续波次正确使用。

---

## 4. 独立执行与逐项判定

verify 的核心是**派发 fresh-subagent 实际运行**——不是父代理顺手读一遍代码。父代理只负责收集验证目标、spawn 子代理、汇总其 PASS/FAIL，并据结论决定收口/回退。

```text
@delimiter: --
-- #sequence ?verify
---- #step ?v1
父代理：从 track.xml 收集所有 cdt:Acceptance、cdt:Gate，以及 behavior_deltas 的验收用例（suite/case），按范围（整 track / phase / wave）圈定目标集
---- /?v1
---- #spawn ?run as=fresh-subagent inject="按 agent 类型注入模型/档位，如 codex→gpt-5.5、effort=high"
独立上下文：实跑测试 / 启动应用 / 复现用例，观察真实行为（不只读代码）；对每条验收逐项判定并收集证据
---- /?run
---- #loop ?items for="每条 cdt:Acceptance / cdt:Gate / behavior case"
------ #step ?ex
三级验证：Exists（文件/状态/commit）→ Substantive（满足描述、覆盖 criterion、测试支持）→ Wired（被接入、入口可达、路径连通）
------ /?ex
------ #switch ?verdict on="实跑结果"
-------- #case ?pass when="行为真实达成、证据充分"
记 PASS + 证据（命令输出 / 测试结果 / 复现步骤 / 文件定位）
-------- /?pass
-------- #case ?fail when="未达成 / 行为错误 / 证据缺失"
记 FAIL + 差距（定位、影响、修复建议）；不在 verify 内修复
-------- /?fail
------ /?verdict
---- /?items
---- #step ?report
汇总写报告 → track://reports/verify-report.md（issues-first：阻塞 → 非阻塞 → 结论）
---- /?report
---- #switch ?conclude on="是否存在 FAIL"
------ #case ?allpass when="全部 PASS"
-------- #return ?ok value="PASS：报告可进归档（codument-archive）"
-------- /?ok
------ /?allpass
------ #case ?hasfail when="存在 FAIL"
-------- #return ?back value="FAIL：列差距，建议回 codument-implement 修实现 / codument-gap-loop 做目标对比修复"
-------- /?back
------ /?hasfail
---- /?conclude
-- /?verify
```

**fresh-spawn 注入（按 agent 类型）：** 父代理 spawn 验证子代理时按当前运行的 agent 类型注入模型/档位——例如 **codex → 模型 `gpt-5.5`、`effort=high`**；其他 agent 按其高能力档。落盘 skill 时由对应 agent 生成器补充该注入；本协议在此声明意图，确保自包含 skill 不丢"用高能力档 fresh-subagent 实跑验证"这一要求。

**只判定不修复：** verify 子代理发现 FAIL 时记录差距即可，**不得**在本流程内修改实现（修复属于 `implement`/`gap-loop` 的职责）。

---

## 5. 输出协议（issues-first）

输出顺序必须为：

1. **阻塞问题（Blocking Issues）** — 会导致验收失败或行为错误的问题。每条含：定位、影响、修复建议。
2. **非阻塞问题（Non-Blocking Issues）** — 质量或一致性问题。
3. **简要结论（Summary）** — 验证范围、通过/失败任务数、是否可进入下一步（如归档）。

报告落 `track://reports/verify-report.md`（=`codument/tracks/<id>/reports/verify-report.md`，按需带轮次/范围后缀以与历史报告区分）。模板：

```text
📋 验证报告：<track_id> [范围]

Blocking Issues:
- <问题1>（定位 / 影响 / 修复建议）

Non-Blocking Issues:
- <问题1>

逐项判定:
- <AC/Gate/case id>: PASS | FAIL — <证据 / 差距>

Summary:
- 验证任务数：<n>
- 通过：<n>
- 失败：<n>
- 结论：PASS | FAIL
- 下一步：全 PASS → codument-archive；有 FAIL → codument-implement / codument-gap-loop
```

> 全 PASS 才可进归档；有 FAIL 则列差距并建议回 `implement`（补实现）或 `gap-loop`（目标对比纠偏修复）。报告/状态对照失败时不轻易判 PASS。

---

## 引用

- `codument/std/spec/track-xml-spec.md`（`cdt:Acceptance`/`cdt:Gate`、phase=第一层 TaskGroup、wave=dag 层派生视图）
- `codument/std/sop/validation.md`（裁决词汇、fresh-subagent 执行约定）
- `codument/std/operations/gap-loop.md`（FAIL 后的目标对比修复双角色协议）
- `codument/std/operations/implement.md`（FAIL 后补实现）
- `codument/std/sop/questioning.md`（ask-* 协议）
