# skill: codument-impl-track（执行任务）

**描述：** 按 `track.xnl` 的 TaskSpace + Schedule 推进任务，统一验证并回写 XNL 状态，在生命周期点运行 Hook；auto 模式逐任务 commit + Git Notes。

> 程序化流程使用 ` ```text ` + `@delimiter: --` 的流程标记块；当前资源 authoring 只使用无前缀 XNL 与 snake_case 属性。遇到 legacy authority 时先运行 `codument upgrade-resource <path>`，不在执行 operation 中重述迁移映射。
>
> wave 是 `{ child_mode = "dag" }` 层依赖的拓扑分层派生视图，由 executor 从 `<Schedule>` 计算，不是独立持久化资源。

---

## 0.0 角色与总纲

你是 Codument 规范驱动开发框架的 **track executor**。职责是按 `track.xnl` 三轴（TaskSpace 结构 / Schedule 调度 / Hooks 行为）推进实现，并对任务完成证据负责。核心原则：

- **普通任务自主执行**：每个叶任务由当前 AI 根据任务边界、上下文连续性、文件重叠、真实并行收益与运行时能力选择 `local` 或 `delegated`；leaf/DAG 本身不意味着必须 fresh-spawn。
- **优先保持连续性**：任务较小、顺序依赖紧密、修改同一批文件、当前上下文已经充分，或协作运行时不可用时，直接 local 执行。任务边界独立、可并行、上下文很大或用户明确要求委派时，可 delegated。
- **状态写入 authority**：track executor 拥有状态转换决策，必须通过 `codument track transition` / `codument track task transition` 写回；delegated worker 只返回范围内产物和证据。
- **完成以证据为准**：local 与 delegated 都必须通过 acceptance、目标命令、行为基线和 diff 审查；delegated worker 的自述不是结论。
- **独立性显式化**：`GapLoop`、`AttractorCheck`、`codument-verify` 和用户显式要求的独立审查继续使用 fresh context；普通实现策略不得削弱这些协议。
- **委派只传路径与引用**：选择 delegated 时传 track_dir、task id、`<Description>`、`Acceptance`、MaterialBundle 与前置产物路径，让 worker 自行读取所需文件。
- 波次间知识通过 wave 完成小结、`analysis/findings.md` 与 `track.xnl` status 传递。
- 长程事实写入 `analysis/findings.md`：phase/wave 结论、实证指标、环境约束、失败归因与机制漏洞都落盘，供续跑和后续 track 复用。

**`track.xnl` 是执行状态真源**：任务/阶段状态在各节点 `{ status = "..." }`，Track 状态在根 `{ status = "..." }`；续跑点、进度与完成统计全部从 XNL 派生。

---

## 1.0 前置检查与 track 选择

### 1.1 设置检查

验证 Codument 环境正确初始化。检查以下入口存在：

- `codument/attractors/`（项目级吸引子目录）
- `codument/std/`（标准提示词 / spec / sop 已落盘）

任一**必需**入口缺失则立即停止，宣布：「Codument 未设置。请先运行 `codument init` 初始化工作区。」**不要**继续 track 选择。

### 1.2 交互式问答（克制提问）

引用 `codument/std/protocols/questioning.md` 的 `ask-*` 协议。**重要**：若环境支持提问 ToolCall，**仅在"必须提问"的场景**使用；**禁止**为测试运行环境能力而发占位问题，也**禁止**仅因为环境支持 ToolCall 就在每个 phase / wave 边界额外发问。

**必须提问的场景仅包括**：

- 需要用户选择（track 选择模糊、phase 选择）。
- 节点配了 `HumanConfirm`（`when` 含 `before/after`）需等待人工确认。
- 任务执行失败、executor verification 失败、DAG 阻塞、门控失败等**失败处理分支**（能在任务边界内安全修复则继续；需要用户取舍时询问重试 / 跳过 / 中止）。
- step 0 续跑检测发现 `ACTIVE` 任务（继续 / 重做 / 跳过）。

### 1.3 选择 track

```text
@delimiter: --
-- #sequence ?select
---- #step ?s1
运行 `codument list --json` 取得 active Track 与状态；若由 codument-impl-mission 调用且存在刚创建的候选，先按 §1.4 激活再重新运行 list。无有效 authority 时向 mission 返回缺失事实并由 mission reconcile，独立调用时才向用户报告
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
取第一个根 `status` 非 completed/cancelled 的 track；若全部完成，mission 子流程必须返回完成事实并让 mission 继续 observe/reconcile，独立调用才结束
------ /?u1
---- /?s3
-- /?select
```

未选出任何 track 则通知用户并等待指示（`ask-single-question-free`）；mission 语境下则向 MissionApplier 返回“无可激活 track”+ 原因，由 mission 决定重规划 / 阻塞，不默认提问。

### 1.4 mission 语境候选激活
当本 `codument-impl-track` 由 `codument-impl-mission` 调用且 ready operation 是 candidate TrackLink 时，MissionApplier 先运行 `codument track transition <track-id> in_progress` 激活 pending Track，再运行 `codument mission bind-track <mission-id> <task-id> <track-id>` 写入绑定与 report。命令成功后立即进入实现；只有显式确认 gate 才停在激活点。

---

## 2.0 加载 track 上下文（step 1）

选定 track 后：

1. **宣布操作**：宣布正在实现哪个 track。
2. **更新 track 状态**：开始工作前运行 `codument track transition <track-id> in_progress`；已在该状态时命令保持幂等。
3. **读取必需文件**（路径以 `codument/tracks/active/<track-id>/` 为根）：
   - `track.xnl`（TaskSpace / Schedule / Hooks / Ports 三轴 + 元信息）。
   - `proposal.md`、`design.md`（如存在）。
   - `behavior_deltas/**/*.xnl`（行为增量）。
   - `analysis/findings.md`、`analysis/knowledge.md`（如存在；长程事实锚，续跑时优先读）。
   - 根 `decisions.xnl` 与递归 `decisions/**/*.xnl`（如存在；共同包含用户拍板与执行期决策）。
   - 方法论：`codument/std/methods/tdd.md`。
   - 调度套路：`codument/std/methods/dag-execution.md`。
4. **识别提交模式**：从 Track 根 `commit_mode` 取 `auto|manual`。
5. **错误处理**：任一必需文件读不到 → 停止并通知用户。

---

## 3.0 续跑检测 / 中断恢复（step 0）

`track.xnl` 节点 `{ status = "..." }` 是恢复点真源。若存在 ACTIVE 任务，`question_severity = "auto"` 或 mission 子流程默认原地续跑且不提问；独立交互模式才询问继续、重做或跳过。

若上次会话已有 local/delegated 实现结果但尚未完成 executor verification（例如 `analysis/findings.md` 或对话记录显示"待复核"，或任务尚未从 ACTIVE 回写 DONE），**本轮第一件事就是客观复核**，通过后再回写状态；不得因实现已存在就直接继续。

```text
@delimiter: --
-- #sequence ?resume
---- #step ?r1
解析 track.xnl，找 status=ACTIVE 的任务（上次中断点）与上一个 DONE 的任务
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
运行 `codument track task transition <track-id> <task-id> NOT_STARTED`，从头重做
---------- /?B
---------- #case ?C when=跳过
运行 `codument track task transition <track-id> <task-id> ABANDONED`，起点移到下一个未完成任务
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

