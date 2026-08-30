# Mission：让 AI Data Workflow 自主执行控制论规划

## 背景

现有 AI Data Workflow 已经拥有 canonical run graph、GraphPatch、generation、invalidation、checkpoint、类型化 Agent 节点和 targeted Agent instance 复用。既有确定性 E2E 也证明了“generation 0 观测失败 → 外部代码提交 patch → generation 1 收敛”。

真正缺失的是控制侧自主性：当前 patch 由测试代码预先构造，AI 没有根据实际观测形成规划、选择 Agent、修改图并继续反馈循环。真实 iQingwa DeepSeek V4 Pro 三模式测试验证了执行、缓存和稳定性，但没有验证自主重规划。

## 目标

- 建立一个由预制 Halfcode `AIAgentDefinition` 驱动的 AI Data 控制 Actor。
- 用类型化 Goal、Observation、ControlDecision、GraphPatch 和 VerificationReport 契约连接控制节点与工作节点。
- 让控制 Actor 从 canonical run/checkpoint 和黑盒 verifier 观测中自主产生最小 GraphPatch；E2E harness 不得提供 patch 内容。
- 让控制 Actor 及至少一个工作 Agent 在 generation 间通过 `runTargetedAgent` 复用同一 instance/session，而不是每轮创建新 Agent。
- 支持“规划 → 执行 → 观察 → 纠偏 → 重规划 → 再执行”，并在恢复后继续同一控制循环。
- 使用真实兼容 DeepSeek 模型运行不止一个未知于控制器实现的命题，依据 live evidence 受控重规划和修复。

## 非目标

- 不复制 AI Data run graph、checkpoint、Agent registry 或 Conversation authority。
- 不允许测试代码、fixture 或 provider shim 代替模型生成具体 patch。
- 不把任意模型文本直接写入 graph；模型只提出 typed decision，canonical Processor 负责校验与 transition。
- 不为了单个 E2E 硬编码节点名称、patch 模板、修复答案或固定重试次数。
- 不把 Codument Mission runtime 嵌入 AI Data Workflow；只复用其控制论原则和可观测/重规划纪律。

## 为什么需要 Mission

目标跨越 depa-flows 的通用控制契约与 graph transition、Eidolon 的资源 Agent/runtime 绑定、真实 provider E2E、恢复与缓存观测。真实模型行为会暴露新的控制偏差，需要按证据创建修复 Track，而不是预先假定一条实现路径。Mission 只承担期望态、跨 Track 编排和反馈重规划；代码、行为、测试和资源实现全部落在真实 Track。

## 成功判据

1. E2E harness 只给出目标、初始材料和不可变 verifier；搜索与运行证据证明它没有携带 expected GraphPatch 或修复答案。
2. 至少一个真实模型运行从不完整初始图自主新增/更新节点，至少一次后续 verifier 反馈触发第二个不同的 patch，最终在同一目标下收敛。
3. 每个动态节点经过封闭 tag、typed input/output schema、frozen code/Agent binding 和 Effect policy admission；无任意代码、任意工具或任意资源引用注入。
4. controller Agent 与至少一个 worker Agent 跨 generation 保持相同 external instanceId/sessionId；首次 `runAgent`、后续 `runTargetedAgent` 的 receipt 可审计。
5. graph/checkpoint 是唯一 current authority；ControlDecision 是 proposal，只有 admission Processor 调用 canonical GraphPatch transition 后才改变事实。
6. 无进展、重复 patch、无效 patch、预算耗尽、deadline、abort 和恢复路径均 fail closed；控制循环有 generation/iteration/cost 上限，但不以模型偶发行为的固定重试次数冒充语义完成。
7. 至少两个不同命题在 deterministic 和真实 iQingwa DeepSeek V4 Pro 路径通过；其中至少一个从中途 checkpoint 恢复后继续收敛。
8. 真实运行记录 correctness、generation、patch history、invalidations、Agent reuse、provider failures、prefix integrity、token/cost 与 elapsed time；可复用前缀完整性为 1。
9. fresh 独立验证确认不存在预制 patch、隐藏普通模式 fallback、第二 graph authority、Agent instance 伪复用或仅靠一次幸运输出通过。
