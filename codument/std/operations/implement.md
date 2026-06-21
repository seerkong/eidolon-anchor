# skill: codument-implement（执行任务 · 编排器）

**描述：** 作为编排器，按 `track.xml` 的 TaskSpace 层级 + Schedule（顺序 / DAG）推进任务：派发 fresh 子代理执行叶任务、回写 status、在生命周期点跑 `cdt:` hook、auto 模式逐任务 commit + Git Notes。

> 本文是完整执行协议（口径已对齐当前标准）。**程序化的执行流程**（遍历 phase / TaskSpace、层内顺序或 DAG 调度、并行 wave 派发、逐任务 fresh-spawn、status 回写、生命周期 hook、ACTIVE 续跑）用流程标记块（` ```text ` + `@delimiter: --`，构造词汇见 `_operation-spec.md`）表达；**说明、规则、背景、示例**用 Markdown。
>
> 本 skill **合并**了旧 `codument:implement` 与 `codument:execute-wave`——execute-wave 的「波次编排」折叠进来：波次（wave）不再手维护，而是某 `cdt:child-mode="dag"` 层依赖的**拓扑分层派生视图**，由本 skill 在执行时从 `<Schedule>` DAG 推导。
>
> 口径映射：`codument:implement`/`codument:execute-wave`→`codument-implement`；`plan.xml`→`track.xml`；phase = `<TaskSpace>` 第一层 `<TaskGroup>`；状态枚举沿用（`NOT_STARTED|ACTIVE|DELEGATED|FORWARDED|DONE|REFUSED|ABANDONED`），`IN_PROGRESS→ACTIVE`、`TODO→NOT_STARTED`；`<waves>`/`wave=`/`execution_mode=wave`→`<Schedule>` 的 `cdt:child-mode="dag"` + `<Dag for><Node id><After ref>`；`context_files`→`<Ports><MaterialBundle role="input">` 路径；`<confirm>`/`validation_mode`→`<Hooks>` 里的 `cdt:GapLoop`/`cdt:HumanConfirm`；`<attractor-check>`→`<cdt:AttractorCheck use=profile>`；`spec_deltas/`→`behavior_deltas/`，"spec"→"behavior"；旧 `state.json` 续跑→**status-in-XML**（`status=ACTIVE` 任务即中断点，不读 state.json 作为恢复点）；commit_mode `auto`→逐任务 commit + Git Notes。
>
> wave-mode 旧文件（`context.md`/`state.md`/`phases/`/`waves/` 目录）**全部废弃**，被 TaskSpace 的 status-in-XML + `<Schedule>` 取代——**不要再生成它们**。

---

## 0.0 角色与总纲

你是 Codument 规范驱动开发框架的**编排器**。职责是按 `track.xml` 三轴（TaskSpace 结构 / Schedule 调度 / Hooks 行为）推进一个 track 的实现。核心原则：

- **编排器保持轻量**（~10–15% 上下文）：只读 `track.xml` + 派发，**不亲自写代码**。
- 通过 **fresh 子代理**执行具体叶任务，每个子代理拿独立上下文窗口。
- **只传路径与引用**（track_dir、task id、`<Description>`、`cdt:Acceptance`、input/output MaterialBundle 路径、前置产物位置），子代理**自行读取**所需文件——不把目录正文塞进编排器上下文。
- **每个子代理产出必须独立 spot-check**：子代理自述不是结论；编排器要用命令、测试、diff 与客观证据确认后，才能把任务回写为 DONE。
- 波次间知识通过 wave 完成小结 + `track.xml` status 传递，**不再**写 `index.md`/`state.md`。
- 长程事实写入 `analysis/findings.md`：phase/wave 结论、实证指标、环境约束、失败归因与机制漏洞都落盘，供续跑和后续 track 复用。

**`track.xml` 是执行状态真源**：任务/阶段状态在 XML 属性里（`status=`），track 状态在 `<Metadata><Status>`。codument **不从 `state.json` 派生执行状态**——续跑点、进度、完成统计全部从 XML 派生。

---

## 1.0 前置检查与 track 选择

### 1.1 设置检查

验证 Codument 环境正确初始化。检查以下入口存在：

- `codument/attractors/`（项目级吸引子目录）
- `codument/std/`（标准提示词 / spec / sop 已落盘）
- 旧项目兼容：无 `codument/attractors/` 时读 `codument/project.md` + `codument/product.md`；`codument/tech-stack.md` 是旧兼容文件，新项目不必需。

任一**必需**入口缺失则立即停止，宣布：「Codument 未设置。请使用 `codument-init` skill 设置环境。」**不要**继续 track 选择。

### 1.2 交互式问答（克制提问）

引用 `codument/std/sop/questioning.md` 的 `ask-*` 协议。**重要**：若环境支持提问 ToolCall，**仅在"必须提问"的场景**使用；**禁止**为测试运行环境能力而发占位问题，也**禁止**仅因为环境支持 ToolCall 就在每个 phase / wave 边界额外发问。

**必须提问的场景仅包括**：

- 需要用户选择（track 选择模糊、phase 选择）。
- 节点配了 `cdt:HumanConfirm`（`when` 含 `before/after`）需等待人工确认。
- 子代理执行失败、抽检失败、DAG 阻塞、门控失败等**失败处理分支**（询问重试 / 跳过 / 中止）。
- step 0 续跑检测发现 `ACTIVE` 任务（继续 / 重做 / 跳过）。

### 1.3 选择 track

```text
@delimiter: --
-- #sequence ?select
---- #step ?s1
扫描 codument/tracks/ 各 track 的 track.xml <Metadata>；无有效 track 目录或 track.xml → 宣布"没有可实现的活跃 track"并停止
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

