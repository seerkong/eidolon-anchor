# Actor / Lane 对齐与 TUI 恢复记录（2026-03-16）

## 背景

本记录用于承接 2026-03-16 这一轮讨论，主要覆盖两类事项：

1. 当前 backend 中 AIAgent 实现，与最新梳理出的 `Primary Agent / Primary Actor / lane / fiber / workload` 设计之间，哪些地方还不一致
2. `bun run dev:terminal:tui` 一度出现“终端不可用 / 无内容”的问题，本轮已完成最小修复，需要在 track 内记录原因与后续动作

本文件的目标不是替代 `design.md`，而是记录**当前存量实现与目标设计之间的收口计划**，方便下一个实现阶段直接接续。

---

## 一、本轮确认后的目标设计

### 1. 术语层

后续讨论和文档统一使用：

- `Primary Agent`
- `Primary Actor`
- `SubAgent`
- `Teammate`
- `Autonomy Teammate`
- `Background Task`

### 2. 运行时分层

目标分层为：

1. 业务语义层
   - `Primary Agent`
   - `SubAgent`
   - `Teammate`
   - `Background Task`

2. Actor 层
   - `Primary Actor`
   - `SubAgent Actor`
   - `Teammate Actor`

3. Lane 层
   - `interactive lane`
   - `team lane`
   - `background lane`
   - `autonomy lane`

4. Fiber 层
   - `Foreground Fiber`
   - `Background Fiber`

5. Workload 层
   - `Session Turn`
   - `Team Turn`
   - `Sync SubAgent Task`
   - `Autonomy Task`
   - `Background SubAgent Task`
   - `Background Bash Task`
   - `Background ToolCall Task`

### 3. 三层优先级边界

已确认不要混淆以下三层：

1. `lane`
   - fiber 的调度语义分组
2. `fiber priority`
   - 同一 lane 内 fiber 的排序
3. `mailbox priority`
   - 某个 actor 真正运行后，先处理哪类消息

---

## 二、当前实现与目标设计的剩余边界

### A. Actor 类型命名与语义已完成第一轮对齐

当前状态：

- actor 物理类型当前已收敛为：
  - `primary`
  - `subagent`
- runtime 主会话 VM 字段已统一为：
  - `primaryActorKey`
- `PrimaryAgentActor` 已替换旧的 `MainAgentActor`

当前代码位置：

- `backend/packages/core/src/modules/AIAgent/runtime/actor.ts`
- `backend/packages/core/src/modules/AIAgent/runtime/runtime.ts`

仍保留的边界：

- `Teammate` 目前仍然通过：
  - `identity.kind = "teammate"`
  - `lane = team | autonomy`
  来表达，而不是新的 actor type

结论：

- `main actor` 与 `Primary Actor` 的核心命名冲突已基本消除
- 后续无需再围绕 `main` / `lead` 语义做兼容

---

### B. Lane / Workload 已显式化，但底层仍以运行时元数据方式承载

当前代码位置：

- `backend/packages/organ/src/AIAgent/OrchestratorDriver.ts`
- `backend/packages/organ/src/AIAgent/team/TeamManager.ts`
- `backend/packages/organ/src/AIAgent/agent/SubAgent.ts`
- `backend/packages/organ/src/AIAgent/lane/AiAgentLane.ts`
- `backend/packages/organ/src/AIAgent/lane/AiAgentWorkload.ts`

当前已有内容：

- lane 枚举已存在：
  - `interactive`
  - `team`
  - `background`
  - `autonomy`
- 调度器中已区分：
  - foreground = `interactive | team`
  - background = `background | autonomy`
- workload 常量已存在：
  - `session_turn`
  - `team_turn`
  - `sync_subagent_task`
  - `autonomy_task`
  - `background_subagent_task`
  - `background_bash_task`
  - `background_toolcall_task`

当前边界：

