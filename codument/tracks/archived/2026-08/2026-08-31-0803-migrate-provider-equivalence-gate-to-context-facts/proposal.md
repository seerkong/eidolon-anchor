# 变更：把 provider equivalence gate 迁移到 typed context facts

## 背景和动机 (Context And Why)

Provider context 已从固定 system overlay 迁移为 Conversation authority 中按时间顺序追加的 typed user fact，但历史等价门禁仍把迁移前 wire shape 当成当前精确形状，导致正确的生产输出被判为回归。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**

- 保留旧 golden 对稳定 system prefix、历史消息和 tool pair 的回归价值。
- 显式验证旧 overlay 与新 typed fact 的语义迁移关系。
- 只为合法 machine context fact 放行相邻 user 边界，继续拒绝普通相邻 user 和 malformed/duplicate facts。

**非目标:**

- 不重新录制或覆盖旧 golden。
- 不改变生产 Conversation materialization、provider role profile 或 context-fact schema。
- 不放宽 tool-call/tool-result 配对规则。

## 变更内容（What Changes）

- 为测试 harness 增加 legacy overlay 与 typed fact 的受限迁移投影。
- 更新 equivalence gate，使非迁移消息继续精确比较。
- 增加 shape invariant 正反例与 context-fact 迁移断言。

## 影响范围（Impact）

- 受影响的能力（behaviors）：`ai-semantic-conversation-spine`
- 受影响的代码：`cell/packages/ai-organ-logic/tests/AIAgent/conversation/`