未选出任何 track 则通知用户并等待指示（`ask-single-question-free`）。

---

## 2.0 加载 track 上下文（step 1）

选定 track 后：

1. **宣布操作**：宣布正在实现哪个 track。
2. **更新 track 状态**：开始工作前，把选中 track 的 `<Metadata><Status>` 更新为 `in_progress`、`<UpdatedAt>` 更新为当前时间。
3. **读取必需文件**（路径以 `codument/tracks/<track-id>/` 为根）：
   - `track.xml`（TaskSpace / Schedule / Hooks / Ports 三轴 + 元信息）。
   - `proposal.md`、`design.md`（如存在）。
   - `behavior_deltas/**/*.xml`（行为增量；旧 track 兼容读 `spec.md`）。
   - `analysis/findings.md`、`analysis/knowledge.md`（如存在；长程事实锚，续跑时优先读）。
   - `decisions.md`（如存在；包含用户拍板与执行期决策）。
   - 方法论：`codument/std/sop/tdd.md`。
   - 调度套路：`codument/std/sop/wave-exec.md`。
4. **识别提交模式**：从 `<Metadata><CommitMode>` 取 `auto|manual`。
5. **错误处理**：任一必需文件读不到 → 停止并通知用户。

---

## 3.0 续跑检测 / 中断恢复（step 0）

`track.xml` 的任务 `status` 就是恢复点真源——**不读 `state.json` 作为恢复点**。入口先读 XML 状态：若存在 `status=ACTIVE` 的任务（上次会话中断在此），用 `ask-single-question-closed` 让用户选「继续 / 重做 / 跳过」，再进入遍历；没有 `ACTIVE` 任务就从第一个未完成 phase 起。

若上次会话刚收到子代理结果但尚未完成父层 spot-check（例如 `analysis/findings.md` 或对话记录显示"待抽检 / 待复核"，或任务尚未从 ACTIVE 回写 DONE），**本轮第一件事就是独立 spot-check**，通过后再回写状态；不得直接相信上轮子代理自述继续后续任务。