- lane / workload 已经从散落逻辑中收敛出来
- 但目前仍是 AIAgent runtime 元数据，而不是更底层 depa-actor 通用语义
- 这在当前阶段是可接受边界，不构成阻塞项

---

### C. `SubAgent` foreground 语义已完成第一轮收口

当前状态：

- `SubAgent` 不再在 `sync_wait` 模式下统一复用 `team lane`
- 当前规则为：
  - `background` 模式 → `background lane`
  - `sync_wait` 模式 → 按 parent actor 语义决定：
    - `Primary Actor` parent → `interactive lane`
    - `Teammate Actor` parent（team）→ `team lane`
    - `Teammate Actor` parent（autonomy）→ `autonomy lane`
- 同时，subagent workload 已单独收口到：
  - `sync_subagent_task`
  - `background_subagent_task`
  - `background_bash_task`
  - `background_toolcall_task`

结论：

- “同步子任务”和“团队协作”不再混在一个固定 lane 语义里
- 当前无需继续在这个方向做额外重构

---

### D. `lead` 术语残留已转入兼容语义

当前状态：

- runtime / tool 接口中的 `lead` 命名已收口到 `primary`
- 当前剩余的 `lead` 仅用于：
  - 兼容旧的 teammate role 输入值
  - 历史 track 文档中的存量文案

当前代码位置：

- `backend/packages/organ/src/AIAgent/team/TeamRole.ts`
- 当前 track 目录内的历史文档

说明：

- `lead` 已不再是运行时代码接口名
- legacy `lead` 输入仍保留为兼容别名，并在运行时规范化为 `primary`

---

### E. `Teammate` 与 `Autonomy Teammate` 的关系，当前实现基本正确

这一点当前并不是偏差，反而是与最新设计一致的：

- `Autonomy Teammate` 没有变成新的 actor 类型
- 它本质仍然是 `Teammate Actor`
- 区别主要通过：
  - `lane = autonomy`
  - 发起方式
  - idle/shutdown 策略

当前代码位置：

- `backend/packages/organ/src/AIAgent/team/TeamManager.ts`
- `backend/packages/organ/src/AIAgent/autonomy/AutonomyRunner.ts`

结论：

- 这一块不建议再引入新 actor 类型
- 后续重点应放在术语统一，而不是结构重做

---

### F. 多邮箱 + 邮箱优先级与最新设计一致

当前代码位置：

- `backend/packages/core/src/modules/AIAgent/runtime/actor.ts`

当前已有内容：

- `control`
- `childDone`
- `teamInbox`
- `humanInput`
- `toolResult`
- `aiGenerated`

优先级顺序已存在：

- `control` 最高
- 其次 `childDone`
- 再到 `teamInbox`
- 再到 `humanInput` / `toolResult` / `aiGenerated`

结论：

- 这一层与最新讨论一致
- 后续文档中只需继续强调：
  - mailbox priority 不等于 lane
  - mailbox priority 只负责 actor 内部消息消费顺序

---

## 三、TUI 启动空白 / 终端不可用问题

### 现象

执行：

```bash
bun run dev:terminal:tui
```

时，一度出现：

- 终端空白
- 内容不可用
- 终端不断被控制序列重置

### 直接原因

`terminal/packages/tui/src/cli/cmd/tui/app.tsx` 中曾引入一段额外的终端模式接管逻辑：

- 自定义 `installTerminalScrollContainment(renderer)`
- 通过 `setInterval(enable, 250)` 周期性重复写：
  - `?1049h`
  - `?1000h`
  - `?1002h`
  - `?1003h`
  - `?1006h`

这会持续重置终端 surface，导致某些终端环境下表现成：

- TUI 空白
- 控制权反复切换
- 交互异常

### 本轮已做的修复

已回退到更稳定的 renderer 驱动方式：

- 使用 renderer 自带的：
  - `useAlternateScreen: true`
  - `useMouse: true`
- 删除周期性 guard
- 删除 `installTerminalScrollContainment()`

