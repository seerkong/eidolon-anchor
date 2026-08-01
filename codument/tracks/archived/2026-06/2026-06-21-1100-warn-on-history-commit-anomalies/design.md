## 上下文
单写者（唯一水源）= 正确设计，保留。缺陷是"失败时静默"。在单写者不变量边界加两处告警，经事件通道外溢、宿主记录。约束：不加兜底写者、不改提交内容、不抛错、reducer 保持纯。决策见 decisions.md（D1 告警走既有 listener 事件通道；D2 观测-only；D3 reducer 内已见-id 集合判孤儿）。

## 方案概览
1. 告警外溢通道（D1）
  - 新增结构化 anomaly 事件类型（含 `kind: "anomaly"` / reason: `"orphaned_tool_result" | "hollow_assistant_commit"`、`tool_call_id?`、`agentKey`/`agentActorId`），经既有 `emit`/listener 通道外溢；reducer 仍是纯函数（只产出事件，不做副作用）。
  - 宿主接入点（executor 现有 consumer/committed-listener 邻近处）订阅 anomaly 事件 → `console.warn` 结构化一行 + 可选诊断记录。
2. 孤儿工具结果（D3）
  - reducer 投影状态加"已见 tool_call_id 集合"：`semantic_tool_call_start/_planned` 与 pending/已提交 assistant 的 toolCalls 写入集合。
  - `semantic_tool_call_result` 处理时若 id 不在集合 → 外溢 orphaned_tool_result 告警；**仍按现状提交** tool 消息（不改行为）。
3. 空壳提交
  - `flushCommittedAssistant` 提交前：若 pending 的 content、reasoning、toolCalls 全空 → 外溢 hollow_assistant_commit 告警；**既有提交行为保持不变**。

## 影响范围与修改点（Impact）
- `cell/packages/ai-core-logic/src/stream/MessageHistoryGraph.ts`：anomaly 事件类型 + 已见-id 集合 + 两处检测点外溢。
- 宿主接入点（最小）：订阅并记录 anomaly 告警。

## 决策摘要
- 详见 decisions.md。D1 既有事件通道外溢；D2 观测-only（warn+continue、不改提交、不加写者）；D3 reducer 内已见-id 集合。

## 风险 / 权衡
- 误报（正常配对/非空壳却告警）→ 缓解：明确判定（孤儿=未见 id；空壳=三者皆空）；加"正常路径不告警"反例。
- 噪声（合法但少见的空壳/重放）→ 缓解：仅在确属异常时告警；保持结构化、低频。
- 破坏 reducer 纯度 → 缓解：只产出事件、绝不在 reducer 内做 I/O。

## 兼容性设计
- 纯增量可观测；不改提交内容、不改恢复/回放路径、不动 executor 门控；旧行为完全保留。

## 迁移计划
- P1 孤儿工具结果告警（含 anomaly 事件通道）— 先红测试。
- P2 空壳提交告警（复用通道）— 先红测试。
- P3 收口：全量回归（按名比对基线 0 net-new）+ 单写者不变量复核（无新写者/提交集合不变）+ findings 终态。
- 回滚：两处告警 + 通道独立，可逐阶段 git revert。

## 待解决问题
- 宿主记录的确切位置与诊断 sink 细节 — P1 实现期定（默认 executor 邻近 committed-listener 处 `console.warn`）。
