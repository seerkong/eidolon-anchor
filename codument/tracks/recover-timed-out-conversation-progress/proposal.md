# 发现记录：history.xnl 冻结是「turn 不收口」的后果，非独立 bug（recover-timed-out-conversation-progress）

> 状态：**仅记录发现，不实现**。本目录只保留本 `proposal.md` 与 `analysis/`（已删除 behavior_deltas / design.md / decisions.md / track.xml）。结论：当前不立 track 去做 seal 创可贴；真正的根因在「单轮不收口」（另查）。

## 问题与机制（代码 + 真机双证）

内存对话域每完成一对就涨（`appendLiveHistory`，每个工具结果 +2），但 `history.xnl` 只在 safe checkpoint 落盘。

这是设计如此——不能在工具执行中/等结果时快照「不安全的 in-flight 状态」（P8 不变量）。落盘本应在 turn 收口（fiber idle、不再 wait）时发生。

而这个 turn 不收口（repeat-read），fiber 永远在 `wait_llm` ↔ `wait_tool` 之间循环，永远 `mandatory_continuation` → 永远 unsafe → 永远不落盘 → `history.xnl` 冻在 `messageCount=1`。

## 证据（真机插桩，探针已移除）

- 落盘由 safepoint 门控：`saveSnapshotAfterProgress`（`AiAgentRuntimeCoordinator.ts:162`）每个 tick 后评估 `evaluateAiAgentRuntimeSnapshotSafepoint`；`!safe` 时直接 return、不落盘（`:181`）。
- safepoint unsafe 的条件：任一 fiber 处于 live async wait（`wait_llm`/`wait_tool`）或 mandatory runnable 阶段（`cell/packages/ai-runtime-control-logic/src/index.ts` `evaluateAiAgentRuntimeSnapshotSafepoint`）。
- 真机重跑真实 session：turn 期间每次 safepoint 评估均 `safe=false`、blocker 全是 `mandatory_continuation`（phase=`wait_llm`/`wait_tool`）；`saveSnapshot`（落盘）**执行 0 次**。
- 同时内存对话域经 `materializeConversationRuntimeMessagesFromVm` 正常涨到 24+ 条、模型能看到完整历史与真实工具结果。

## 结论与决定

- **history.xnl 冻结 = 非收口的症状，不是独立 bug。** turn 正常收口（fiber idle）时 safepoint 会 safe、正常落盘。
- 「超时 seal + 恢复门 forward-only 容忍」是**治标的创可贴**（只让跨 exec 续跑接力，不让 turn 收口）。当前**不实现**它。
- **根因在单轮不收口**：模型拿着完整上下文仍重读、且每条 assistant 文本为空（`lastAsstText=""`）。下一步治本方向是查 `lastAsstText=""`——模型是否产出了文字/推理却被运行时丢弃（疑似 codex/Responses adapter 对 content/reasoning 的处理，类似已修的 tool_calls `[DONE]` bug）。详见 `analysis/findings.md`。
