# Design：iQingwa Autonomous AI Data Convergence

## 运行链路

live runner 从本机 provider catalog 精确解析 `deepseek-iqingwa/deepseek-v4-pro`，直接构造 `ProviderRuntimeLlmAdapter(providerId="deepseek-iqingwa", adapter="deepseek")`，并用 `processRuntimeIngressStream` 作为 Agent callback。这样 Controller/Worker 仍走 `DelegateActor → AiAgentExecutor → provider retry/recovery → Conversation`，而不是测试代码调用 HTTP 或返回 JSON。

ResourcePackage 沿用 G4 的 `MessagePrefix + ContextPipeline + EffectPolicy + MaterialBinding`。Controller payload 是闭合的 `goal + catalog + observation`；模型输出只能通过 schema normalization 与 admission 后进入 canonical checkpoint。

## 两个 proposition

1. `construct-value`：初始图没有实现路径；verifier 接受任意合法的非空 Worker value，证明从 outcome 构图。
2. `repair-after-verifier-gap`：第一代合法输出仍不满足 verifier；verifier 只暴露结构化 failure facts。第一轮 patch 后保存完整 runtime snapshot，fresh runtime 继续；同一 Controller 产生第二个不同 patch，同一 Worker targeted 执行后收敛。

两者共享 Controller/Worker resources 与 protocol，不允许按 proposition id 分支。verifier identity/digest 在各自 run 内不可变。

## 证据

- G4 sealed receipt 的 source、goal/verifier/catalog、generation/patch、raw decision/admission、Agent invocation identity；
- provider request/outcome ledger，包含真实 provider/model、attempt、terminal cause；
- provider cache observation：prompt/cache hit/miss/output tokens、context epoch、prefix integrity；
- crash 前后 checkpoint、instanceId/sessionId continuity；
- 无 credential、request body 或 Conversation 内容进入报告。

Cache observation 在 recovery 前后分段读取，按 provider transport 顺序关联具体 actorId，并只在同一 actorId、actor class 与 context epoch 内比较。Controller 与 Worker 的不同稳定前缀不能互相比较，恢复后的投影也不能与恢复前样本重复拼接。

自主控制期的局部 Agent 输出/执行异常属于 verifier 可观察、Controller 可修复的节点失效，canonical node 记为 `Invalidated` 并停止本次 data advance；只有控制循环显式失败才把整个 run 置为 `Failed`。非自主 workflow 仍沿用执行异常即 `Failed` 的原语义。

`live-provider/v1` 只有在 transport facts 确认 provider/model 且 verifier/conformance/reuse invariants通过时才能 seal。失败运行保留为纠偏输入，不能伪装成成功。