## 4.0 主执行流程：遍历 phase + 层内调度 + 执行

宣布将按 `tdd.md` 方法论执行 `track.xnl` 中的任务。整个执行是一段**结构递归的程序**：逐 phase（第一层 TaskGroup，按 `order`）；每 phase 跑 `phase:before` hook → 调度执行其直接下层 → `phase:after` hook → 校验 `Gate`。层内调度按该层 `child_mode`：`dag` 走拓扑分层 wave 并行，否则按 `order` 顺序。非叶任务（TaskGroup）递归同理。

```text
@delimiter: --
-- #loop ?phases for="track.xnl TaskSpace 第一层每个 TaskGroup（=phase），按 order 升序，从续跑起点开始"
---- #call ?hb target="run-hooks(on=phase:before, 该 phase)"
---- /?hb
---- #call ?sched target="schedule-level(该 phase 节点)"   ← 见 §5 层内调度
---- /?sched
---- #call ?ha target="run-hooks(on=phase:after, 该 phase)"   ← 见 §7 生命周期 hook（含门控）
---- /?ha
---- #step ?gate
为该 phase 的 <Gate> 选择一条可重复执行的门控命令（多个检查应收敛进项目 verify script，或显式使用 `sh -lc 'a && b'`），运行 `codument track task complete <track-id> <phase-id> -- <gate-command>`；CLI 会在工作区内容未变化时复用相同命令的成功回执，只在直接下层终态且验证有效时勾选 Gate 并写入 DONE。未过按 §8 门控失败处理
---- /?gate
---- #step ?ckpt
若 CommitMode=auto 且门控通过：创建阶段检查点 commit + Git Notes（见 §9）；把检查点 commit SHA 记到该 phase 节点
---- /?ckpt
---- #step ?findings
把 phase 门控结果、spot-check 证据、关键指标、失败/修复事实追加到 tracks/active/<id>/analysis/findings.md；稳定结论按 knowledge-tiers.md 判断是否需晋升
---- /?findings
-- /?phases
-- #call ?done target="finalize-track()"   ← 见 §10 完成 track
-- /?done
```

