# 变更：对话历史单写者的不变量告警（warn-on-history-commit-anomalies）

## 背景和动机 (Context And Why)

刚修复的 codex Responses-adapter `[DONE]` 丢工具调用 bug（commit `f12e72c`）暴露了更深的脆弱：活跃 turn 内对话历史是**单写者**（vm 常驻 `MessageHistoryGraph`），且唯一写者在异常交互时**静默吞掉**——这正是同一个 bug 反复重读不收口、却要跨多个 session 才定位到的原因。

**"唯一水源 / 单写者"是核心正确设计，必须保留**——加兜底写者会掩盖故障、积技术债。问题不是"无兜底",而是"失败时不出声"。唯一水源的架构红利恰恰是：不变量只在一处，故可在该处断言、违反就告警、快速定位。本 track 就做这件事：在单写者的不变量边界加**两处失败即出声**的告警。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**
- **孤儿工具结果告警**：消费到 `semantic_tool_call_result` 但其 `tool_call_id` 无配对 assistant 工具调用时，产生可观测、非致命告警。
- **空壳提交告警**：`flushCommittedAssistant` 即将提交 content/reasoning/toolCalls 全空的 pending assistant 时，产生可观测、非致命告警。
- 告警经事件/可观测通道外溢（reducer 保持纯），宿主记录，可 grep 快速定位。

**非目标:**
- **不**新增兜底/冗余写者（保留唯一水源）。
- **不**改变实际被提交的消息内容、**不**改 executor 活路径门控、**不**抛错中断 turn。
- **不**在纯 reducer 内做副作用日志。
- **不**修复其它 adapter（Fix 1 已单独完成）；**不**改 prompt 构建 / domain truth owner。

## 变更内容（What Changes）
- `cell/packages/ai-core-logic/src/stream/MessageHistoryGraph.ts`：
  - reducer 内维护"已见 tool_call_id 集合"；`semantic_tool_call_result` 的 id 不在集合内 → 孤儿 → 外溢告警事件。
  - `flushCommittedAssistant` 提交前检测空壳（content/reasoning/toolCalls 全空）→ 外溢告警事件。
  - 新增一类结构化 anomaly/warning 事件经既有 listener 通道外溢（与 `emit`/`emitCommitted` 同构）。
- 宿主侧（`AiAgentExecutor` 接入点）记录该告警（`console.warn` + 可选诊断），不改既有提交流。

## 影响范围（Impact）
- 受影响的能力（behaviors）：`conversation-history-commit-observability`（新增，正交可观测能力）。
- 受影响的代码：`cell/packages/ai-core-logic/src/stream/MessageHistoryGraph.ts`（核心）、其宿主接入点（`cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts` 记录侧，最小改动）。
- 相邻：单写者无声冻结的根因记录见 memory `repeat-read-root-cause.md`。
