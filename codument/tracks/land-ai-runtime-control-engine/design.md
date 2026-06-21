## 上下文
本 track 接在三个前置工作之后：

1. `design-runtime-control-engine` 已确认 runtime-control engine 是可恢复 effectful command interpreter，底座复用 `depa-actor@0.2.0` 与 `depa-processor`。
2. `refactor-ai-runtime-control-primitives` 已建立 vendor primitive 与 AI runtime control contract/logic 分层。
3. `adopt-ai-runtime-control-composer` 已实现 composer-owned checkpoint、真实 head/effect scanner、session upgrade dry-run/apply、CLI/TUI upgrade entry。

当前剩余问题不是“是否有 engine”，而是 AI runtime 主流程仍可能从旧 repository、shadow gate 或具体 writer 进入，形成第二套恢复事实源。本 track 负责把 runtime 主流程落到 engine 上。

## 方案概览
1. Owned-mode recovery gate
  - 在所有 load/resume 入口前置 runtime-control recovery gate。
  - gate 必须验证 `runtime-control/upgrade.json`、checkpoint commit marker、真实 heads 和 effect evidence。
  - 缺 upgrade marker 的旧 session 由 TUI/CLI upgrade entry 处理；runtime 内部不自动升级。
  - dirty/orphaned/pending blockers 必须返回明确错误，不进入 VM recovery。

2. Engine-owned checkpoint save
  - Runtime save path 只提交 checkpoint payload 给 composer/runtime-control engine。
  - Conversation、actor transcript、runtime snapshot、manifest 等 concrete writes 只能作为 support effect 运行。
  - Cohort marker 是 save 成功的唯一一致性完成证明。
  - checkpoint cohort commit 成功后，由 runtime-control composer 同步 `runtime-control/upgrade.json` 到当前 checkpoint marker 与 head sequences，确保已升级或新 owned session 的后续 load/resume 不因 marker 过期被拒绝。
  - 非 safepoint 状态必须缓冲或拒绝 checkpoint，不得写出可误恢复的半状态。

3. Effect lifecycle ownership
  - Provider/tool/MCP/bash/permission/questionnaire/async completion 事件通过 runtime-control facade 进入 effect lifecycle。
  - Executor、coordinator、support helper 不直接写 runtime-control evidence 文件。
  - Long-running 或 permission-intercept effect 必须有 waiting/pending 状态，恢复时可分类。

4. Projection and journal boundary
  - Derived indexes 保持 projection/cache：恢复后可 refresh，不能阻止 clean checkpoint recovery。
  - Ingress/diagnostics 保持 journal sink：用于排查，不被 checkpoint safepoint 管理。
  - Session upgrade 不迁移 journal sink；旧 `logs/*` 审计/诊断日志保留原格式作为排障材料，不作为恢复事实源、checkpoint head 或 legacy residue。
  - 文档和 tests 明确这两类不是 gap。

5. Remove old bypasses
  - 删除或封闭 shadow recovery/save 的生产入口。
  - 移除兼容 shim、旧 direct writer owner、旧 evidence writer owner。
  - 测试中需要旧数据时，通过 fixture/upgrade API 准备 owned checkpoint，而不是增加兼容分支。

6. Conformance and real-session validation
  - 固化历史 incident cases：unpaired tool output、duplicate human input、removed handler、multi-head mismatch、late completion scheduling、start_tool half-step。
  - 使用已升级真实 session 作为 smoke fixture，验证 dry-run clean、load/resume 不立即停止。
  - 增加 internal bypass tests：直接调用 lower-level recovery API 也不能绕过 owned-mode gate。

7. Runtime checkpoint/evidence semantic cut
  - 最新现场表明，故障源不是“加载时把 session 变脏”，而是正常运行中 checkpoint 取样、具体文件写入与 effect evidence append 之间缺少同一个语义 cut。
  - `wait_llm` / `wait_tool` 等 suspended safepoint 是可恢复边界，但不是自动冻结边界。checkpoint 进入写入窗口后，如果 LLM/tool completion 到达并追加 evidence，旧取样的 runtime snapshot 会落后于 evidence。
  - Runtime-control engine 需要把 checkpoint 视为 prepare/commit 协议：prepare 时记录本次 checkpoint 覆盖的 runtime-control WAL cursor；writer-window 内追加的 LLM/tool evidence 属于 WAL tail，不能触发 `runtime_checkpoint_effect_drift` 拒绝 checkpoint，也不能纳入本次 checkpoint prefix。
  - 诊断层需要在 `logs/diagnostics.xnl` 追加 runtime checkpoint 事件，记录 safepoint 判断、保存开始/完成/跳过/漂移原因，辅助区分“恢复读取到脏数据”和“运行中写出了非语义 cut”。
  - CLI 需要提供 headless 恢复指定 session id 并发送输入的能力，以便不用 TUI 人工点击即可复现实验历史现场。