---

## 5.0 层内调度（顺序 or DAG · step 3）

对某个非叶节点（phase 或嵌套 TaskGroup）调度其**直接下层**：默认按 `order` 依次执行；只有该节点写了 `{ child_mode = "dag" }` 时，才用 `<Schedule>/<Dag { for = "该节点" }>` 构 DAG、拓扑分层为 wave、入度 0 批次并行派发。套路全文见 `codument/std/methods/dag-execution.md`。

```text
@delimiter: --
-- #switch ?mode on="该节点 child_mode（默认 sequential）"
---- #case ?dag when="dag"
------ #sequence ?dagrun
-------- #step ?d1
读 `<Schedule>/<Dag { for = "该节点" }>` 的 `<Node #id>/<After { ref = "..." }>` 边 → 在该层直接下层上构 DAG → 算入度 → 拓扑分层（每层 = 一个 wave，派生不入库）
-------- /?d1
-------- #loop ?waves until="该层全部直接下层 DONE"
---------- #step ?w1
ready = 入度为 0 且未完成的节点（当前 wave 批次）
---------- /?w1
---------- #parallel ?dispatch limit="<Schedule { max_concurrent = N }>（缺省时保守选择；无法安全并行则逐个）"
对 ready 批次每个节点：叶任务 → #call execute-task；非叶 TaskGroup → #call schedule-level（递归）
---------- /?dispatch
---------- #step ?w2
等当前批次全部完成 → 回写 status（见 §6）
---------- /?w2
---------- #if ?w3 cond="<Schedule { spot_check = true }>"
track executor 客观复核本批次：目标指标达标、行为基线保持、diff 面符合预期、前序 wave 成果未被污染；委派自述不得代替复核，失败按 §8 处理
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
对每个子节点：叶任务 → #call execute-task；非叶 TaskGroup → #call schedule-level（递归）；逐个完成后再下一个
------ /?order
---- /?seq
-- /?mode
```

> **wave 是派生视图**：某 `dag` 层的依赖经拓扑排序后分层，每层即一个 wave；入度 0 的批次就是当前可并行的 wave。`<Schedule { max_concurrent = N spot_check = true|false }>` 控制并发与抽检。

---

## 6.0 执行叶任务（step 4）+ 状态回写（step 5）

对每个叶 `Task` 调用 `execute-task`。普通任务的执行者选择是运行期判断，不写入 TaskSpace/Schedule，也不改变 acceptance。

### 6.1 自主选择 local / delegated

```text
@delimiter: --
-- #sequence ?execute-task
---- #step ?t1
宣布任务 id/name、Description 与 Acceptance；运行 `codument track task transition <track-id> <task-id> ACTIVE` 写入恢复点
---- /?t1
---- #call ?tb target="run-hooks(on=task:before, 该 Task)"
---- /?tb
---- #step ?strategy
当前 AI 选择 execution strategy：
  local：任务较小或顺序紧密、会修改同一批文件、当前上下文充分、并行收益不足、协作运行时不可用
  delegated：任务边界独立且可并行、上下文很大、适合独立调研/复现，或用户明确要求委派