```text
@delimiter: --
-- #sequence ?resume
---- #step ?r1
解析 track.xml，找 status=ACTIVE 的任务（上次中断点）与上一个 DONE 的任务
---- /?r1
---- #switch ?r2 on="是否存在 status=ACTIVE 的任务"
------ #case ?has when="存在 ACTIVE 任务"
用 ask-single-question-closed 提问（中断恢复）：
  "检测到上次中断。任务 '<任务名>'(<id>) 状态为 ACTIVE。
   A. 继续此任务  B. 重做此任务  C. 跳过此任务，继续下一个"
-------- #switch ?pick on="用户选择"
---------- #case ?A when=继续
从该 ACTIVE 任务原地继续
---------- /?A
---------- #case ?B when=重做
该任务回置 status=NOT_STARTED，从头重做
---------- /?B
---------- #case ?C when=跳过
该任务置 status=ABANDONED（或 REFUSED），起点移到下一个未完成任务
---------- /?C
-------- /?pick
------ /?has
------ #default ?none
无 ACTIVE 任务 → 起点 = 第一个 status≠DONE 的 phase（第一层 TaskGroup）
------ /?none
---- /?r2
-- /?resume
```

---

## 4.0 主执行流程：遍历 phase + 层内调度 + 派发

宣布将按 `tdd.md` 方法论执行 `track.xml` 中的任务。整个执行是一段**结构递归的程序**：逐 phase（第一层 TaskGroup，按 `order`）；每 phase 跑 `phase:before` hook → 调度执行其直接下层 → `phase:after` hook → 校验 `cdt:Gate`。层内调度按该层 `cdt:child-mode`：`dag` 走拓扑分层 wave 并行，否则按 `order` 顺序。非叶任务（TaskGroup）递归同理。

```text
@delimiter: --
-- #loop ?phases for="track.xml TaskSpace 第一层每个 TaskGroup（=phase），按 order 升序，从续跑起点开始"
---- #call ?hb target="run-hooks(on=phase:before, 该 phase)"
---- /?hb
---- #call ?sched target="schedule-level(该 phase 节点)"   ← 见 §5 层内调度
---- /?sched
---- #call ?ha target="run-hooks(on=phase:after, 该 phase)"   ← 见 §7 生命周期 hook（含门控）
---- /?ha
---- #step ?gate
校验该 phase 的 <cdt:Gate>：逐条 <cdt:Criterion> 核对（所有任务 DONE / 测试 / 覆盖率 / lint 等）；未过按 §8 门控失败处理
---- /?gate
---- #step ?ckpt
若 CommitMode=auto 且门控通过：创建阶段检查点 commit + Git Notes（见 §9）；把检查点 commit SHA 记到该 phase 节点
---- /?ckpt
---- #step ?findings
把 phase 门控结果、spot-check 证据、关键指标、失败/修复事实追加到 tracks/<id>/analysis/findings.md；稳定结论按 knowledge-tiers.md 判断是否需晋升
---- /?findings
-- /?phases
-- #call ?done target="finalize-track()"   ← 见 §10 完成 track
-- /?done
```

---

## 5.0 层内调度（顺序 or DAG · step 3）

对某个非叶节点（phase 或嵌套 TaskGroup）调度其**直接下层**：默认按 `order` 依次执行；只有该节点标了 `cdt:child-mode="dag"` 时，才用 `<Schedule><Dag for="该节点">` 构 DAG、拓扑分层为 wave、入度 0 批次并行派发。套路全文见 `codument/std/sop/wave-exec.md`。

