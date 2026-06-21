# 变更：为 AIAgent 增加 Background Tasks / Agent Teams / Team Protocols / Autonomous Agents（不含持久化恢复）

## 背景和动机 (Context And Why)

本项目已完成 AIAgent 运行时的关键底座：actor mailboxes + depa-actor fiber orchestration + cooperative stepper + DataGraph 事件流。当前缺少“长时任务、团队协作、协议化协作、自治执行”等上层编排能力。

本 Track 目标是在不引入持久化恢复复杂度的前提下，将Background Tasks / Agent Teams / Team Protocols / Autonomous Agents这些能力移植到本项目，并与既有的 Questionnaire（human wait）语义对齐。

## “要做”和“不做” (Goals / Non-Goals)

**目标:**
- 增加 Background Tasks：以后台 subagent 为核心执行体，提供 task_id、状态查询、完成通知，并保证不阻塞前台回合。
 - 增加 Agent Teams：进程内团队（process-scoped roster, in-process）、teammate inbox/broadcast、角色化工具策略。
- 增加 Team Protocols：基于 request_id 的 shutdown handshake 与 plan approval gating。
- 增加 Autonomous Agents：进程内自治 runner，基于 TaskTree 进行扫描-claim-执行-完成闭环。
- 增加 best-effort disk log：将关键编排事件以结构化方式落盘用于审计/调试（不等价于恢复）。
- 关键语义：`QuestionnaireRequest(suspendPolicy="pause_all")` 仅阻塞 interactive/team，不阻塞 background/autonomy（lane/scope gating）。

**非目标:**
- 不做持久化保存-恢复（不保证进程重启后的任务/协议/自治状态恢复）。
- 不做跨进程/跨机器 worker pool（不引入远程队列与投递保证）。
- 不做 exactly-once 外部副作用与幂等执行（LLM/tool 调用不做重放安全保证）。

## 当前状态（Current Status）

- 本 Track 的主干能力（background tasks、agent teams、plan approval gating、thin-context identity re-injection、disk log）已经落地。
- 最新一轮复审中识别出的收尾项（autonomy idle timeout、跨会话 roster status 可见性、shutdown handshake 端到端行为、protocol/autonomy BizEvent）现已补齐。
- 在此基础上，新增一个 TUI 接入需求：这些能力不仅要能通过 primary agent 工具触发，也要支持 `/<cmd>` 形式的显式提示词模板触发，以减少输入字符、提升可发现性。当前一级命令命名决策为 `/bg`、`/team`、`/protocol`、`/autonomy`。`/<cmd>` 方案还必须保留扩展性，未来可承载类似 Claude Code、Codex 等 coding agent 的自定义 command 体系。
- TUI 接入面现已落地：primary-facing tools 与 `/<cmd>` prompt-template expansion 都已实现，并采用可扩展 command registry 设计。
- 自治命令最终命名为 `/autonomy`。
- 已补充最终交付说明与 TUI 使用示例。
- TUI 的双击 `Esc` 中断语义已对齐 actor 模型：通过向当前主 actor 发送 `cancel_requested` 触发取消，而不是以 fetch/network abort 作为主路径。
- 已补充对应的 TUI e2e 测试，验证双击 `Esc` 后 busy 动画消失，且中断后仍可继续发起新的对话回合。
- 本 Track 可恢复为 completed。

## 概念关系（Teammate / Autonomy / Subagent / Persistence）

- `subagent`：一次性、短生命周期的子代理。通常用于聚焦某个子任务，完成后返回结果并退出。
- `teammate`：进程内持久实体（process-scoped teammate）。在当前进程生命周期内可跨多轮存在，拥有身份、角色、收件箱与状态。
- `autonomy`：不是另一种实体，而是 teammate 的一种工作模式 / lane。autonomy teammate 会在没有用户逐次派工时，自行扫描 task board、claim 任务、执行并在空闲超时后退出。
- 关系总结：
  - 所有 autonomy worker 本质上都是 teammate。
  - subagent 与 teammate 是不同生命周期模型：subagent 偏一次性，teammate 偏持续存在。
  - `team` 更偏协作关系与通信面；`autonomy` 更偏执行层与自驱调度。