选择只需在进度/findings 中简述理由，不新增持久化 execution-mode 字段
---- /?strategy
---- #switch ?run on="execution strategy"
------ #case ?local when="local"
当前 AI 按 §6.2 执行任务
------ /?local
------ #case ?delegated when="delegated"
按 §6.2 派发 bounded worker；只传路径/引用并等待其返回产物与证据
------ /?delegated
---- /?run
---- #call ?verify target="executor-verification(该 Task, strategy)"   ← §6.4；未通过不得回写 DONE
---- /?verify
---- #call ?ta target="run-hooks(on=task:after, 该 Task)"
---- /?ta
---- #call ?wb target="writeback(该 Task)"
---- /?wb
-- /?execute-task
```

### 6.2 任务执行契约

local 与 delegated worker 都应：

1. 读取 input MaterialBundle、前置产物、behavior_deltas、Acceptance、tdd.md、analysis/findings.md、根 `decisions.xnl` 与递归 `decisions/**/*.xnl`。
2. 按 `tdd.md` 执行；重构/类型/迁移任务先建立 characterization 或等价行为基线。
3. 只修改任务边界内源码、测试与 output MaterialBundle 产物，逐条收集 acceptance 验证证据。
4. 禁止 `git restore` / `git checkout` / `git stash` 抹改动；不得越界修复，不污染环境配置。

delegated worker 还必须遵守：

- 只接收路径与引用，自行读取文件；完成即返回产物与证据（stop 仅限子流程边界，调用方决定是否继续）。
- **不得修改** `track.xnl`、acceptance checkmarks、`analysis/findings.md`，不得创建 task/phase commit。
- 返回改动摘要、实际命令结果、未验证项和阻塞，不把自述当完成裁决。

如果当前 `codument-impl-track` 是由 `codument-impl-mission` 为某个 mission 子 track 调用的，local/delegated worker 或本 track 子流程的“完成即停”只约束局部流程。track 子流程返回后，控制权必须回到 mission 父层 `MissionApplier`；mission 父层继续读取 track 结果、更新 `mission.xnl` / report、执行 operation 完成判定并推进后续 ready operation，不得把 track 完成当作 mission invocation 的默认停止点。

### 6.3 状态回写（step 5）

```text
@delimiter: --
-- #sequence ?writeback
---- #step ?wb1
读取 §6.4 `codument track task complete` 的成功结果；DONE、Acceptance checked 与更新时间已由 CLI 原子写入，不再重复 transition
---- /?wb1
---- #step ?wb2
运行 `codument track ready <track-id> --json` 观察下一节点。无 Gate 的父 TaskGroup 由 CLI 在子节点完成后自动汇总；有 Gate 的 TaskGroup 由 §4 的 `task complete <phase-id> -- <gate-command>` 收口
---- /?wb2
---- #if ?wb3 cond="CommitMode=auto"
auto 提交模式：完成即 git commit + Git Notes（格式见 §9），把 commit SHA 记到该 Task 的 commit 属性
---- /?wb3
---- #step ?wb4
报告进度：
  "✅ 任务 <id> 完成 — 验收标准全部通过 — Commit: <SHA>（auto 模式）"