相关文件：

- `terminal/packages/tui/src/cli/cmd/tui/app.tsx`
- `terminal/packages/tui/tests/help-copy.test.ts`

### 当前状态

本轮最小验证已通过：

- `bun test terminal/packages/tui/tests/help-copy.test.ts`
- 实际启动 `bun run dev:terminal:tui` 已可正常显示首页界面

---

## 四、建议的后续改造计划

当前这一轮的核心收口已经完成：

1. `primaryActorKey` / `primary actor` 命名统一
2. actor 物理类型 `main` → `primary`
3. lane / workload 中心化
4. subagent foreground 语义收口
5. runtime / tool / tests / docs 中的 `lead` 术语收口

后续若还要继续推进，建议只考虑以下两个方向：

1. 是否需要为 `Teammate Actor` 提供更显式的 runtime facade / ref 类型
2. 是否需要把部分 lane / workload 语义继续下沉到更通用的运行时层

---

## 五、关键文件索引

### Backend / AIAgent

- `backend/packages/core/src/modules/AIAgent/runtime/actor.ts`
- `backend/packages/organ/src/AIAgent/OrchestratorDriver.ts`
- `backend/packages/organ/src/AIAgent/team/TeamManager.ts`
- `backend/packages/organ/src/AIAgent/agent/SubAgent.ts`
- `backend/packages/organ/src/AIAgent/autonomy/AutonomyRunner.ts`
- `backend/packages/organ/src/AIAgent/autonomy/RuntimeAutonomyController.ts`
- `backend/packages/organ/src/AIAgent/exec/AiAgentExecutor.ts`

### Terminal / TUI

- `terminal/packages/tui/src/cli/cmd/tui/app.tsx`
- `terminal/packages/tui/tests/help-copy.test.ts`

### 设计文档

- `vendor/depa-actor/ACTOR-FOR-AI-AGENTS.md`
- `vendor/depa-actor/README.md`
- `codument/tracks/add-aiagent-background-teams-protocols-autonomy/design.md`
- `codument/tracks/add-aiagent-background-teams-protocols-autonomy/runtime-followups-2026-03-07.md`

---

## 六、本记录的用途

后续如果要继续推进 backend AIAgent 与新设计对齐，应优先从本文件出发，按以下顺序推进：

1. 命名收敛
2. lane 语义中心化
3. subagent foreground 语义收口
4. 文档同步

这样能避免一开始就做过大的结构迁移，同时保留当前功能可用性。

---

## 七、实施进展（2026-03-16，已完成）

### 已完成：TeamRole 语义去歧义

- 不再把 teammate `role` 约束为 `"lead" | "worker"`
- 当前 teammate `role` 改为：
  - 允许任意字符串角色名
  - 保留内建角色常量：
    - `primary`
    - `worker`
- 为兼容历史输入，`lead` 会在运行时规范化为 `primary`

原因：

- `role` 在产品语义上本来就是 teammate 的职责描述，不应被误解成 `Primary Actor`
- 当前 TUI / slash 命令已经允许用户传入如 `coder`、`researcher` 这类自由角色名
- 因此继续保留 `"lead" | "worker"` 这个旧枚举，会让类型层和真实产品语义继续背离

关键文件：

- `backend/packages/organ/src/AIAgent/team/TeamRole.ts`
- `backend/packages/organ/src/AIAgent/team/TeamManager.ts`
- `backend/packages/composer/src/modules/AIAgent/tools/TeamSpawn/Logic.ts`

### 已完成：workload 中心定义

- 新增中心模块：
  - `backend/packages/organ/src/AIAgent/lane/AiAgentWorkload.ts`
- 收敛了以下 workload 常量：
  - `session_turn`
  - `team_turn`
  - `sync_subagent_task`
  - `autonomy_task`
  - `background_subagent_task`
  - `background_bash_task`
  - `background_toolcall_task`

当前作用：

