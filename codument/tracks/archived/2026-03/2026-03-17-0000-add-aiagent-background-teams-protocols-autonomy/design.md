## 上下文

本项目已具备 AIAgent 的关键底座：

- actor runtime（多 mailbox + priority）
- depa-actor fiber orchestration（spawn/suspend/resume/parent-child）
- cooperative stepper（等待外部 IO 时让出调度）
- DataGraph 事件流（BizEvent → message history / TUI）

但上层仍缺少：后台任务（s08）、团队协作（s09）、协议化协作（s10）、以及进程内自治（s11）。

本 Track 的范围明确排除“持久化保存-恢复”。同时，需要提供 best-effort disk log 以支持审计/调试。

关键语义：`QuestionnaireRequest(suspendPolicy="pause_all")` 仅阻塞 interactive/team；background/autonomy 仍可推进。这要求引入 fiber lane/scope gate。

术语/语义边界：
- `subagent` 与 `teammate` 是两类不同生命周期模型：前者短生命周期、一次性；后者在当前进程内持续存在。
- `autonomy` 不是独立的实体类型，而是 teammate 的一种工作模式 / lane。
- `cancel` 表示取消当前 LLM 调用 / 当前回合执行，但 actor 继续存在。
- `shutdown` 表示停止 actor 生命周期。
- 因此未来 TUI 命名建议应尽量避免让 autonomy 命令与 subagent 概念混淆。当前决策：自治相关 slash-command namespace 采用 `/autonomy`，不采用 `/agent`、`/worker`、`/workers` 或 `/auto`。

持久化边界：
- 本 Track 不做“重启后恢复运行态”。
- 这里的运行态包含 teammate roster、background task registry、protocol 状态机、autonomy runner 内存态、fiber/orchestrator 状态等。
- `orchestration_history.txt` 仅用于审计/调试，不充当恢复快照。

## 方案概览

1. 引入 fiber lane/scope（interactive/team/background/autonomy）
  - 将 human wait gate 从“全局 pause_all”演进为“按 lane gate”。

2. 扩展 orchestrator driver：前台回合推进与后台推进分离
  - 交互回合的 tick 应在“前台已 settle（idle / human_wait）”时返回，即使后台仍有 inflight。
  - 后台 runner 以周期 tick 推进 background/autonomy fibers。

3. s08 Background Tasks
  - 以后台 subagent fiber 为统一执行体。
  - 提供三类启动方式：BackgroundRunSubAgent / BackgroundBash / BackgroundToolCall。
  - 提供 task registry（进程内）与状态查询。
  - completion 通过 BizEvent + safe-boundary 注入呈现。

4. s09 Agent Teams
  - process-scoped roster（in-process）：team coordinator 管理成员，成员作为 fibers 运行；跨会话共享。
  - teammate inbox/broadcast：消息以 inbox 事件注入到 teammate 上下文，且在 LLM call 前 drain。
  - 角色化工具策略：primary vs worker。

5. s10 Team Protocols
  - 提供 request_id 相关性协议库：shutdown handshake、plan approval gate。
  - 将协议状态与关键决策以 BizEvent 记录，并写入 best-effort disk log。

6. s11 Autonomous Agents
  - 复用 TaskTree 作为任务板：scan → claim → execute → update。
  - WORK/IDLE 两阶段循环；idle timeout。
  - identity re-injection：上下文不足时在 LLM call 前注入结构化身份块。

7. TUI interaction surface
  - 这些能力在 terminal TUI 中需要提供双入口：
    - primary-facing tools（供 primary agent 显式调用）
    - `/<cmd>` prompt-template expansion（供用户短输入显式触发）
  - `/<cmd>` 不直接绕过 agent loop，而是扩展成稳定的用户提示词模板，再由 primary agent 选择对应工具。
  - `/<cmd>` 应抽象为可扩展 command registry / command spec，而不是针对当前命令做散落式硬编码，以便未来支持类似 Claude Code / Codex 的自定义 commands。
  - autonomy runner 需要在 TUI runtime 中被实例化并在 idle / turn gap 中推进。

8. Best-effort disk log
  - 写入独立文件：`orchestration_history.txt`（与 `message_history.txt` 分离）。
  - 复用现有 writer（或新增轻量 effects），将关键编排事件以结构化 record 追加写入。
  - 落盘格式统一使用 StreamTranscript（见 spec.md 中的线格式摘录）。
  - stream 命名采用 multi-stream（按事件类别拆分），payload 统一 JSON。
  - 支持 backup/ 轮转（放入 `<sessionDir>/backup/`，与 message history 一致）。
  - 明确：该落盘不用于恢复，仅用于审计/调试。

## 影响范围与修改点（Impact）

  - TUI entrypoints
  - `backend/packages/composer/src/modules/AIAgent/tools/**`
    - 新增 Team / Protocol / Autonomy primary-facing tools
  - `terminal/packages/tui/src/**`
    - 新增 `/<cmd>` registry / parser / prompt template expansion / autonomy runner wiring
  - `terminal/packages/minimal/src/**`
    - 与 TUI mock runtime 保持一致的 slash-command / autonomy 行为

- depa-actor（vendor）
  - `vendor/depa-actor/src/orchestration/types.ts`：为 fiber 增加 lane/scope 元数据（例如 `lane: "interactive" | ...`）。
  - `vendor/depa-actor/src/orchestration/scheduler.ts`：scheduler core 保持通用；通过 `schedulerHooks` 注入 lane gate。
  - `vendor/depa-actor/src/orchestration/presets/aiAgent.ts`：提供 AIAgent 兼容的 pause_all lane gate 预设。

