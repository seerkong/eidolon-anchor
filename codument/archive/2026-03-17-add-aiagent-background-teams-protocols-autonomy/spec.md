# 变更规范：在 depa-actor Orchestrator 下补齐 Background Tasks / Agent Teams / Team Protocols / Autonomous Agents（不含持久化恢复）

## 概述

本 Track 基于本项目既有的关键底层设计（`AiAgentVm` / actor mailboxes / fiber orchestrator driver / DataGraph 事件流）实现核心能力：

- Background Tasks
- Agent Teams
- Team Protocols
- Autonomous Agents

约束：本 Track **不包含**“持久化保存-恢复”（即进程重启后的任务恢复、exactly-once effect dispatch、跨进程队列等）。但需要提供 **best-effort disk log** 用于审计/调试。

关键语义决策：当出现 `QuestionnaireRequest(suspendPolicy="pause_all")` 时：

- SHALL 阻塞 interactive/team 相关 fiber 的推进
- SHALL NOT 阻塞 background/autonomy 相关 fiber 的推进

这要求将 human wait gate 从“全局 pause”演进为“按 lane/scope gate”。

术语约定：
- `subagent`：一次性、短生命周期执行体。
- `teammate`：进程内持久实体，拥有身份、状态与收件箱。
- `autonomy`：teammate 的自治工作模式 / lane，不是另一种独立实体类型。

持久化边界约定：
- 本 Track 的“暂不支持持久化恢复”不只针对 teammate 状态，而是针对整套 s08-s11 运行态。
- 系统 MAY 将关键事件写入日志，但 MUST NOT 将这些日志当作恢复快照。

## ADDED Requirements

### Requirement: Fiber lane/scope gating（pause_all 仅阻塞 interactive/team）

系统 MUST 为 fiber 引入 lane/scope 元数据（至少包含：`interactive`、`team`、`background`、`autonomy`），并在 orchestrator 调度时对 human wait gate 做 lane 级别的门控。

#### Scenario: pause_all 不阻塞 background/autonomy
- **GIVEN** interactive/team fiber 进入 human wait（由 Questionnaire 触发）且 `suspendPolicy=pause_all`
- **AND** 存在 background/autonomy lane 的 ready fiber
- **WHEN** orchestrator 调用 `scheduleOne()` 选择下一条 fiber
- **THEN** 系统仍可选择并推进 background/autonomy 的 ready fiber
- **AND** 系统不得推进 interactive/team lane 的 ready fiber

#### Scenario: continue_others 仅影响本 fiber
- **GIVEN** 某 fiber 进入 human wait 且 `suspendPolicy=continue_others`
- **AND** 存在其他 lane 的 ready fiber
- **WHEN** orchestrator 调度下一步
- **THEN** 其他 ready fiber 仍可被推进

### Requirement: Background Tasks（s08）

系统 MUST 支持在不阻塞前台交互回合的前提下启动后台工作，并在完成时提供可观测的 completion 通知。

本 Track 需要支持的后台能力包括：

- Background subagent（通过现有 `RunSubAgent(mode="background")` 的机制扩展为可查询的 background task）
- Background bash（后台运行 shell 命令）
- Background tool call（后台执行一次指定 tool call）

#### Scenario: 启动后台任务并返回 task_id
- **GIVEN** 当前会话存在 orchestrator driver
- **WHEN** 用户或 primary agent 启动一个后台任务（subagent/bash/toolcall）
- **THEN** 系统立即返回一个稳定的 `task_id`
- **AND** 前台回合推进不应被该后台任务的 inflight IO 阻塞

#### Scenario: 后台任务完成后产生 completion 通知
- **GIVEN** 某后台任务已启动
- **WHEN** 该任务完成（success/fail/cancel）
- **THEN** 系统 MUST 产生一个 BizEvent（或等价事件）记录 completion
- **AND** completion MUST 以“安全边界注入”的方式进入主对话可见范围（不在一次 LLM call 的中途插入）

#### Scenario: 查询后台任务状态
- **GIVEN** 某后台任务已启动并拥有 `task_id`
- **WHEN** 用户查询该 `task_id` 状态
- **THEN** 系统返回 `pending|running|suspended|completed|failed|cancelled`（或等价）
- **AND** 返回应包含最少必要元数据（开始/结束时间、摘要、错误信息可选）

### Requirement: Agent Teams（s09）

