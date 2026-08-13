# 变更：强化 AI Workflow Agent Runtime

## 背景和动机 (Context And Why)

真实 AI Workflow session 暴露出一条复合失败链：provider timeout 被转换为 delegate completed，父 actor 从非权威 message mirror 得到空输出；并行同名工具调用被 stream reducer 拼接；缺少进展和阶段预算让无产物循环持续十余分钟。这些问题会使任何 workflow Skill 的产品行为都不可靠。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**

- 让 provider failure、fiber terminal state、child-done 和 parent tool result 保持一致失败语义。
- 从 Conversation Domain materialize delegate 结果并拒绝空成功。
- 正确重建并行同名 tool calls，对 provider contract 缺陷 fail closed。
- 为 workflow actor 增加阶段级进展和交互延迟预算。
- 为 authoring/run actor 增加显式、非空的 stage outcome 与有界 proof-repair loop，禁止开放式探索直到 provider 自己超时。
- 统一 authoring 四挂载 VFS 的空目录与错误诊断行为。

**非目标:**

- 不在本 track 定义自然语言语义或 workflow form 选择规则。
- 不把 provider-specific workaround 扩散到 shared stream core 之外的业务代码。
- 不以减少验证步骤换取速度。

## 变更内容（What Changes）

- 修正 delegate provider failure 的 terminal kind 和 parent propagation。
- 修正 orchestrator-managed child output 的事实来源。
- 强化 Chat Completions parallel tool-call identity 聚合及 provider contract diagnostics。
- 增加 workflow high-level tool 的非空完成契约、progress proof 和 stage deadline。
- 将每轮进展限定为 workspace revision、proof、publish/run transition、durable wait 或 structured failure/result，并限制 correction/repair 轮数。
- 修正空 `/base`/`/refs` mount 与 operation diagnostics。
- 增加事故 replay、provider timeout、same-name parallel calls 和 no-progress E2E。

## 影响范围（Impact）

- 受影响的能力（behaviors）：`eidolon-ai-workflow-native-capability`
- 受影响的代码：AiAgentExecutor、orchestrator driver、DelegateActor、Chat Completions adapters/reducer、provider retry policy、WorkflowFulfill、authoring session VFS、相关 tests

## 研究结论

- KWF 没有可直接照搬的通用 actor deadline，但其产品旅程是有限阶段：结构化生成、独立输入推断、确定性 write/validate/dry-run、review、apply/start；空 `workflow_source` 立即失败，真实模型 E2E 也要求有界失败而非挂起。
- Eidolon 应沿用这一有限阶段思想，但保持 native tool actor：每个模型轮必须产生可观测 stage outcome，proof repair 有显式轮数和 deadline，上层 deadline 约束 provider retry。