---- /?wb4
-- /?writeback
```

### 6.4 Executor completion verification（所有策略必做）

track executor 必须做最小但真实的复核。local 执行不需要为了形式再启动另一个代理；delegated 执行不得因为 worker 说"全绿 / 不是我改的 / 已完成"就回写 DONE。真正需要独立上下文时应由显式 GapLoop、AttractorCheck、`codument-verify` 或用户要求触发。

```text
@delimiter: --
-- #sequence ?executor-verification
---- #step ?ps1
重读该 Task 的 Acceptance、相关 behavior case、执行证据与 git diff；确认改动范围是否符合任务边界
---- /?ps1
---- #step ?ps2
选择能覆盖本 Task Acceptance 的可重复验证入口（优先项目已有 verify script，其次测试 / lint / typecheck / smoke），保存为 `<verification-command>`；命令缺失时判定证据不足，不得写 DONE
---- /?ps2
---- #step ?ps3
diff 审查：确认无无关运行时改动；对声称行为不变的任务，逐项确认删除/替换语句语义等价
---- /?ps3
---- #step ?ps4
若 delegated worker 声称"非我责任"或"先前已有"，用客观判据复核：错误性质、HEAD 对照、独立复现实验、文件修改时间或 diff 归因
---- /?ps4
---- #switch ?ps5 on="spot-check 结论"
------ #case ?pass when="通过"
运行 `codument track task complete <track-id> <task-id> -- <verification-command>`；CLI 执行或复用内容指纹仍有效的成功回执，随后才原子写入 DONE/Acceptance。不得用 `;` 把失败检查与完成写入分离。成功后追加 findings：receipt id/reused、命令结果、diff 结论、覆盖范围、未验证项；继续 task:after hook 与 writeback
------ /?pass
------ #case ?fail when="失败或证据不足"
继续修复时保持 ACTIVE；确认该分支无法继续时运行 `codument track task transition <track-id> <task-id> REFUSED` 并记录 blocker/findings。Track task 没有 BLOCKED 状态；不得回写 DONE
------ /?fail
---- /?ps5
-- /?executor-verification
```

---

## 7.0 生命周期 hook（含阶段门控 · step 2/6）

门控**只在配置了的地方发生**。phase / task / track 的 `<Hooks>` 里挂了 `HumanConfirm`（人工确认）/ `GapLoop`（转 gap-loop skill 做 fresh 目标对比）/ `AttractorCheck`（方向审查，fresh-subagent）时才触发；没挂就**静默继续，不为提问而提问**。`<Hook { on = "..." }>` 取值：`track:before|after`、`phase:before|after`、`task:before|after`。执行顺序（phase 与 task 同配时）：phase-before → task-before → task-after → phase-after。

```text
@delimiter: --
-- #sequence ?run-hooks
---- #if ?h0 cond="该 scope 的 <Hooks> 未挂任何  check"
------ #return ?skip value="静默继续（不提问、不暂停）"
------ /?skip
---- /?h0
---- #loop ?each for="该 scope <Hooks> 中 on 匹配当前生命周期点的每个 Hook"
------ #switch ?type on="typed-child 类型"
-------- #case ?confirm when="HumanConfirm"
人工确认门控：先跑自动检查（项目测试套件 / 覆盖率≥80% 或 workflow 阈值 / lint / 逐条 Gate Criterion），生成门控验证报告（任务完成情况 / 测试 / 覆盖率 / lint / Gate 结果表），再用 ask-single-question-closed yield 给用户审阅。未过→修复后重新确认，确认通过才继续
-------- /?confirm
-------- #case ?gaploop when="GapLoop"
转 gap-loop 双角色协议：当前实现 agent 不在原上下文继续做 gap 校验/修正，只把控制权交回父层编排者。详见 §7.1
-------- /?gaploop
-------- #case ?attractor when="AttractorCheck"
按 `{ use = "<profile>" }` 派 fresh-subagent 对照 attractor-profiles.xnl 的 profile 审查方向 → 裁决 PASS|GAP|BLOCKED；GAP 修复后重跑该 check 直到 PASS/BLOCKED（见 `std/protocols/validation.md`）
-------- /?attractor
------ /?type
---- /?each
-- /?run-hooks
```

### 7.1 phase:after = `GapLoop` 时的双角色交回（关键）

当某 phase 的 `phase:after` hook 是 `<GapLoop>`，实现编排器把控制权交给父层编排者。父层按 `gap-loop.md` 启动 fresh 子代理，并依据简洁 verdict 与真实报告续轮。

如果本 track 是 mission 子 track，这里的“父层编排者”首先是 track 实现编排器；track gap-loop 收口后再把结果交回 mission 父层。`NO_GAP` / `FIX_APPLIED` / `BLOCKED` 的含义不得直接外推为 mission 主循环返回：只有 `BLOCKED` 且无法由 mission 自动重规划或改走其他 ready 分支时，mission 才按真实阻塞返回。

每轮开始前运行 `codument track gap-round <track-id> <n>`。`FIX_APPLIED` 进入 fresh 复检，`NO_GAP` 按 `verify_round` 收口或补一轮轻量确认，`BLOCKED` 交还父层处理。Mission 子 Track 的结果先返回 MissionApplier，由 mission 决定重规划、换分支或真实阻塞。

> 完整 gap-loop 协议见 `codument/std/operations/gap-loop.md`；裁决词汇见 `codument/std/protocols/validation.md`。

---

## 8.0 失败处理（step 7）

> **mission 子 track 语境**：若本 `codument-impl-track` 由 `codument-impl-mission` 调用，任务失败 / 门控失败 / DAG 阻塞先尝试任务边界内自动修复；无法自动修复时，把失败类型、原因与建议写入 `analysis/findings.md`，向 MissionApplier 返回结构化 BLOCKED 结果，由 mission 决定重规划 / 换分支 / 真实阻塞，**不默认 ask-single-question-closed**。非 mission（用户直接对话）场景保留下方提问分支。

```text
@delimiter: --
-- #switch ?fail on="失败类型"
---- #case ?task when="local/delegated 任务执行或完成验证失败"
------ #sequence ?ftask
-------- #step ?ft1
运行 `codument track task transition <track-id> <task-id> REFUSED`，在 findings 记录 blocker；立即停止该分支
-------- /?ft1
-------- #step ?ft2
报告详细失败信息（失败原因 / 失败步骤 / 相关日志），用 ask-single-question-closed 询问：
  "A. 在任务边界内继续修复/重试  B. 切换 local/delegated 策略  C. 记录阻塞并以 REFUSED 跳过  D. 中止实现"
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

