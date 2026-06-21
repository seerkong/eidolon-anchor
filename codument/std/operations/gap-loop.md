# skill: codument-gap-loop（Gap Loop 命令 · 双角色协议）

**本提示词同时供父层编排代理与 fresh 子代理阅读。** 读完后**必须先判断自己当前所处的角色**，再只执行对应章节允许的动作。

> 本文是完整协议（口径已对齐当前标准）。**程序化的执行流程**（串行/并行/条件/循环/spawn/返回/退出）用流程标记块（` ```text ` + `@delimiter: --`，构造词汇见 `_operation-spec.md`）表达；**说明、规则、背景、示例**用 Markdown。
>
> 口径映射：`codument:gap-loop`→`codument-gap-loop`；`plan.xml`→`track.xml`；`validation_mode=yield-gap-loop`/`validation_granularity`→该 scope 挂 `<cdt:GapLoop>`、挂在终态 phase（final）或每个 phase（every）；`<confirm>`→`<cdt:GapLoop>`/`<cdt:HumanConfirm>` 节点；`<gap_loop_round>`→track.xml `<Metadata>` 的 `gap-round`；`spec_deltas/`→`behavior_deltas/`；`reports/`→`codument/tracks/<id>/reports/`。

---

## 0.0 总纲

`<cdt:GapLoop>` 的目标**不是**让"当前拿到命令的代理顺手做一次 review"，而是把工作拆成两个角色：

1. **父层编排代理**：负责轮次控制、fresh-spawn 新一轮、根据 XML 结果决定继续/复检/阻塞。
2. **fresh 子代理**：只负责当前这一轮的目标对比、gap 报告、必要修正与 XML 返回。

读完本文件后没有先判断角色就直接审查代码、diff 或写报告，属于**违反协议**。

## 0.1 角色判定

读完本文件后的第一判断必须是：

```text
@delimiter: --
-- #switch ?role on="我是不是'专门为这一轮 gap-loop freshly created 的 round executor'？"
---- #case ?yes when=是
按「§2 Fresh 子代理章节」执行
---- /?yes
---- #case ?no when=否
按「§1 父层编排代理章节」执行
---- /?no
-- /?role
```

特别注意：

- 同一个文件给两个角色共用，**不代表两个角色都执行全部步骤**。
- 父层代理不得越权去做子代理的一轮实质工作。
- 子代理不得越权去决定下一轮是否继续。

## 0.2 公共规则

### 0.2.1 上层封装运行环境优先级

如果当前运行在一个更上层的封装编排环境中，而该环境本身已经实现了 gap-loop 协议，则**以上层环境的编排实现为准**。

如果当前 scope 已由上层 `operation-hooks.xml` 或 track.xml 的 `<cdt:AttractorCheck>`/`<cdt:GapLoop>` 拥有校验，**不要**在 gap-loop 子代理内启动 competing nested check。可以读取已有 hook 结果作为背景，但是否重跑由父层决定。

这类环境包括但不限于：

- 多 agent / agent teams 编排应用
- 自定义制度化 workflow 应用
- 显式指定由某个上层 orchestrator 统一主持 gap-loop 的运行环境

此时：当前 agent 必须先判断自己是上层 orchestrator 还是其下游 worker；若上层已声明"由它主持 fresh-round orchestration"，下游 worker **不得**再在本层私造竞争性 nested gap-loop。Codument 的 gap-loop 约束仍有效，但"谁来承担 parent orchestrator"由上层环境定义。

### 0.2.2 手动触发时的模式补齐

如果用户显式执行 `codument-gap-loop <track-id>`，而当前 track 的该 scope 原本不是 gap-loop 模式（挂的是 `<cdt:HumanConfirm>`，或没挂校验节点），则父层在启动第 1 轮**之前**，必须先把 track.xml 补齐并切到 gap-loop 模式：

```text
@delimiter: --
-- #sequence ?patch
---- #step ?d1
把该 scope 的校验节点切为 <cdt:GapLoop>（带 max-rounds / on-exhausted 属性）
---- /?d1
---- #step ?d2
定 granularity：多个 phase 已配 phase 级校验 → every_phase；否则 final_phase
---- /?d2
---- #step ?d3
轮次初始化为 0（写 track.xml <Metadata> 的 gap-round）
---- /?d3
---- #if ?p1 cond="命令带 --phase <id>"
该 phase 至少必须具备可执行的 <cdt:GapLoop>
---- /?p1
---- #else ?p2
整个 track 的 phase 级校验布局必须与最终 granularity 一致
---- /?p2
-- /?patch
```

### 0.2.3 轮次元数据

该 scope 处于 gap-loop 模式时，track.xml `<Metadata>` 记录当前轮次（字段 `gap-round`，或由 `reports/` 报告序号承载）：创建/切入时为 `0`；父层**每次启动新一轮前先更新为当前 round 编号**；旧 track 缺该字段按 `0`。

### 0.2.4 历史报告与首轮怀疑规则

父层决定是否收口时必须区分：

1. **已有历史 gap-loop**：`reports/` 已有报告，或 `gap-round > 1`。
2. **从未跑过 gap-loop**：`reports/` 为空或不存在，且当前是第 1 轮。

对第 2 类场景：首轮 fresh 子代理返回 `NO_GAP`，父层**仍必须保持怀疑**，必须再 fresh-spawn 一轮验证。即 **首轮 + 无历史报告 + `NO_GAP` 不能直接收口。**

### 0.2.5 统一禁止事项

无论你是哪种角色，都禁止：

- 复用上一轮 gap-loop 子代理上下文。
- 把当前代理的预检查结果伪装成正式 round 结果。
- 让子代理在本轮结束后自己继续下一轮。
- 在上层 orchestrator 已声明接管时，再在下层节点内部私造一层 nested gap-loop。

---

## 1.0 父层编排代理章节

### 1.1 你是父层编排代理时，只允许做什么

只允许：解析参数、确认 scope、补齐 gap-loop 模式与轮次元数据、查 `reports/` 历史、fresh-spawn 子代理、传输入/输出契约、等 XML、据 XML 决策。

在 fresh-spawn 子代理之前，父层**禁止**：自己读审代码实现细节、分析未提交 diff、生成 gap 结论、写 gap 报告、修正实现。

**fresh-spawn 注入（按 agent 类型）**：父层 spawn 子代理时按当前运行的 agent 类型注入模型/档位与必要指令——例如 **codex → 模型 `gpt-5.5`、`effort=high`**；其他 agent 按其高能力档。落盘 skill 时由对应 agent 生成器补充该注入；本协议在此声明意图，确保自包含 skill 不丢"用高能力档跑 fresh 复检"这一要求。

### 1.2 父层主循环（每轮顺序 + 收到 XML 的处理）

父层的整个职责就是这段**循环程序**——每轮 spawn 一个 fresh 子代理，据其返回 status 决定续轮 / 收口 / 阻塞：

```text
@delimiter: --
-- #loop ?rounds max="cdt:GapLoop 的 max-rounds"
---- #step ?s1
解析参数 <track-id> / --phase / --background，确认本轮 scope（track 或 phase）
---- /?s1
---- #if ?s2 cond="该 scope 已被更上层 orchestrator 接管且你未被授权"
------ #exit ?x0
停止本地 loop，把控制权交回上层协议（见 0.2.1）
------ /?x0
---- /?s2
---- #step ?s3
读 track.xml；若该 scope 非 gap-loop 模式，先按 0.2.2 补齐
---- /?s3
---- #step ?s4
读当前 gap-round（缺失按 0）；查 codument/tracks/<id>/reports/ 历史报告
---- /?s4
---- #step ?s5
gap-round = gap-round + 1，写回 track.xml <Metadata>
---- /?s5
---- #spawn ?run as=fresh-subagent inject="按 agent 类型注入模型/档位，如 codex→gpt-5.5、effort=high"
只传最小上下文（track-id、phase、background、固定输入范围、输出 XML 契约）；等它返回结构化 XML
---- /?run
---- #switch ?dispatch on="子代理返回的 status"
------ #case ?c_blocked when=BLOCKED
把该 scope 的 <cdt:GapLoop>/<cdt:HumanConfirm> 标 BLOCKED
-------- #exit ?x1
停下请求用户输入
-------- /?x1
------ /?c_blocked
------ #case ?c_fix when=FIX_APPLIED
-------- #continue ?cont1
不得停、不得收口：本轮已修复，继续下一轮复检
-------- /?cont1
------ /?c_fix
------ #case ?c_nogap1 when="NO_GAP 且 首轮+无历史+从未跑过"
-------- #continue ?cont2
首轮怀疑：不得收口，再跑一轮验证
-------- /?cont2
------ /?c_nogap1
------ #case ?c_nogap2 when="NO_GAP 且 非首轮怀疑"
把该 scope 校验节点标 DONE
-------- #return ?ok value=收口
-------- /?ok
------ /?c_nogap2
---- /?dispatch
-- /?rounds
-- #step ?exhausted
循环达 max-rounds 仍未 NO_GAP 收口 → 按 on-exhausted（block = 标 BLOCKED 等用户）
-- /?exhausted
```

### 1.3 强制循环规则（即 §1.2 `#switch ?dispatch` 的语义）

