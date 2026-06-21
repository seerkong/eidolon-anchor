# 变更：落地 AI Runtime Control Engine

## 背景和动机 (Context And Why)
前序 track 已经完成 runtime-control engine 的设计、AI runtime control 原语分层、composer-owned checkpoint、session upgrade CLI/TUI 入口，并用真实历史 session 验证 upgrade 可以生成 clean checkpoint。下一步需要把 AI runtime 的真实 load/resume/save/effect 主流程切换到新 engine，避免旧 repository、snapshot writer、effect evidence writer 或 shadow mode 继续形成第二套事实源。

## “要做”和“不做” (Goals / Non-Goals)
**目标:**
- 将 AI runtime load/resume 切换到 owned checkpoint gate，未升级旧 session 不静默恢复。
- 将 save/checkpoint 主流程收敛为 composer/runtime-control engine owner，旧 concrete writers 仅作为 support effect。
- 将 effect lifecycle、durable head、cohort commit、recovery classification 作为 runtime 一致性边界。
- 删除或隔离旧 shadow/compatibility 入口，防止恢复路径绕过 engine。
- 用历史问题和真实 session upgrade 场景固化 conformance tests。

**非目标:**
- 不重新设计 `depa-actor` 或 `depa-processor`。
- 不重复实现 session-upgrade CLI/TUI 入口。
- 不把 ingress/diagnostics journal sink 纳入 checkpoint safepoint 管理。
- 不把 derived indexes 升级为 durable recovery head。
- 不自动修复 dirty/orphaned 历史 session。

## 变更内容（What Changes）
- **BREAKING**：AI runtime owned mode 将拒绝未升级或 dirty/orphaned 的旧 session，而不是静默按旧路径恢复。
- Runtime load/resume path 必须验证 upgrade marker、checkpoint marker、head sequences 和 effect evidence classification。
- Runtime save path 必须通过 runtime-control composer 提交 concrete checkpoint effect 和 cohort marker。
- Effect lifecycle evidence 必须通过 runtime-control facade 记录，不允许 executor/support 直接写 runtime-control evidence 文件。
- 添加 conformance fixtures 覆盖 unpaired tool output、duplicate human input、removed tool handler、head mismatch、late completion 和 upgraded clean resume。

## 影响范围（Impact）
- 受影响的功能规范：`ai-runtime-control-engine-landing`、`aiagent-persistence-recovery`。
- 受影响的代码：`cell/packages/ai-organ-logic` runtime persistence/recovery/executor/coordinator；`cell/packages/ai-runtime-control-*` facade 和 tests；`terminal/packages/tui` 和 `terminal/packages/cli` 的迁移入口回归测试。
