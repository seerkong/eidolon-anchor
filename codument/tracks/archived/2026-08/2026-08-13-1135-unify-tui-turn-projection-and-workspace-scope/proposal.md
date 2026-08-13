# 变更：统一 TUI turn 投影并收紧 workspace 访问意图

## 背景和动机 (Context And Why)

现场会话暴露了三个同根交互问题：questionnaire continuation 丢弃 runtime 的 typed category，把 turn/tool/result 输出塞进 assistant；durable resync 与 live tool observation 使用不同随机 identity，造成重复卡片；tool/system history 被错误投影为 USER，使 `<context-resource>` raw wrapper 直接占据用户卡片。同时，文件工具把模型误传的父目录当成外部授权目标，诱导用户授予过宽权限。

## “要做”和“不做” (Goals / Non-Goals)

**目标:**

- prompt、slash command、questionnaire continuation 复用同一 turn surface projector。
- live observation 与 durable history 通过稳定 identity reconciliation，不新增 domain authority。
- exhaustive-map conversation roles，并以结构化 context/read 卡片显示 context resource。
- 文件工具默认 workspace scope，外部访问必须显式声明，并提供最小权限 grant mode。
- 用测试冻结三入口等价、单工具卡片、role projection、context card 和父目录不授权。

**非目标:**

- 不改变 provider adapter、ToolCallDomain 或 actor runtime 的执行语义；不建立新的 conversation persistence authority（允许在既有 committed tool message codec 上增加可选 typed projection metadata）。
- 不为 DeepSeek、OpenAI 或具体模型建立分支。
- 不使用 raw XML/path/natural-language 的模糊匹配来决定路由。
- 不修改 AI workflow authoring/runtime 能力。
- 不重新设计完整 TUI 视觉系统；只修复投影数据与必要的 context/grant 呈现。

## 变更内容（What Changes）

- 抽取 TUI turn surface projector/state owner，替代三份流式 assistant/tool 投影逻辑。
- 为 conversation history 建立稳定的 message/tool projection identity 与增量 reconciliation。
- 修复非 assistant 全部回退 USER 的逻辑；tool 重建 ToolPart，system/internal 隐藏或 diagnostic。
- 从 tool/runtime 边界传递 context resource metadata，经既有 committed conversation codec 持久化，并渲染可冷启动恢复的折叠 context/read 卡片。
- 为本地文件工具 schema 与 permission evaluator 增加 `scopeIntent`；workspace 越界 fail closed，external 才进入 grant。
- 将 external grant 分为 one-time read、persistent read、persistent read-write advanced 与 deny。

## 影响范围（Impact）

- 受影响的能力（behaviors）：runtime-projection-surfaces、tui-questionnaire-continuation、progressive-context-resource-loading、local-coding-tool-permission-controls
- 受影响的代码：`terminal/packages/tui` 的 runtime client/data/card projection；`cell/packages/ai-organ-logic` 的文件工具 schema、permission evaluator/runtime 与 context resource metadata；`shared/composer`、`ai-organ-contract`、`ai-support` 既有 committed message codec 的可选 metadata 字段；对应测试。