为强调，上面 `#switch` 的四条规则用文字复述——父层**不得**偏离：

- `BLOCKED` → 标 BLOCKED，停下请求用户输入。
- `FIX_APPLIED` → **不得停、不得视为完成**，必须 `#continue` 续轮复检。
- `NO_GAP`（首轮 + 无历史 + 从未跑过）→ **不得收口**，`#continue` 再跑一轮验证（首轮怀疑）。
- `NO_GAP`（非首轮怀疑）→ 才可 `#return` 收口（标该 scope 校验节点 DONE）。

### 1.4 父层对外输出限制

父层代理对用户最终**只应转交子代理返回的结构化 XML**。不应输出自己的 gap 推理过程，不应把自己的中间判断冒充为本轮 gap-loop 结果。

---

## 2.0 Fresh 子代理章节

### 2.1 继续执行的前提

你只有在满足以下前提时才允许继续：

- 你已经是本轮 freshly created 的专用执行者。
- 当前 track 的该 scope 已由父层确认/补齐为 gap-loop 模式。
- 当前 round 已由父层决定并写入 track.xml `<Metadata>`。
- 你不是某上层 workflow 下游节点内部私造出来的竞争性 nested loop。

前提不成立则**立即返回 `BLOCKED`**，并说明环境无法满足 fresh-round 执行要求。

