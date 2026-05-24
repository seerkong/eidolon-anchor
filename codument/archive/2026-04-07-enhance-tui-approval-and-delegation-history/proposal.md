# 变更：增强 TUI 审批历史与 delegation 展示

## 背景

当前 prototype 已经有可工作的 approval pane，也已经沉淀出 delegation、question 与 task tree 专用卡片，但这两类能力仍停留在断开的状态：

- approval 完成后，历史区缺少结构化回显，用户无法回看审批决策本身
- delegation、question 与 task tree 卡片尚未进入当前主界面
- 如果 approval history 和 delegation/question 分开推进，会重复整理历史语义、消息投影和导航一致性

把它们合并为一个 track，可以统一定义“活动请求由 pane 承担，完成请求与编排结果由历史区承担”的展示边界。

## 合并来源

- `enhance-tui-approval-history-and-summaries`
- `add-tui-delegation-and-question-cards`

## 变更内容

- 为 permission 和 question 补充历史摘要卡片或历史行
- 保持 approval pane 负责活动请求，历史区负责已完成请求
- 明确并补强 approval/question 的交互式回复能力，包括 permission 的 allow once / allow always / reject，以及 questionnaire 的选项选择、多题切换、自定义答案、提交和 reject
- 统一 approval summary、question answers 和 delegation 历史的展示语言
- 接入 task、question、tasktreewrite、tasktreeread 专用卡片
- 为 delegation 历史和问卷结果提供结构化展示
- 保持与 approval/history/session navigation 的交互一致性

## 影响范围

- 受影响的规范：`terminal-tui-shell`
- 受影响的代码：approval pane、approval summary、question reply 交互、消息历史投影、question card、delegation card、task tree card、相关导航入口

## 顺序依赖关系

- 建议序号：`3`
- 建议前置：
  - `add-tui-coding-tool-part-cards`
  - `add-tui-input-and-material-state-foundations`
- 建议后续：
  - `polish-tui-status-and-guidance-surface`
- 说明：approval 历史、交互式 question/permission 回复，以及 delegation/question 卡片都依赖结构化消息区、输入链和共享状态层稳定后再接入，这样可以一次收敛活动请求、历史语义和交互规则
