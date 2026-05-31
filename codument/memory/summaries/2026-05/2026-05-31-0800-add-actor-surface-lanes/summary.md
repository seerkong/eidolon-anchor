# Summary: add-actor-surface-lanes

Memory URI: memory://summaries/add-actor-surface-lanes
Source: archive://2026-05-31-0800-add-actor-surface-lanes

# 变更：Actor Surface Lanes 与全局 Questionnaire 基础设施

## 背景和动机 (Context And Why)
当前项目已经有 member/holon、primary/delegate/detached、fiber orchestration 和结构化 questionnaire，但 TUI 仍缺少一个统一的 actor surface。现有 lane 更多服务于 member/holon 调度语义，而不是用户可选择的前台对话泳道。delegate 触发 questionnaire 时，也可能因为 pending 状态局限在局部 actor 或被投影过滤而没有进入 TUI 前台，导致运行看起来卡住。

Sparrow actor-team 的可借鉴点是：把 UI 前台 lane、真实 runtime actor、backend capability identity 拆开，再把 questionnaire 作为 runtime-global pending queue 处理。本 track 将把这个模式落到本项目的 member/holon/primary 模型里。

## “要做”和“不做” (Goals / Non-Goals)
**目标:**
- 新增 actor surface projection：`conversation_lanes`、`actor_lanes`、`backend_identity`。
- 支持配置 `lane:primary` 的 backend identity，且不把 primary foreground 与 member/holon lane 混淆。
- 建立 runtime-global questionnaire queue，使 delegate/member/holon/child fiber 的审批都能在 TUI 可见并按 owner 路由恢复。
- 在 TUI 底部新增 `[Actor列表]`，移动 `[使用说明]` 到 `[功能菜单]`。
- Actor 列表支持切换查看 actor 历史、取消指定 actor 的 LLM 请求、向指定 actor 发送人工消息并继续运行。
- 通过 shell/runtime facade 暴露这些能力，避免 TUI 直接散读 runtime internals。

**非目标:**
- 不重写 member/holon 正式对象模型。
- 不把现有 scheduler lane 重命名为 conversation lane。
- 不实现完整 Web actor-team UI；本 track 以底层基础设施与 terminal TUI 消费为主。
- 不承诺恢复旧 session 中缺失 owner metadata 的历史 questionnaire。
- 不引入长期的 UI 侧 actor 真相源。

## 变更内容（What Changes）
- 新增 actor surface contract，包含 conversation lane、actor lane、backend identity、selected target、questionnaire surface。
- 新增或收紧 runtime facade ports：构建 actor surface、按 lane/actor 提交人工消息、按 actor 取消 active turn、按 questionnaire id 回复。
- 将 pending questionnaire 从局部 actor/control mailbox 可见性提升为 runtime/session 全局 projection，并记录 owner actor/fiber identity。
- 修改 TUI hydrate 与 questionnaire center，使其消费全局 questionnaire surface。
- 修改 TUI bottom bar：`[使用说明]` 进入 `[功能菜单]`，新增 `[Actor列表]`。
- 新增 Actor list dialog，复用现有 DialogSelect/DialogProvider 风格，支持查看、切换、取消、人工发送消息。
- 增加 focused regression tests，覆盖 delegate questionnaire 可见/可答、actor scoped cancel、primary backend identity 保持、底部菜单入口。

## 影响范围（Impact）
- 受影响的功能规范：
  - `aiagent-questionnaire`
  - `aiagent-member-holon-primary-model`
  - `terminal-tui-shell`
  - `shell-runtime-facade-ports`
  - `aiagent-fiber-orchestration`
  - `detached-actor-observability`