```text
@delimiter: --
-- #switch ?mode on="该节点 cdt:child-mode（默认 sequential）"
---- #case ?dag when="dag"
------ #sequence ?dagrun
-------- #step ?d1
读 <Schedule><Dag for="该节点"> 的 <Node id><After ref> 边 → 在该层直接下层上构 DAG → 算入度 → 拓扑分层（每层 = 一个 wave，派生不入库）
-------- /?d1
-------- #loop ?waves until="该层全部直接下层 DONE"
---------- #step ?w1
ready = 入度为 0 且未完成的节点（当前 wave 批次）
---------- /?w1
---------- #parallel ?dispatch limit="<Schedule><Parallel max-concurrent>（缺省串行；parallel=false 则逐个）"
对 ready 批次每个节点：叶任务 → #call dispatch-task；非叶 TaskGroup → #call schedule-level（递归）
---------- /?dispatch
---------- #step ?w2
等当前批次全部完成 → 回写 status（见 §6）
---------- /?w2
---------- #if ?w3 cond="<Schedule><Parallel spot-check=true>"
父层独立 spot-check 本批次：目标指标达标、行为基线保持、diff 面符合预期、前序 wave 成果未被污染；抽检失败按 §8 停下询问
---------- /?w3
---------- #step ?w3b
spot-check 通过后，auto 模式创建任务/wave 检查点；manual 模式输出"建议现在提交锁定已验证 wave"，避免后续 wave 污染
---------- /?w3b
---------- #step ?w4
把已完成节点的后继入度减 1；生成 wave 完成小结并追加到 analysis/findings.md（不落 index.md/state.md）
---------- /?w4
-------- /?waves
------ /?dagrun
---- /?dag
---- #default ?seq
------ #loop ?order for="该节点直接下层，按 order 升序"
对每个子节点：叶任务 → #call dispatch-task；非叶 TaskGroup → #call schedule-level（递归）；逐个完成后再下一个
------ /?order
---- /?seq
-- /?mode
```

> **wave 是派生视图**：旧 `<waves>`/`wave=` 不再手维护。某 `dag` 层的依赖经拓扑排序后分层，每层即一个 wave；入度 0 的批次就是当前可并行的 wave。`<Parallel max-concurrent spot-check>`（取代旧 `wave_config`）控制并发与抽检。

---

## 6.0 派发子代理执行叶任务（step 4）+ 状态回写（step 5）

对每个叶 `Task`，编排器 fresh-spawn 一个子代理执行；子代理完成后编排器回写状态。

### 6.1 fresh-spawn 派发（按 agent 类型注入档位）

编排器**只传路径与引用**，子代理自行读取。spawn 时按当前运行的 agent 类型注入模型 / 档位——例如 **codex → 模型 `gpt-5.5`、`effort=high`**；其他 agent 按其高能力档。落盘 skill 时由对应 agent 生成器补充该注入；本协议在此声明意图，确保自包含 skill 不丢"用高能力档跑实现子代理"这一要求。

```text
@delimiter: --
-- #sequence ?dispatch-task
---- #step ?t1
宣布任务：
  "▶️ 任务 <id>: <task name>
   描述: <Description>
   验收标准: <cdt:Acceptance 各 Criterion>"
---- /?t1
---- #step ?t2
把该 Task 的 status 置 ACTIVE（中断恢复点；写回 track.xml）
---- /?t2
---- #call ?tb target="run-hooks(on=task:before, 该 Task)"
---- /?tb
---- #spawn ?run as=fresh-subagent inject="按 agent 类型注入模型/档位，如 codex→gpt-5.5、effort=high"
只传路径与引用（不传内容）：track_dir 绝对路径、task id/name、<Description>、<cdt:Acceptance> 列表、子任务（如有）、input MaterialBundle 路径（取代旧 context_files）、前置产物位置、codument/std/sop/tdd.md 路径、analysis/findings.md 路径。子代理协议见 §6.2。等其返回完成信号
---- /?run
---- #call ?sc target="parent-spot-check(该 Task)"   ← 见 §6.4；未通过不得回写 DONE
---- /?sc
---- #call ?ta target="run-hooks(on=task:after, 该 Task)"   ← 如 task:after cdt:AttractorCheck use="docs"
---- /?ta
---- #call ?wb target="writeback(该 Task)"   ← 见 §6.3
---- /?wb
-- /?dispatch-task
```

