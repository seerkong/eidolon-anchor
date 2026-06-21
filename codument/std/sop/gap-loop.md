# Gap Loop 规程（std/sop/gap-loop.md）

> 本文件**同时供父层编排代理与 fresh 子代理阅读**。读完后**第一动作必须是判定自己的角色**，再只执行对应章节允许的动作。`codument-gap-loop` skill 是入口；协议总纲见 `validation.md`；上限来自触发处 `<cdt:GapLoop max-rounds on-exhausted>`。
>
> 口径映射（旧格式 → 当前标准）：`plan.xml`→`track.xml`；`validation_mode=yield-gap-loop` / `validation_granularity`→在终态 phase（final）或每个 phase（every）挂 `<cdt:GapLoop>`；`<confirm>`→`cdt:GapLoop`/`cdt:HumanConfirm` 节点；`spec_deltas/`→`behavior_deltas/`；`reports/`→`track://reports/`。

## 0. 总纲与角色

### 0.0 为什么分两个角色

`cdt:GapLoop` 的目标**不是**让"当前拿到命令的代理顺手 review 一次"，而是把工作拆成两个角色：

1. **父层编排代理**：负责轮次控制、fresh-spawn 新一轮、据 XML 结果决定继续/复检/阻塞。
2. **fresh 子代理**：只负责当前这一轮的目标对比、gap 报告、必要修正与 XML 返回。

> 读完本文件**没有先判定角色就直接审查代码 / diff / 写报告 = 违反协议**。

### 0.1 角色判定（读完第一判断）

问自己：**我是不是"专门为这一轮 gap-loop freshly created 的 round executor"？**

- **是** → 按 [§2 Fresh 子代理章节] 执行。
- **否** → 按 [§1 父层编排代理章节] 执行。

注意：同一文件两角色共读，**不代表都执行全部步骤**；父层不得越权做子代理的一轮实质工作；子代理不得越权决定是否继续下一轮。

### 0.2 公共规则

**0.2.1 上层编排环境优先。** 若当前运行在一个已实现 gap-loop 协议的更上层编排环境（multi-agent / 自定义 workflow / 指定 orchestrator）中，**以上层实现为准**。若当前 scope 已由上层 `operation-hooks.xml` 或 track.xml 的 `cdt:AttractorCheck`/`cdt:GapLoop` 拥有校验，**不要**在子代理内再起竞争性的 nested check——可读已有结果作背景，是否重跑由父层决定。下层 worker 不得绕过上层 orchestrator 私造一层 nested gap-loop。

**0.2.2 手动触发时的模式补齐。** 若用户显式 `codument-gap-loop <track-id>` 而该 track 当前 scope 不是 gap-loop 模式（挂的是 `cdt:HumanConfirm` 或没挂），父层在启动第 1 轮**前**必须先改 track.xml 补齐：
- 把该 scope 的校验节点切为 `<cdt:GapLoop>`（带 `max-rounds`/`on-exhausted`）；
- 定 granularity：多个 phase 已配 phase 级校验 → `every_phase`；否则 `final_phase`；
- 初始化轮次为 0；
- 带 `--phase <id>` 时，至少该 phase 要有可执行的 `cdt:GapLoop`；不带 `--phase` 时，整 track 的 phase 级校验布局要与最终 granularity 一致。

**0.2.3 轮次元数据。** track 处于 gap-loop 模式时记录当前轮次（写在 track.xml `<Metadata>` 或由 `track://reports/` 的报告序号承载）：创建时为 0；**父层每次 fresh-spawn 新一轮前先把它更新为当前 round 编号**；旧 track 缺该字段按 0 处理。

**0.2.4 首轮怀疑规则（关键，勿丢）。** 父层决定是否收口时必须区分：
- **已有历史**：`reports/` 已有报告，或 round > 1；
- **从未跑过**：`reports/` 为空/不存在，且当前是第 1 轮。

对"从未跑过"的场景：**首轮 fresh 子代理返回 `NO_GAP` 也不得直接收口**——父层必须保持怀疑，再 fresh-spawn 一轮做验证。即 **首轮 + 无历史报告 + NO_GAP ≠ 收口**。

**0.2.5 统一禁止（无论哪个角色）。**
- 复用上一轮 gap-loop 子代理的上下文；
- 把当前代理的预检查结果伪装成正式 round 结果；
- 让子代理本轮结束后自己继续下一轮；
- 上层 orchestrator 已接管时，在下层节点内部私造竞争性 nested gap-loop。

## 1. 父层编排代理章节

### 1.1 只允许做什么 / 禁止什么

**只允许**：解析命令参数 → 确认 scope（track/phase）→ 检查并补齐 gap-loop 模式与轮次元数据 → 查 `reports/` 历史 → fresh-spawn 新子代理（或等价 fresh session/task/delegate）→ 传本文件规定的最小输入与输出契约 → 等 XML → 据 XML 决策。

**fresh-spawn 之前禁止**：自己读审代码实现细节、自己分析未提交 diff、自己生成 gap 结论、自己写 gap 报告、自己修正实现。

### 1.2 每轮执行顺序