commit SHA 记到对应 `<Task>`/`<TaskGroup>` 节点（如 `commit` 属性）。

---

## 10.0 完成 track（step 8）

所有 phase 完成且门控通过后收尾：

```text
@delimiter: --
-- #sequence ?finalize
---- #call ?th target="run-hooks(on=track:after, <Track>)"
track 终态 hook（如 <Track><Hooks> 的 GapLoop）执行完才算实现收尾；走 §7.1 双角色流
---- /?th
---- #step ?f1
执行最终验证：对 proposal/track 约定的每条唯一命令运行 `codument track verify <track-id> -- <verification-command>`；CLI 可复用当前工作区指纹下的 task/phase 成功回执，逐项记录 receipt id/reused 与 PASSED/FAILED 证据
---- /?f1
---- #step ?f2
运行 `codument track transition <track-id> completed`；CLI completion gate 会拒绝仍有未完成任务的 Track
---- /?f2
---- #step ?f3
宣布完成：
  "🎉 Track '<track_id>' 实现完成！
   统计 — 阶段 <n>/<n> · 任务 <n>/<n> · 验证全部通过
   下一步：请使用 codument-archive-track skill 归档此 track: <track_id>"
---- /?f3
-- /?finalize
```

> 阶段 / 任务 / wave 计数由工具遍历 TaskSpace 派生，编排器不手维护统计文件。