### 6.2 子代理执行协议

子代理拿到路径后**自办**：

```text
@delimiter: --
-- #sequence ?subagent
---- #step ?g1
读取 input MaterialBundle、前置产物、behavior_deltas、cdt:Acceptance、tdd.md、analysis/findings.md、decisions.md（如存在）
---- /?g1
---- #step ?g2
按 tdd.md 方法论执行：据 behavior delta 的 suite/case（given/when/then）与 cdt:Acceptance 写失败测试 → 最小实现通过 → 重构；重构/类型/迁移类任务先补 characterization 或等价行为基线，再改实现（非 TDD 适用场景可降级，但行为用例仍是验收依据）
---- /?g2
---- #step ?g3
完成所有子任务；产物落到该 Task/phase 的 output MaterialBundle 目录
---- /?g3
---- #step ?g4
逐条验证 cdt:Acceptance，勾 checked="true"
---- /?g4
---- #step ?g5
回写 track.xml：该 Task status=DONE；若 CommitMode=auto 执行 git commit + Git Notes
---- /?g5
-- /?subagent
```

> 子代理提示词应包含：任务信息（id / name / `<Description>`）、验收标准、子任务（如有）、**上下文文件路径列表（请自行读取）**、前置波次产物路径、`tdd.md` 路径、完成要求（完成子任务 / 验证 AC / 置 DONE / 勾 checked）。还必须包含硬禁令：禁止 `git restore` / `git checkout` / `git stash` 抹改动（只读 git 查询允许，重命名可用 `git mv`）；完成即停，不开启超长会话；不得越界修复非本任务范围；环境命令使用项目指定版本，不随意 `export PATH` 污染后续命令。

### 6.3 状态回写（step 5）

```text
@delimiter: --
-- #sequence ?writeback
---- #step ?wb1
叶 Task：status=DONE，勾 cdt:Acceptance 的 checked="true"
---- /?wb1
---- #step ?wb2
父 TaskGroup 状态反映子节点：全 DONE→DONE，有在跑→ACTIVE
---- /?wb2
---- #if ?wb3 cond="CommitMode=auto"
auto 提交模式：完成即 git commit + Git Notes（格式见 §9），把 commit SHA 记到该 Task 的 cdt:commit 属性
---- /?wb3
---- #step ?wb4
报告进度：
  "✅ 任务 <id> 完成 — 验收标准全部通过 — Commit: <SHA>（auto 模式）"
---- /?wb4
-- /?writeback
```

### 6.4 父层独立 spot-check（子代理后必做）

子代理返回后，编排器必须亲自做最小但真实的复核。**不得**因为子代理说"全绿 / 不是我改的 / 已完成"就回写 DONE。

```text
@delimiter: --
-- #sequence ?parent-spot-check
---- #step ?ps1
重读该 Task 的 cdt:Acceptance、相关 behavior case、子代理报告与 git diff；确认改动范围是否符合任务边界
---- /?ps1
---- #step ?ps2
运行目标指标命令与行为基线命令（项目已有测试 / lint / typecheck / smoke；若命令缺失，记录未验证原因）
---- /?ps2
---- #step ?ps3
diff 审查：确认无无关运行时改动；对声称行为不变的任务，逐项确认删除/替换语句语义等价
---- /?ps3
---- #step ?ps4
若子代理声称"非我责任"或"先前已有"，用客观判据复核：错误性质、HEAD 对照、独立复现实验、文件修改时间或 diff 归因
---- /?ps4
---- #switch ?ps5 on="spot-check 结论"
------ #case ?pass when="通过"
追加 findings：命令结果、diff 结论、覆盖范围、未验证项；继续 task:after hook 与 writeback
------ /?pass
------ #case ?fail when="失败或证据不足"
保持 Task status=ACTIVE 或标 REFUSED/BLOCKED，记录 findings，按 §8 询问重试 / 新子代理修复 / 中止；不得回写 DONE
------ /?fail
---- /?ps5
-- /?parent-spot-check
```

