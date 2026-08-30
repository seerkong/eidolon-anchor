# Track：iQingwa Autonomous AI Data Convergence

G4 已证明 provider-neutral mechanics，但 deterministic planner 不能回答用户关注的“AI Data Workflow 是否真的能自主使用控制论循环规划”。本 Track 使用配置中的 `deepseek-iqingwa/deepseek-v4-pro`，让真实 Controller/Worker `AIAgentDefinition` 走成熟的 Eidolon Agent、provider、Conversation、cache 与 recovery 链路。

runner 只提供 goal、initial input、frozen capability catalog、immutable verifier 和 budgets；不得脚本化任何 Agent 输出。至少运行两个不同 proposition，其中一个在第一轮 patch 后重建 runtime，并由 verifier failure 促成第二个不同 patch。所有成功必须由 canonical checkpoint 与 sealed receipt 共同证明。

若失败，只根据 provider/Agent/schema/admission/verifier/recovery 事实做 proposition-neutral 修复；不增加次数型 DeepSeek workaround，不把 verifier answer 塞进 prompt，不绕过 autonomous runner。