### 关于“暂不支持持久化恢复”

本 Track 明确不支持“进程重启后的持久化恢复”。这里的“状态”不只指 teammate 状态，而是指整套 s08-s11 运行态，包括但不限于：
- teammate roster / lifecycle state / inbox 未消费消息
- background task registry 与 inflight 状态
- protocol request_id 状态机
- autonomy runner 的内存态与 task claim 过程态
- orchestrator / fiber 的运行时状态

本 Track 仅提供 **best-effort 日志记录**（例如 `orchestration_history.txt`）用于审计与调试；这些日志不是恢复快照，不保证系统重启后可以自动恢复为活跃对象。

## 变更内容（What Changes）

- 引入 fiber lane/scope：至少区分 `interactive/team/background/autonomy`，并将 human wait gate 从“全局 pause”演进为“按 lane gate”。
- 扩展 orchestrator driver：提供“前台回合推进”与“后台推进”的不同 tick 边界，避免 background inflight 阻塞前台回合结束。
- 新增 Background Tasks 工具/能力：
  - background subagent（核心实现方式）
  - background bash（通过后台 subagent 执行 bash）
  - background tool call（通过后台 subagent 执行指定工具）
- 新增 Agent Teams：process-scoped roster + inbox + broadcast + teammate spawn（基于 fibers），并在 TUI 中提供 primary-facing tools 与 `/<cmd>` 模板入口。
- 新增 Team Protocols：request_id 相关性跟踪与两类协议落地，并在 TUI 中提供显式审批/查询入口与 `/<cmd>` 模板入口。
- 新增 Autonomous runner：基于 TaskTree 的任务扫描与 claim 分配；idle/work 循环；identity re-injection；idle timeout，并在 TUI 中提供运行控制与 `/<cmd>` 模板入口。
- best-effort disk log：将 background/team/protocol/autonomy 的关键事件以结构化记录落盘（优先复用现有 message history effects）。
  - disk log 文件为独立的 `orchestration_history.txt`（不写入 message history）。
  - disk log 线格式统一为 StreamTranscript；multi-stream；payload 为 JSON；支持 backup/ 轮转。

- depa-actor core hygiene (review follow-up, P0):
  - Keep the fiber lane mechanism in depa-actor core (`vendor/depa-actor/src/orchestration/*`); do not plan to extract lanes out of core.
  - Keep core APIs generic: avoid AI-agent-only naming/semantics as core public API; the AI-agent layer provides default lane values and policies.

## 影响范围（Impact）

- 受影响的功能规范：AIAgent runtime、Questionnaire/human-wait、RunSubAgent、TaskTree。
- 受影响的代码（预期）：
  - `vendor/depa-actor/src/orchestration/scheduler.ts`（lane gate）
  - `vendor/depa-actor/src/orchestration/types.ts`（fiber metadata 扩展）
  - `backend/packages/organ/src/AIAgent/OrchestratorDriver.ts`（tick 边界、后台 runner、team/protocol/autonomy 运行入口）
  - `backend/packages/core/src/modules/AIAgent/stream/AgentEventGraph.ts`（新增 BizEvent 类型/emit helper）
  - `backend/packages/core/src/modules/AIAgent/runtime/MessageHistoryEffects.ts`（best-effort disk log 复用/扩展）
  - `backend/packages/composer/src/modules/AIAgent/tools/**`（新增 background/team/protocol/autonomy 工具定义）
  - `terminal/packages/tui/src/**`、`terminal/packages/minimal/src/**`（新增 slash-command 模板解析 / prompt expansion / autonomy runner wiring）