8. Explicit runtime state boundary
  - Runtime-control engine state MUST expose persistence/recovery governance through `state.runtime.persistence` and `state.runtime.recovery`.
  - Top-level `state.effects` / `state.heads` / `state.cohorts` / `state.recovery` are forbidden so storage/recovery state cannot be mistaken for main AI runtime state.
  - `state.runtime.persistence` owns checkpoint/effect/head/cohort facts used by recovery classification. It is not part of the live VM/actor state that drives model/tool execution.
  - `state.runtime.recovery` owns only recovery classification and blockers derived from persisted facts. Runtime execution must not stop because projection/journal-only writes advanced independently.
  - Concrete file-store append/write helpers stay behind runtime-control composer/support. Organ runtime code may request lifecycle records through composer facade, but must not directly append runtime-control evidence.

## 影响范围与修改点（Impact）
- `cell/packages/ai-organ-logic/src/persistence/RuntimeSnapshots.ts`
  - load/resume 前置 owned gate，save path 使用 composer checkpoint API。
- `cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts`
  - 确保 effect lifecycle 只通过 runtime-control facade。
- `cell/packages/ai-runtime-control-composer`
  - 按需补充 runtime-level facade，避免 organ 层拼接底层 file-store 细节。
  - checkpoint save 成功后维护 owned checkpoint metadata，保留上一 checkpoint marker 作为 previous marker。
- `cell/packages/ai-runtime-control-logic`
  - 按需补齐 recovery classification 和 conformance helpers。
- `terminal/packages/tui` / `terminal/packages/cli`
  - 保持 upgrade entry 回归测试，确认生产恢复入口不再要求用户切 CLI。
  - 增加 headless `--session` resume 能力，用于自动加载指定 session id 执行回归实验。

## 决策摘要
- 本 track 不创建新 vendor 原语；使用已有 `depa-actor` / `depa-actor-control` / `ai-runtime-control-*`。
- Owned checkpoint 是恢复事实源；旧 session 必须显式 upgrade。
- 不保留兼容 API、shadow production fallback 或脏数据静默接受逻辑。
- Derived indexes 和 journal sinks 不升级为 checkpoint cohort authoritative heads。
- Session upgrade 跳过 journal sink conversion；journal sink 的存在不能触发重复升级，也不能改变 recovery classification。
- Effect lifecycle evidence 不是 diagnostics journal sink。它属于 runtime-control 恢复事实，必须被 checkpoint/recovery 协议显式管理，不能与 `logs/ingress.xnl` / `logs/diagnostics.xnl` 混为一类。
- Runtime-control state 使用显式子对象边界：`runtime.persistence` 管理持久化事实，`runtime.recovery` 管理恢复分类；顶层 control state 只保留 command kernel。
- `runtime_checkpoint_effect_drift` guard 已被否决；checkpoint 通过 logical cursor 表达语义 cut，WAL tail 留给 replay/diagnostics。

## 风险 / 权衡
- 风险：一次性关闭旧 fallback 可能暴露更多历史脏 session。
  - 缓解措施：TUI/CLI dry-run/apply 已存在；dirty session 明确报 blockers，后续 repair track 处理。
- 风险：runtime 内部测试依赖旧 shadow 行为。
  - 缓解措施：测试 fixture 先升级为 owned checkpoint，或者显式测试拒绝旧状态。
- 风险：organ 层仍有隐藏 direct writer/evidence import。
  - 缓解措施：增加 import-scan tests 和 code search gate。

## 兼容性设计
- 这是有意的破坏性迁移：生产 load/resume 不再静默支持未升级旧 session。
- 用户迁移路径是 TUI session picker 或 CLI `session-upgrade`。
- 已升级 session 保持现有会话文件布局，只新增 runtime-control owned metadata。
- 不删除已有 conversation/transcript/snapshot 文件格式；它们从事实源 owner 变为 support/projection 数据。

## 迁移计划
1. 补充 owned-mode gate 和 bypass failing tests。
2. 切换 load/resume 到强制 owned checkpoint gate。
3. 切换 save/checkpoint 到 engine-owned path，并删除 shadow production fallback。
4. 扫描并移除 direct evidence/direct writer owner 入口。
5. 固化历史 incident + upgraded real-session conformance tests。
6. 运行 runtime recovery、snapshot safepoint、composer、TUI/CLI upgrade 相关测试。

## 待解决问题
- 是否需要提供专门的 repair track 来清理 dirty/orphaned 历史 session。
- 是否需要在 release notes 或 TUI 文案中说明 “升级后不可降级” 的操作含义。