---

## 11.0 完成后：同步项目文档与清理（轻量、显式 hook 驱动）

track 达到 completed 后，按**显式 hook**做文档同步——**不要**只因 `docs` profile 启用就生成隐式同步步骤。

- **modeling（默认启用，按结构变化触发）**：缺失 `config/modeling.xnl` 时按 enabled 处理；显式 `enabled=false` 时跳过。只有实现改变对象、状态机、policy、模块边界、事实源、actor/component IO 等结构知识时，才把目标态节点写进 track 的 `modeling_deltas/<plane>/<context>.xnl`；普通 track 无结构变化时不强制生成 delta，也不创建空 registry。不要直接改 `codument/modeling/`——归档会做真实 base/ours/theirs 3-way merge，并把结果纳入 behavior/modeling/engineering/decision 的统一 staging + rollback-capable commit。**写完 / 编辑 modeling_deltas 后自检**：运行 `codument modeling validate --deltas <track_id>`；若报 error，按报告（file/line/layer/reason）修正 modeling_deltas 再继续，直到 0 error；missing/empty registry 只报 warning，非空 registry 仍要求 domain plane。规范见 `std/spec/modeling-{registry,delta,node-schema}.md`（其 §9 语言约定：描述/注释/pseudo/mermaid 标签用中文，interface/字段/kind/枚举/#id 等标识符保持英文）。
- **engineering（条件·engineering 启用）**：实现过程中若产生长期工程知识（howto/rule/reference/troubleshooting/runbook/code-map/example/overview），把目标态节点写进 track 的 `engineering_deltas/<plane>/<category>/<topic>.xnl`（不直接改 `codument/engineering/`——由归档的 3-way 合并落盘）。**写完 / 编辑 engineering_deltas 后自检**：运行 `codument engineering validate --deltas <track_id>`；若报 error，按报告修正再继续，直到 0 error。该步骤 gated on `config/engineering.xnl`。
- **artifact / knowledge sync**：仅当 `codument/config/operation-hooks.xnl` 为当前 operation point 显式配了 `<ArtifactSync { use = "..." }>` 时才执行；同步时读 track 的 `output` MaterialBundle 与 hook 引用的 artifact/profile 规则。详见 `codument/std/operations/artifact-sync.md`。
- **product/project 类 attractor 更新**：分析 `behavior_deltas/**/*.xnl`，若已完成功能显著影响产品描述或架构决策，生成提议 diff 并用 `ask-single-question-closed` 请求确认，**仅在明确确认后**编辑 `codument/attractors/` 下相关文件。
- **track 清理**：交由 `codument-archive-track` skill（归档 / 删除 / 保留三选一），本 skill 不直接删 track 目录。

---

## 附录 A：引用

- `codument/std/spec/track-xnl-spec.md` — TaskSpace / Schedule / Hooks / Ports 结构（status 枚举、`child_mode`、`Dag/Node/After`、typed check）。
- `codument/std/methods/tdd.md` — 测试先行执行方法论。
- `codument/std/methods/dag-execution.md` — DAG 层的派生 wave 调度循环。
- `codument/std/protocols/validation.md` — `` hook 执行协议与裁决词汇。
- `codument/std/operations/gap-loop.md` — `GapLoop` 双角色、轮次与简洁 verdict 协议。
- `codument/std/protocols/questioning.md` — `ask-*` 提问协议。
- `codument/std/operations/artifact-sync.md` — 显式 hook 驱动的 artifact / knowledge 同步。
