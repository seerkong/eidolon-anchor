---
knowledge_system: impl
knowledge_plane: runtime
doc_role: reference
status: active
last_verified: 2026-08-30
---

# AI Data Workflow 自主控制闭环

Eidolon 的 AI Data Workflow 已具备一条可验证的自主控制链路：预制且冻结的 `AIAgentDefinition` 提供 Controller/Worker 角色，类型化 Goal、Observation、Decision、PatchAdmission 与 IterationReceipt 作为数据流契约，canonical checkpoint/graph 是唯一图状态权威。模型产出的 Decision 只是一份提案，只有通过 admission 后才能生成下一代图。

Controller 与 Worker 的外部实例和 Conversation session 可跨 graph generation 与进程恢复复用。恢复时从持久 checkpoint 中读取 actor index，通过 durable selector 定向回到原实例；不得创建 fallback Agent、第二份 shadow graph 或用 fixture 内置修复答案。

DeepSeek Chat transport 会为每个已发送 request 记录恰好一个 terminal outcome。request-time correlation 在发送边界冻结，异步 outcome 不读取之后可能变化的 runtime 字段。completed、failed、aborted、incomplete 四类终态均纳入观测；结果记录只用于 observation，不能反向改变 provider 执行。

真实 iQingwa `deepseek-v4-pro` 验证包含两个不同命题：一个从无效初始图自主构造并收敛，一个由不变 verifier 触发多轮修补并在中途恢复。权威 v2 收据分别记录 4/7 个 request-outcome attempt、4/7 个 cache observation、2/5 个非空 prefix comparison，prefix integrity 均为 1；修复命题保留同一 Controller/Worker instance 与 session，并以三次不同 admitted patch 收敛。

维护时应同时验证：当前 runner 源码 digest 与收据绑定、attempt ledger 可独立重算、cache observation 覆盖所有 provider calls、prefix comparison 非空、非法 decision 不改变 authority、普通非 autonomous 节点异常仍以 `Failed` 结束。可执行行为真源位于 `codument/behaviors/ai-data-workflow/behavior.xnl`、相关源码与测试；完整历史证据位于归档 Track `2026-08-30-0324-validate-iqingwa-autonomous-ai-data-convergence`。