系统 MUST 提供 process-scoped team（in-process）：在同一进程内跨多个会话/VM 共享 roster 与 teammates；进程退出即销毁（不做重启恢复）。

#### Scenario: Spawn teammate 并进入 roster
- **GIVEN** 当前进程已初始化 team registry
- **WHEN** primary agent 启动一个 teammate（包含 name/role/agentType 或等价配置）
- **THEN** 系统在 roster 中记录该 teammate
- **AND** teammate 以独立 fiber（或等价）运行，可被调度推进

#### Scenario: 发送消息到 teammate inbox
- **GIVEN** teammate 已存在且处于可运行/可等待状态
- **WHEN** primary agent 向该 teammate 发送 message
- **THEN** 消息进入 teammate inbox
- **AND** teammate 在下一次 LLM 调用前 MUST drain inbox，并把消息注入其 messages 上下文

#### Scenario: 跨会话共享 roster（同一进程内）
- **GIVEN** 进程内存在 team roster 且包含至少一个 teammate
- **AND** 会话 A 已创建该 roster
- **WHEN** 会话 B（同一进程）读取 roster
- **THEN** 会话 B 能看到与会话 A 一致的 roster 与 teammate 状态

#### Scenario: Broadcast
- **GIVEN** roster 中存在多个 teammates
- **WHEN** primary agent 执行 broadcast
- **THEN** 每个 teammate inbox 都收到一条 broadcast 消息

### Requirement: Team Protocols（s10）

系统 MUST 提供基于 `request_id` 的 protocol primitives，用于实现至少两类协议：graceful shutdown handshake 与 plan approval gating。

#### Scenario: Shutdown handshake（request/response）
- **GIVEN** primary agent 与 teammate 已存在
- **WHEN** primary agent 发起 shutdown 请求
- **THEN** 系统生成 `request_id` 并发送 shutdown_request 消息到 teammate
- **AND** teammate 可通过 shutdown_response（approve/reject + reason 可选）回复
- **AND** primary agent 可查询该 `request_id` 的状态

#### Scenario: Plan approval gating
- **GIVEN** teammate 需要执行一项风险较高/成本较高的动作
- **WHEN** teammate 提交 plan_request（plan 文本 + request_id）
- **THEN** primary agent 需要通过 plan_review（approve/reject + feedback 可选）响应
- **AND** teammate 在未 approve 前 MUST 不执行受 gate 保护的动作

### Requirement: Autonomous Agents（s11，进程内自治，不含恢复）

系统 MUST 支持进程内自治：在没有用户输入的情况下，自治 runner 仍可周期性推进 background/autonomy lane 的 fibers，并基于 TaskTree 执行“扫描-claim-执行-完成”的闭环。

#### Scenario: TaskTree 作为 task board（claim + 分配）
- **GIVEN** TaskTree 中存在 backlog 任务
- **AND** 至少一个 teammate 处于 idle 状态
- **WHEN** autonomy runner 扫描 task board
- **THEN** 系统选择一个可 claim 的任务并将其分配到某个 teammate（更新 TaskTree 结构/状态）
- **AND** 该 teammate 开始执行并在完成时更新 TaskTree

#### Scenario: 身份重注入
- **GIVEN** 某 teammate 即将从 idle 恢复执行
- **WHEN** 系统检测其上下文不足（例如消息过短或被压缩后仅剩少量消息）
- **THEN** 系统 MUST 在 LLM call 前注入结构化 identity block（name/role/team）

#### Scenario: Idle timeout
- **GIVEN** 某 teammate 进入 idle
- **WHEN** 在一定 idle timeout 内既无 inbox 消息也无可 claim 任务
- **THEN** teammate SHOULD 自行退出（或标记为 shutdown），避免 zombie agent

### Requirement: TUI entrypoints for Background / Teams / Protocols / Autonomy

系统 MUST 在 terminal TUI 中为本 Track 的能力提供两类并行入口：
- primary-facing tools（供 primary agent 显式调用）
- `/<cmd>` 形式的显式提示词模板入口（供用户节省输入字符）

`/<cmd>` 入口的本质可以是“将短命令展开为一段标准化用户提示词模板”，不要求绕过 primary agent，也不要求直接跳过工具选择。该机制 MUST 设计为可扩展 command registry / command spec 形态，而不是只为当前几个内建命令硬编码。