- 先把 workload 作为一层显式语义收出来
- 由 driver / teammate spawn / subagent spawn 在 fiber context 上记录
- 暂时不改变 depa-actor 底层 scheduler 的行为

这一步的边界是：

- `lane` 仍然负责调度语义分组
- `workload` 负责表达“这个 fiber 正在承载哪类业务任务”
- 二者不再混在一起

### 本次新增测试

- `backend/packages/organ/tests/AIAgent/lane_semantics.test.ts`
  - 新增 workload 语义断言
- `backend/packages/organ/tests/AIAgent/team_manager_roster_and_inbox.test.ts`
  - 新增 legacy `lead` → `primary` 规范化断言

### 已完成：`primaryActorKey` 直接重命名

- 不再保留 `mainActorKey` 兼容字段
- runtime 核心 VM 字段、`createVM(...)` 参数、terminal runtime 接线、相关测试，均已统一替换为：
  - `primaryActorKey`
- executor 中获取主会话 actor 的逻辑，已统一改为 `getPrimaryActor(vm)`

关键文件：

- `backend/packages/core/src/modules/AIAgent/runtime/runtime.ts`
- `backend/packages/organ/src/AIAgent/exec/AiAgentExecutor.ts`
- `terminal/packages/tui/src/runtime/TuiRuntime.ts`
- `terminal/packages/minimal/src/app.ts`

说明：

- 这一步是直接重命名，不是桥接兼容
- 当前代码中已无 `mainActorKey` 残留

### 已完成：actor 物理类型 `main` → `primary`

- `ActorType` 已由：
  - `"main" | "subagent"`
  改为：
  - `"primary" | "subagent"`
- `MainAgentActor` 已改为：
  - `PrimaryAgentActor`
- teammate spawn / orchestrator fiber kind / executor guard / tool runtime guard 均已同步

关键文件：

- `backend/packages/core/src/modules/AIAgent/runtime/actor.ts`
- `backend/packages/organ/src/AIAgent/OrchestratorDriver.ts`
- `backend/packages/organ/src/AIAgent/exec/AiAgentExecutor.ts`
- `backend/packages/composer/src/modules/AIAgent/tools/_primaryRuntime.ts`

### 已完成：tool/runtime 接口中的 `lead` → `primary`

- tool runtime helper 文件已由：
  - `_leadRuntime.ts`
  改为：
  - `_primaryRuntime.ts`
- helper 接口已由：
  - `getLeadRuntimeContext(...)`
  改为：
  - `getPrimaryRuntimeContext(...)`
- Team / Protocol / Autonomy 工具实现已全部同步到新命名

说明：

- 当前 runtime / tool 层已不再保留 `lead` 作为接口命名
- 本 track 中涉及产品入口的表述，也已统一为 `primary-facing`

### 已完成：测试层术语收口

- AIAgent 相关测试中的主会话变量名、sender 名、测试标题，已从 `lead` 收口为 `primary`
- 当前测试层仅保留一处 `lead`：
  - legacy teammate role 输入兼容测试
  - 即 `role: "lead"` 会被规范化为 `primary`

说明：

- 这使测试层与当前运行时代码、track 文档术语保持一致
- `lead` 现在只作为兼容输入存在，不再是默认术语

### 已完成：正式 docs 术语同步

- `docs/ai/framework/howto/HowToMakeNewAIAgentTool.md` 已将 `lead-facing management tool` 改为 `primary-facing management tool`
- `docs/ai/modules/AIAgent/howto/team-commands.md` 与 `docs/ai/modules/AIAgent/howto/protocol-commands.md` 中的 `lead` 表述已统一为 `primary agent`
- 当前 `docs/ai/` 下已无 AIAgent 语义上的 `lead` / `lead-facing` 残留

### 本轮相关测试

- `bun test terminal/packages/tui/tests/help-copy.test.ts`
- `bun test backend/packages/organ/tests/AIAgent`