```text
@delimiter: --
-- #sequence ?round
---- #step ?p1
解析参数 <track-id> / --phase / --background
---- /?p1
---- #if ?p2 cond="该 scope 被更上层 orchestrator 接管且你未被授权"
停本地 loop，交回上层协议（见 0.2.1）
---- /?p2
---- #step ?p3
读 track.xml；该 scope 非 gap-loop 模式则先补齐（0.2.2）
---- /?p3
---- #step ?p4
读当前轮次（缺失按 0）；查 track://reports/ 历史报告
---- /?p4
---- #step ?p5
next_round = current_round + 1，先写回 track.xml <Metadata>
---- /?p5
---- #spawn ?p6 as=fresh-subagent
fresh-spawn 新 round executor，只传最小上下文（track-id、phase、background、固定输入范围、输出 XML 契约）；等它返回结构化 XML
---- /?p6
-- /?round
```

### 1.3 收到 XML 后的强制循环规则

```text
@delimiter: --
-- #switch ?dispatch on="子代理返回的 status"
---- #case ?blocked when=BLOCKED
把该 scope 的 cdt:GapLoop/cdt:HumanConfirm 标 BLOCKED，停下请求用户输入
---- /?blocked
---- #case ?fix when=FIX_APPLIED
不得停、不得视为完成——更新轮次 → 再 fresh-spawn 新子代理（必续轮）
---- /?fix
---- #case ?nogap1 when="NO_GAP 且 首轮+无历史+从未跑过"
不得立即收口——再 fresh-spawn 一轮验证（0.2.4 首轮怀疑）
---- /?nogap1
---- #case ?nogap2 when="NO_GAP 且 不满足首轮怀疑"
把该 scope 校验节点标 DONE，收口
---- /?nogap2
---- #case ?exhausted when="轮次 ≥ max-rounds"
按 on-exhausted（block=标 BLOCKED 等用户）
---- /?exhausted
-- /?dispatch
```

### 1.4 对外输出限制

父层对用户**只转交子代理最终返回的结构化 XML**；不输出自己的 gap 推理过程，不把自己的中间判断冒充为本轮结果。

## 2. Fresh 子代理章节

### 2.1 继续执行的前提

仅当全部满足才继续，否则立即返回 `BLOCKED` 并说明环境无法满足 fresh-round 要求：
- 你确实是本轮 freshly created 的专用执行者；
- track.xml 已由父层确认/补齐为 gap-loop 模式；
- 当前轮次已由父层写入元数据；
- 你不是某上层 workflow 下游节点私造的竞争性 nested loop。

### 2.2 必须读取的输入

- `tracks/<id>/proposal.md`、`behavior_deltas/**/*.xml`、`design.md`（如有）、`track.xml`；
- `track://reports/` 下已有的历史报告（如有）；
- `--background <path>` 提供的背景文件（如有）；
- **当前代码实现** + **当前未提交改动**；
- 该 scope 的 `cdt:Acceptance`/`cdt:Gate`；带 `--phase <id>` 时聚焦该 phase 的目标、任务、验收与对应实现。

### 2.3 本轮执行顺序

```text
@delimiter: --
-- #sequence ?execute
---- #if ?chk cond="你不是本轮专用 fresh 子代理"
返回 BLOCKED
---- /?chk
---- #step ?e2
读目标文档（proposal.md、behavior_deltas/**/*.xml、design.md、track.xml）
---- /?e2
---- #step ?e3
读 track://reports/ 历史 gap 报告；读可选 --background 背景文件
---- /?e3
---- #step ?e5
review 当前实现与未提交改动
---- /?e5
---- #step ?e6
生成新 gap 报告 → track://reports/track-impl-gap-report-<round>.md
---- /?e6
---- #switch ?verdict on="本轮结论"
------ #case ?v1 when="无 gap"
不做多余修改 → 返回 NO_GAP
------ /?v1
------ #case ?v2 when="有 gap"
先更新 track.xml，必要时 design.md / behavior_deltas/**/*.xml → 再修正实现 → 返回 FIX_APPLIED
------ /?v2
------ #case ?v3 when="依赖用户决策/外部输入/无法自动修"
记 gap 报告，必要时更新 track.xml/behavior_deltas/design.md → 返回 BLOCKED
------ /?v3
---- /?verdict
-- /?execute
```

### 2.4 本轮结束时禁止

- 自己继续下一轮；
- 把 `FIX_APPLIED` 当作收口；
- 自行判定"首轮 NO_GAP 已足够"。

下一轮是否继续**只由父层决定**。

## 3. 输出协议（子代理本轮只允许输出此 XML）

```xml
<codument-gap-loop-result version="1">
  <protocol>cdt:GapLoop</protocol>
  <track_id>add-user-auth</track_id>
  <scope kind="track">add-user-auth</scope>
  <status>NO_GAP</status>
  <report_path>codument/tracks/add-user-auth/reports/track-impl-gap-report-4.md</report_path>
  <track_updated>false</track_updated>
  <behavior_updated>false</behavior_updated>
  <design_updated>false</design_updated>
  <summary>未发现相对于当前目标的新增 gap。</summary>
</codument-gap-loop-result>
```

- `scope`：不带 `--phase` → `<scope kind="track">...`；带 `--phase P2` → `<scope kind="phase">P2</scope>`。
- `status` 只允许 `NO_GAP` | `FIX_APPLIED` | `BLOCKED`（语义：`NO_GAP`=本轮无新增 gap；`FIX_APPLIED`=发现并已修复、**须复检**；`BLOCKED`=需用户/外部）。
- **禁止**输出：Markdown 说明、自然语言前言/总结、额外代码块、多段 XML。