---

## 7.0 生命周期 hook（含阶段门控 · step 2/6）

门控**只在配置了的地方发生**。phase / task / track 的 `<Hooks>` 里挂了 `cdt:HumanConfirm`（人工确认）/ `cdt:GapLoop`（转 gap-loop skill 做 fresh 目标对比）/ `cdt:AttractorCheck`（方向审查，fresh-subagent）时才触发；没挂就**静默继续，不为提问而提问**。`<Hook on>` 取值：`track:before|after`、`phase:before|after`、`task:before|after`。执行顺序（phase 与 task 同配时）：phase-before → task-before → task-after → phase-after。

```text
@delimiter: --
-- #sequence ?run-hooks
---- #if ?h0 cond="该 scope 的 <Hooks> 未挂任何 cdt: check"
------ #return ?skip value="静默继续（不提问、不暂停）"
------ /?skip
---- /?h0
---- #loop ?each for="该 scope <Hooks> 中 on 匹配当前生命周期点的每个 Hook"
------ #switch ?type on="typed-child 类型"
-------- #case ?confirm when="cdt:HumanConfirm"
人工确认门控：先跑自动检查（项目测试套件 / 覆盖率≥80% 或 workflow 阈值 / lint / 逐条 cdt:Gate Criterion），生成门控验证报告（任务完成情况 / 测试 / 覆盖率 / lint / Gate 结果表），再用 ask-single-question-closed yield 给用户审阅。未过→修复后重新确认直到通过；该 Hook 标 DONE 才继续
-------- /?confirm
-------- #case ?gaploop when="cdt:GapLoop"
转 gap-loop 双角色协议：当前实现 agent 不在原上下文继续做 gap 校验/修正，只把控制权交回父层编排者。详见 §7.1
-------- /?gaploop
-------- #case ?attractor when="cdt:AttractorCheck"
按 use="<profile>" 派 fresh-subagent 对照 attractor-profiles.xml 的 profile 审查方向 → 裁决 PASS|GAP|BLOCKED；GAP 修复后重跑该 check 直到 PASS/BLOCKED（见 sop/validation.md）
-------- /?attractor
------ /?type
---- /?each
-- /?run-hooks
```

### 7.1 phase:after = `cdt:GapLoop` 时的双角色交回（关键）

当某 phase 的 `phase:after` hook 是 `<cdt:GapLoop>`：实现编排器**不在原上下文里继续做 gap 校验或修正**，只负责把控制权交回**父层编排者**。父层据 fresh 子代理返回的结构化 XML 续轮——规则与 `gap-loop.md` 完全一致：

```text
@delimiter: --
-- #loop ?rounds max="cdt:GapLoop 的 max-rounds"
---- #step ?gp1
父层启动新一轮前，先把当前轮次写回 track.xml <Metadata> 的 gap-round
---- /?gp1
---- #spawn ?gp2 as=fresh-subagent inject="按 agent 类型注入模型/档位，如 codex→gpt-5.5、effort=high"
fresh-spawn 一个新 gap-loop 子代理（或等价 fresh child context），让其执行当前 scope 的 gap-loop 子流程；等结构化 XML
---- /?gp2
---- #switch ?gp3 on="子代理返回 status"
------ #case ?nogap when="NO_GAP"
-------- #if ?firstround cond="首轮 + 无历史报告 + 从未跑过 gap-loop"
父层仍必须再 fresh-spawn 一轮验证（首轮怀疑），不得收口
---------- #continue ?c1
---------- /?c1
-------- /?firstround
-------- #else ?confirmed
验证轮也通过 → 把该 phase 的 cdt:GapLoop 标 DONE
---------- #return ?ok value=收口
---------- /?ok
-------- /?confirmed
------ /?nogap
------ #case ?fix when="FIX_APPLIED"
当前 cdt:GapLoop 保持未完成；父层必须再 fresh-spawn 复检，不得停在这一轮
-------- #continue ?c2
-------- /?c2
------ /?fix
------ #case ?blocked when="BLOCKED"
把该 cdt:GapLoop 标 BLOCKED，停止并请求用户输入
-------- #exit ?x1
-------- /?x1
------ /?blocked
---- /?gp3
-- /?rounds
-- #step ?exhausted
达 max-rounds 仍未 NO_GAP 收口 → 按 on-exhausted（block = 标 BLOCKED 等用户）
-- /?exhausted
```