- AIAgent orchestrator driver
  - `backend/packages/organ/src/AIAgent/OrchestratorDriver.ts`：
    - 将 tick API 拆分为“前台 settle tick”和“后台 runner tick”。
    - 在 background task completion 时发出 completion BizEvent，并在合适边界注入到主对话（或至少进入 message history）。

- BizEvent/DataGraph
  - `backend/packages/core/src/modules/AIAgent/stream/AgentEventGraph.ts`：新增 background/team/protocol/autonomy 相关事件类型（或以统一 envelope 事件承载）。
  - `backend/packages/core/src/modules/AIAgent/stream/MessageHistoryGraph.ts`：将上述事件映射到可落盘的 transcript stream。
  - `backend/packages/core/src/modules/AIAgent/runtime/MessageHistoryEffects.ts`：现有 `message_history*.txt` writer 已使用 StreamTranscript（ensureMarker）。本 Track 的 `orchestration_history.txt` writer 复用同一线格式，但文件独立。

- Tools（composer）
  - 新增：BackgroundRunSubAgent / BackgroundBash / BackgroundToolCall（以及 Team/Protocol/Autonomy 管理工具，视最终 API 决定）。

## 决策

- 决策：pause_all lane gate
  - interactive/team 被 pause_all gate；background/autonomy 不被 gate。
  - 理由：对齐 s08/s11 预期（前台暂停时后台仍可完成任务）。

- 决策：背景执行以“后台 subagent fiber”统一承载
  - 理由：复用已有 fiber 生命周期、childDone 通知与 cooperative 等待机制，降低并发模型复杂度。

- 决策：TaskTree 作为自治 task board
  - 理由：复用既有数据模型与工具链，减少重复状态源。

## 风险 / 权衡

- lane gate 会改变 scheduler 语义（属于跨切面变更）
  - 缓解：新增 vendor 单测覆盖 lane gate，并提供集成测试覆盖“pause_all 不阻塞 background”。

- 前台 tick 与后台 tick 分离后，可能出现“后台通知注入时序”不稳定
  - 缓解：规定注入边界（仅在下一次 LLM call 前或 turn start 时 drain 并注入），并用测试锁定。

- 无持久化恢复导致任务在进程退出时丢失
  - 缓解：best-effort disk log 明确用于审计；并为后续 durability track 预留接口与事件模型。

## 兼容性设计

- 保持现有 terminal/tui 驱动方式不变：仍是“投递输入 → resumeFiber → tick”。
- 新增的 tick API/runner 为可选增强，不破坏现有交互回合。

## 迁移计划

1) 先落 lane 元数据与 scheduler gate（vendor 先测后改）。

2) 再改 OrchestratorDriver 的 tick 边界，确保 foreground settle 不受 background inflight 影响。

3) 在此基础上逐步添加 s08 → s09 → s10 → s11 的能力，并用集成测试门控。

## 后续可选方向

- 是否需要为 teammate 暴露更显式的 runtime facade / ref 类型
- 是否需要把部分 lane / workload 语义继续下沉到更通用的运行时层
- autonomy runner 的 tick 频率与资源预算是否要进一步产品化配置

## Post-review follow-ups

本 Track 在 review 中提出的关键 follow-ups 已完成，当前状态如下：

1) depa-actor core hygiene
- fiber lane 机制保留在 `vendor/depa-actor/src/orchestration/*`
- core API 继续保持通用，AIAgent 语义通过显式 preset hook 注入

2) 前台回合与后台推进边界
- terminal 回合循环已使用 `tickUntilForegroundSettled`
- background / autonomy 通过独立 pump 持续推进

3) 协议 gating 执行边界
- plan approval gating 已在 tool 执行边界生效

4) Web-tool-only network access gate
- network access 已限制在 web tools 边界

5) 身份重注入
- team / autonomy teammate 已在 thin context 下于 LLM 调用前注入 identity block

6) best-effort disk log
- `orchestration_history.txt` 已实现 best-effort 写入与失败路径记录

7) TUI 双入口
- background / teams / protocols / autonomy 的 primary-facing tools 与 `/<cmd>` prompt-template expansion 已落地
- `/<cmd>` 已按可扩展 command registry 设计
- 当前一级命令为：`/bg`、`/team`、`/protocol`、`/autonomy`

8) TUI 中断语义
- terminal TUI 双击 `Esc` 已统一为 actor 控制语义：
  - 主 actor 收到 `cancel_requested`
  - 活动 subagent 收到 `shutdown_requested`
- 已有对应 e2e 覆盖

## Update (2026-03-10): interrupt and shutdown semantics

本 Track 在 TUI 集成后，对 actor 控制语义做了最终收口：

- 主 actor：`cancel_requested` 仅取消当前模型调用，不销毁 actor
- teammate / subagent：只有收到 `shutdown_requested` 时才退出
- terminal TUI 双击 `Esc`：
  - 向主 actor 发送 `cancel_requested`
  - 向活动中的 subagent 发送 `shutdown_requested`

这样可以把“打断当前回答”和“结束某个 actor 生命周期”清晰区分开，避免 teammate shutdown、autonomy idle-exit 与普通用户中断混淆。