当前一级命名决策建议为：`/bg`、`/team`、`/protocol`、`/autonomy`。其中自治相关命令显式使用 `/autonomy`，以避免与 `subagent`、primary agent 或一般 worker 概念混淆。

#### Scenario: Background capabilities can be triggered from TUI
- **GIVEN** 用户在 terminal TUI 中希望运行后台任务
- **WHEN** 用户使用自然语言或 `/<cmd>` 形式触发 background 能力
- **THEN** primary agent 可以显式调用后台相关工具（如 background subagent/bash/toolcall/status）
- **AND** 用户无需手写完整长提示词也能触发同等能力

#### Scenario: Team capabilities can be triggered from TUI
- **GIVEN** 用户在 terminal TUI 中希望创建或管理 teammates
- **WHEN** 用户使用自然语言或 `/<cmd>` 形式触发 team 能力
- **THEN** primary agent 可以显式调用 team 相关工具（spawn/list/send/broadcast 等）
- **AND** `/<cmd>` 模板应覆盖高频团队操作

#### Scenario: Protocol capabilities can be triggered from TUI
- **GIVEN** 用户在 terminal TUI 中希望发起 shutdown 或执行 plan review
- **WHEN** 用户使用自然语言或 `/<cmd>` 形式触发 protocol 能力
- **THEN** primary agent 可以显式调用 protocol 相关工具（shutdown request/status、plan review/status 等）
- **AND** request_id 应继续作为可见对象暴露给用户

#### Scenario: Autonomy capabilities can be triggered from TUI
- **GIVEN** 用户在 terminal TUI 中希望启动、推进或查看 autonomy runner
- **WHEN** 用户使用自然语言或 `/<cmd>` 形式触发 autonomy 能力
- **THEN** primary agent 可以显式调用 autonomy 相关工具（start/tick/status 等）
- **AND** TUI runtime 在启用后可持续推进 autonomy/background lane

#### Scenario: Slash commands expand into stable prompt templates
- **GIVEN** 用户输入 `/<cmd>` 形式的短命令
- **WHEN** TUI 解析该命令
- **THEN** 系统将其扩展为一段稳定的、面向 primary agent 的用户提示词模板
- **AND** 展开结果应保留用户提供的关键参数
- **AND** 展开机制不得破坏现有自然语言输入路径

#### Scenario: Slash command system is extensible for future custom commands
- **GIVEN** 系统未来需要支持类似 Claude Code / Codex 的自定义 command
- **WHEN** 新增一个 `/<cmd>` command 定义
- **THEN** 系统 SHOULD 能通过配置/注册方式接入，而不是修改大量分支硬编码
- **AND** command 定义应至少支持：命令名、参数解析、模板展开或执行策略、帮助描述
- **AND** 当前内建 `/<cmd>` 能力应建立在同一扩展机制之上

## 非功能需求

### Requirement: Best-effort disk log（不等价于持久化恢复）

系统 MUST 将 background/task/team/protocol/autonomy 的关键事件以 best-effort 方式落盘，供审计/调试使用。

落盘文件 MUST 为独立文件：`orchestration_history.txt`（不得写入 `message_history.txt`）。

落盘位置 MUST 为 session 目录根下：`<sessionDir>/orchestration_history.txt`。

落盘格式 MUST 使用 StreamTranscript 线格式，并确保输出可被 `StreamTranscript.parse(...)` 正确解析。

落盘记录 MUST 使用 multi-stream：不同类型事件使用不同的 `stream` 值。`stream` 命名 MUST 为 `lower_snake_case`。

每条 record 的 `payload` MUST 为 JSON（UTF-8 文本），且 SHOULD 包含：

- `ts`：ISO 时间戳（例如 `2026-03-03T18:00:00Z`）
- `kind`：事件类别（例如 `background_task_done`、`team_message`、`protocol_decision`、`autonomy_claim`）
- `session_id`：若可用，记录来源 session

推荐的 stream 列表（可扩展）：

- `orchestrator_tick`
- `orchestrator_schedule`
- `fiber_spawn`
- `fiber_state`
- `background_task`
- `team_roster`
- `team_message`
- `protocol_event`
- `autonomy_event`

为保证本 Track 自包含，StreamTranscript 线格式在此摘录：

