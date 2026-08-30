# Track：Autonomous AI Data Planning E2E

## 背景

G3 已把 provider-neutral control protocol 接入 Eidolon：Controller/Worker 可以从冻结的 Halfcode ResourcePackage 执行，图与控制状态在同一个 canonical checkpoint 中提交，Agent instance/session 可跨 generation 和 runtime recovery 精确复用。

现有测试仍由 fixture 直接返回预先写好的 patch，只能证明机械链路，不能证明 harness 没有代替模型规划。G4 要建立一个可复用的反作弊 E2E 层，严格分开两类证据：

- deterministic 运行只证明 observe → decide → admit → patch → execute → verify → recover 的机制；
- live autonomy 必须由后续 G5 的 iQingwa DeepSeek V4 Pro 运行证明，任何 scripted provider receipt 都不能冒充。

## 目标

1. 用冻结的 Controller/Worker `AIAgentDefinition`、`MessagePrefix`、`ContextPipeline`、schema 和 Effect policy 运行真实资源链路。
2. 用只含 goal、initial data、immutable verifier、capability catalog 和 budgets 的 proposition 输入执行两次不同 patch，并让第二次 patch 由上一代 verifier failure 触发。
3. 注入一次无效 decision，证明反馈被持久化而 graph authority 完全不变。
4. 在第一轮 patch 后恢复 fresh runtime，证明 Controller/Worker 都是 exact targeted reuse。
5. 生成绑定 source/runtime facts 的 sealed receipt，并对隐藏答案、第二份 graph、fallback new、identity/digest 篡改 fail closed。

## 非目标

- 本 Track 不把 deterministic planner 当作模型自治证据。
- 本 Track 不运行或调优 iQingwa provider；真实模型运行属于 G5。
- 本 Track 不新增 graph store、Conversation store、provider SDK loop 或 proposition-specific repair API。
- 本 Track 不允许测试代码绕过 `AIDataAutonomousControlRunner` 直接调用 canonical patch transition 来形成成功证据。

## 验收

- focused E2E 产生至少两个不同 patch digest、同一 goal/verifier digest、一次 invalid-decision feedback、最终 PASS。
- recovery 后 Controller 和至少一个 Worker 的 later invocation 都是 `targeted`，且 instanceId/sessionId 与首次 `new` 完全一致。
- sealed receipt verifier 能检测 source digest、patch digest、generation、verifier digest、instance/session 的任何篡改。
- source conformance 能检测 fixture/harness 中的 proposition answer、fallback create、graph shadow 或 direct patch bypass。
- focused tests、focused typecheck、Track/Mission strict validate 通过。