> 完整 gap-loop 协议（角色判定、模式补齐、首轮怀疑、禁止事项、输出 XML 契约）见 `codument/std/operations/gap-loop.md`；裁决词汇见 `codument/std/sop/validation.md`。

---

## 8.0 失败处理（step 7）

```text
@delimiter: --
-- #switch ?fail on="失败类型"
---- #case ?task when="子代理任务执行失败"
------ #sequence ?ftask
-------- #step ?ft1
把该 Task 标 status=REFUSED（或 BLOCKED 语义）；立即停止该分支
-------- /?ft1
-------- #step ?ft2
报告详细失败信息（失败原因 / 失败步骤 / 相关日志），用 ask-single-question-closed 询问：
  "A. 重试此任务  B. 手动修复后继续  C. 标记 BLOCKED 并跳过  D. 中止实现"
-------- /?ft2
------ /?ftask
---- /?task
---- #case ?gate when="门控失败（测试/覆盖率/lint/Gate Criterion 未过）"
------ #sequence ?fgate
-------- #step ?fg1
不创建检查点；报告失败项（如"测试覆盖率 72% (<80%)"）
-------- /?fg1
-------- #step ?fg2
用 ask-single-question-closed 询问：
  "A. 添加测试提高覆盖率  B. 豁免此检查（需说明原因）  C. 中止实现"
-------- /?fg2
------ /?fgate
---- /?gate
---- #case ?dagblock when="DAG 阻塞：某 wave 全部 task 失败，后继依赖无法执行"
------ #step ?fd1
报告阻塞链（哪个 wave 失败、阻塞了哪些后继）并用 ask-single-question-closed 询问处理方式（重试 / 跳过 / 中止）
------ /?fd1
---- /?dagblock
-- /?fail
```

---

## 9.0 Commit 与 Git Notes（CommitMode=auto）

`auto` 模式下，**逐任务** commit + Git Notes，**逐 phase** 检查点 commit + Git Notes。`manual` 模式不自动提交。

**任务完成 commit**：

```bash
git add .
git commit -m "feat(<track_id>): complete task <id> - <任务名称>"
git notes add -m "Task: <id> - <任务名称>
Track: <track_id>
Phase: <Pn> - <阶段名称>
Priority: <P0|P1|…>

Changes:
- <变更描述>

Files Modified:
- <修改文件列表>

Acceptance Criteria:
- [x] <id>-AC1: <标准>"
```

**阶段检查点 commit**（门控通过后）：

```bash
git add .
git commit -m "checkpoint(<track_id>): Phase <Pn> complete"
git notes add -m "Checkpoint: Phase <Pn> Complete
Track: <track_id>
Phase: <Pn> - <阶段名称>

Gate Criteria: ALL PASSED
Test Coverage: <pct>%
Tasks Completed: <done>/<total>

Verification Report:
<报告摘要>"
```

commit SHA 记到对应 `<Task>`/`<TaskGroup>` 节点（如 `cdt:commit` 属性）。

---

## 10.0 完成 track（step 8）

所有 phase 完成且门控通过后收尾：