- 文件可选包含 header：`@delimiter: ----`
- 每条 record 以 header 行开始：`---- #<stream> ?<marker>`（marker 可选，但建议总是提供）
- payload 为紧随其后的多行文本
- 若有 marker，则以 `/?<marker>` 结束该 record

#### Scenario: 关键事件可在会话目录中回放
- **GIVEN** 会话内发生 background completion / team message / protocol decision / autonomy claim 等关键事件
- **WHEN** 用户查看会话输出文件
- **THEN** 能在 `orchestration_history.txt` 中看到对应事件的结构化记录（以 StreamTranscript records 形式呈现）

#### Scenario: orchestration_history 与 message_history 分离
- **GIVEN** 会话内产生了编排关键事件
- **WHEN** 系统写入 best-effort disk log
- **THEN** 系统写入 `orchestration_history.txt`
- **AND** 系统不得将这些编排事件写入 `message_history.txt`（避免污染对话消息历史）

#### Scenario: orchestration_history 位于 sessionDir 根目录
- **GIVEN** sessionPathProvider 可返回 sessionDir
- **WHEN** 系统写入编排关键事件
- **THEN** 写入路径为 `<sessionDir>/orchestration_history.txt`

#### Scenario: orchestration_history 支持 backup/ 轮转
- **GIVEN** `orchestration_history.txt` 文件已存在
- **WHEN** 系统触发 disk log 轮转
- **THEN** 系统将旧文件移动到 `<sessionDir>/backup/` 并创建一个新的空 `orchestration_history.txt`

#### Scenario: transcript 文件可被 StreamTranscript.parse 解析
- **GIVEN** 会话已产生 best-effort disk log
- **WHEN** 系统读取该文件内容并调用 `StreamTranscript.parse(text)`
- **THEN** parse 结果包含至少一条 record
- **AND** 每条 record 至少包含 `stream` 与 `payload`

### Requirement: 资源与成本保护

系统 SHOULD 提供基本的限流/预算控制（例如：最大 background 任务数、最大并行 teammate 数、每任务 wall-time、每自治周期最大调度步数）。

## 验收标准

- Background tasks 支持 subagent/bash/toolcall 三类启动方式，并具备 task_id 与 status 查询。
- pause_all lane gate 生效：interactive/team 被阻塞但 background/autonomy 可继续推进。
- Team roster + message/broadcast 可用，并在下一次 LLM 调用前 drain inbox。
- Shutdown handshake 与 plan approval gating 可用，且 `request_id` 不串线。
- Autonomous runner 可基于 TaskTree claim 并推进任务闭环（进程内）。
- Terminal TUI 为 background/team/protocol/autonomy 提供 primary-facing tools 与 `/<cmd>` 模板双入口。
- `/<cmd>` 机制具备面向未来自定义 command 体系的扩展性。
- 有新增/更新测试覆盖关键行为，且目标覆盖率 >80%（按项目工作流）。

## Review follow-ups

本 Track 在 vendor/depa-actor 上引入了 lane + human-wait gating 相关能力。最新决策如下：

- Keep the fiber lane mechanism in depa-actor core (`vendor/depa-actor/src/orchestration/*`); do not plan to extract lanes out of core.
- Keep core APIs generic: avoid AI-agent-only naming/semantics as core public API; place AIAgent-specific defaults/policies in an AI extension layer when needed.
- Web-tool-only network access gate: enforce in `AiAgentExecutor`, immediately before `toolRegistry.call(...)`.

Status
- depa-actor core scheduling no longer hard-codes AI semantics; AI pause_all gating is provided via an explicit preset hook (`createAiAgentSchedulerHooks`).
- identity re-injection is implemented for teammates on thin context at the LLM-call boundary.
- plan approval gating enforcement is implemented at the tool execution boundary (see `backend/packages/organ/src/AIAgent/exec/AiAgentExecutor.ts`).
- team broadcast is implemented and test-covered.
- final actor control semantics are fixed: `cancel` aborts only the current LLM call while `shutdown` stops the actor; TUI double-`Esc` maps to main-actor cancel plus subagent shutdown.
- Final closure items have been implemented: autonomy idle timeout, cross-session teammate status visibility in roster API, shutdown handshake end-to-end lifecycle wiring, and protocol/autonomy BizEvent coverage.

## 范围外事项

- 进程重启后的恢复（任务/协议/自治状态恢复）。
- 跨进程/跨机器调度与消息投递保证。
- exactly-once 外部副作用与幂等执行。