### 2.2 你必须读取的输入

必须读取：

- `codument/tracks/<track-id>/proposal.md`
- `codument/tracks/<track-id>/behavior_deltas/**/*.xml`
- `codument/tracks/<track-id>/design.md`（如存在）
- `codument/tracks/<track-id>/track.xml`
- `codument/tracks/<track-id>/reports/` 下已有的历史报告（如存在）

命令提供 `--background <path>` 时继续读取背景文件。还必须检查：当前代码实现、当前未提交改动；若指定 `--phase <phase-id>`，聚焦该 phase 的目标、任务、`<cdt:Acceptance>` 验收与对应实现。

### 2.3 你这一轮必须按什么顺序执行

```text
@delimiter: --
-- #sequence ?round
---- #if ?chk cond="你不是本轮专用 fresh 子代理"
------ #return ?rb value=BLOCKED
------ /?rb
---- /?chk
---- #step ?a2
读取目标文档（proposal.md、behavior_deltas/**/*.xml、design.md、track.xml）
---- /?a2
---- #step ?a3
读取 codument/tracks/<id>/reports/ 历史 gap 报告；读 --background 背景文件
---- /?a3
---- #step ?a5
review 当前实现与未提交改动（带 --phase 则聚焦该 phase）
---- /?a5
---- #step ?a6
生成新 gap 报告 → codument/tracks/<id>/reports/track-impl-gap-report-<round>.md
---- /?a6
---- #switch ?verdict on="本轮结论"
------ #case ?v1 when="没有 gap"
不做不必要修改
-------- #return ?rn value=NO_GAP
-------- /?rn
------ /?v1
------ #case ?v2 when="存在 gap"
先更新 track.xml，必要时 design.md / behavior_deltas/**/*.xml → 再修正实现
-------- #return ?rf value=FIX_APPLIED
-------- /?rf
------ /?v2
------ #case ?v3 when="依赖用户决策 / 外部输入 / 无法继续自动修正"
记录 gap 报告，必要时更新 track.xml / behavior_deltas / design.md
-------- #return ?rbl value=BLOCKED
-------- /?rbl
------ /?v3
---- /?verdict
-- /?round
```

### 2.4 这一轮结束时你不能做什么

返回本轮 XML 后：不得自己继续下一轮；不得假设 `FIX_APPLIED` 就代表收口；不得自行判定"首轮 `NO_GAP` 已经足够"。下一轮是否继续，**由父层编排代理决定**。

---

## 3.0 输出协议

子代理本轮**最终只允许输出**以下结构化 XML：

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

`scope` 规则：未指定 `--phase` → `<scope kind="track">...</scope>`；指定 `--phase P2` → `<scope kind="phase">P2</scope>`。

`status` 只允许：`NO_GAP`（本轮无新增 gap）/ `FIX_APPLIED`（本轮发现并已修复，**须复检**）/ `BLOCKED`（需用户决策 / 外部输入）。

**禁止输出**：Markdown 说明、自然语言前言或总结、额外代码块、多段 XML。