```text
@delimiter: --
-- #sequence ?finalize
---- #call ?th target="run-hooks(on=track:after, <Track>)"
track 终态 hook（如 <Track><Hooks> 的 cdt:GapLoop）执行完才算实现收尾；走 §7.1 双角色流
---- /?th
---- #step ?f1
执行最终验证：跑 proposal/track 约定的验证项（旧 <validations>），逐项更新 PASSED/FAILED
---- /?f1
---- #step ?f2
更新 track.xml：<Metadata><Status>=completed、<UpdatedAt>=当前时间
---- /?f2
---- #step ?f3
宣布完成：
  "🎉 Track '<track_id>' 实现完成！
   统计 — 阶段 <n>/<n> · 任务 <n>/<n> · 验证全部通过
   下一步：请使用 codument-archive skill 归档此 track: <track_id>"
---- /?f3
-- /?finalize
```

> **summary 不入库**：阶段 / 任务 / wave 计数由工具遍历 TaskSpace 派生（旧 `<summary>` 已删），编排器**不要**手维护统计文件。

---

## 11.0 完成后：同步项目文档与清理（轻量、显式 hook 驱动）

track 达到 completed 后，按**显式 hook**做文档同步——**不要**只因 `docs` profile 启用就生成隐式同步步骤。

- **modeling（条件·modeling 启用）**：实现过程中若领域结构（对象/状态机/模块依赖/事实源/组件 IO）发生变化，把目标态节点写进 track 的 `modeling_deltas/<plane>/<context>.xnl`（不直接改 `codument/modeling/`——那由归档 §5.5 的 3-way 合并落盘）。**写完 / 编辑 modeling_deltas 后自检**：运行 `codument modeling validate --deltas <track_id>`；若报 error，按报告（file/line/layer/reason）修正 modeling_deltas 再继续，直到 0 error。该步骤与本条同样 gated——modeling 未启用（无 `config/modeling.xml` 或 `enabled=false`）则跳过。规范见 `std/spec/modeling-{registry,delta,node-schema}.md`（其 §9 语言约定：描述/注释/pseudo/mermaid 标签用中文，interface/字段/kind/枚举/#id 等标识符保持英文）。
- **artifact / knowledge sync**：仅当 `codument/config/operation-hooks.xml` 为当前 operation point 显式配了 `<artifact-sync artifact="…"/>` 且该 artifact 存在于 `codument/config/artifacts.xml` 时才执行；同步时读 artifact 的 `<uses>`/`<targets>`/`<policy>` 与其 `attractor-profile` resource 指定的吸引子。详见 `codument/std/sop/artifact-sync.md`。
- **product/project 类 attractor 更新**：分析 `behavior_deltas/**/*.xml`，若已完成功能显著影响产品描述或架构决策，生成提议 diff 并用 `ask-single-question-closed` 请求确认，**仅在明确确认后**编辑 `codument/attractors/` 下相关文件。
- **track 清理**：交由 `codument-archive` skill（归档 / 删除 / 保留三选一），本 skill 不直接删 track 目录。

---

## 附录 A：引用

- `codument/std/spec/track-xml-spec.md` — TaskSpace / Schedule / Hooks / Ports 结构（status 枚举、`cdt:child-mode`、`<Dag for><Node><After>`、`cdt:` typed check）。
- `codument/std/sop/tdd.md` — 测试先行执行方法论。
- `codument/std/sop/wave-exec.md` — DAG 层的派生 wave 调度循环。
- `codument/std/sop/validation.md` — `cdt:` hook 执行协议与裁决词汇。
- `codument/std/operations/gap-loop.md` — `cdt:GapLoop` 双角色完整协议与输出 XML 契约。
- `codument/std/sop/questioning.md` — `ask-*` 提问协议。
- `codument/std/sop/artifact-sync.md` — 显式 hook 驱动的 artifact / knowledge 同步。
