# 变更：修复 TUI 有效模型优先级

## 背景
当前 terminal TUI 的模型选择状态被拍平成 `agent/provider/model`，导致模型 dialog 人工选择、启动参数、agent 默认、runtime 历史投影、配置默认和 recent model 之间缺少明确优先级。结果是用户在 dialog 中切换模型后，input 底部状态条可能仍显示旧模型，或者后续同步逻辑把人工选择覆盖掉。

## 变更内容
- 引入 source-aware 的模型候选与 effective model resolver。
- 明确有效模型优先级：`user-explicit > cli-arg > agent-memory > agent-default > runtime-config > recent > provider-default`。
- 让模型 dialog 的人工选择写入最高优先级来源。
- 让 runtime 历史投影成为低优先级候选，而不是直接覆盖当前 selection。
- 让 composer/input 底部状态条展示 effective model resolver 的结果。

## 不做范围
- 不改变 provider adapter 的请求协议。
- 不改变 agent definition 的模型字段含义。
- 不在本 track 中新增模型选择持久化策略之外的偏好管理 UI。

## 影响范围
- 受影响规范：`terminal-tui-shell`
- 受影响代码区域：
  - TUI graph selection projection
  - TUI local context model resolution
  - 模型 dialog 提交逻辑
  - composer/input 状态条展示
  - TUI selection 相关测试
