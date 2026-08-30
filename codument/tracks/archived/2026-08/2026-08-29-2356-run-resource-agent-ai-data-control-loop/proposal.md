# Proposal：Resource Agent AI Data Control Loop

## Why

AI Data Workflow 已经能执行静态图、持久化 generation、应用 GraphPatch，也能通过 Eidolon effect 运行资源化 Agent；但这些能力尚未组成自主控制环。当前外部调用方仍要自己观察结果、构造 patch、再次推进，而且动态加入的 `nodeType: "agent"` 只带 `config.agent.{agentDefinitionRef, taskProofRef}`，现有 driver 不能执行它。

这不是增加一个智能封装器，而是把 provider-neutral 控制协议接到现有唯一 graph/checkpoint authority 上。模型是 planner，不是 state owner；Halfcode AIAgentDefinition 是可冻结的执行资源，不是另一个 workflow runtime。

## What

- 升级并消费已发布的 `ai-data-workflow-contract@0.1.6` 与 `ai-data-workflow-logic@0.1.12`。
- 在冻结的 StepSpace control step 上显式声明版本化 autonomous-control `ExtensionRef`；其 revision fact 与 graph patch、控制游标、verifier、feedback、admission 和 receipt 由 canonical checkpoint 的一个 CAS transition 原子提交。
- 用显式 `controlNodeId` 建立受保护 terminal barrier。普通 graph advance 不得完成它；只有当前 generation 的 host-owned verifier PASS 与 admitted `complete` decision 才能释放。
- 让动态 Agent 节点按 `taskProofRef` 解析 frozen MaterialBinding，并校验 workflow/ref/node/AgentDefinition 四元组；proof 缺失或不一致时在 provider dispatch 前失败。
- 新增一个小型 `AIDataAutonomousControlLoop` 协调 `project observation → run/target controller → admit decision → commit transition → advance → verify`，不保存 graph 副本。
- Controller/Worker 采用具名实例：第一次 `runAgent`，后续严格 `runTargetedAgent({byId})`。durable index 缺失、损坏或 definition 不一致时 fail closed，不退化为新实例。
- 用 RED/green 测试覆盖 barrier、proof、无效决策、stale generation、原子 crash window、恢复和精确复用。

## Out of scope

- 不在本 Track 中编写 proposition-specific patch、repair answer 或 live DeepSeek fixture；它们属于 G4/G5。
- 不修改 provider 的 Conversation/session authority，不新增 provider retry loop。
- 不新建第二份 graph/control database，不让 event log 成为恢复真源。
- 不把 verifier PASS 交给 Agent 生成，也不以 node name 推断控制节点。
- 不声明完整自主规划已经验证；本 Track 只交付通用 runtime mechanics。

## Acceptance

1. 冻结定义中显式指定的 control barrier 在普通节点成功后仍保持 run 非终态；仅当前 verifier PASS + admitted complete 能在同一 checkpoint transition 中释放。
2. admitted Agent capability 可从 exact frozen `taskProofRef` 执行；篡改 proof、AgentDefinition 或 node tuple 在任何 provider effect 前拒绝，graph 不变。
3. patch 与 iteration receipt 不存在可观测的 split-brain crash window；fresh service 只能看到 transition 前或 transition 后的完整状态。
4. Controller 和至少一个 Worker 都证明 `new → targeted → fresh-runtime targeted`，instance/session identity 不变；索引损坏不产生 fallback Agent。
5. invalid/stale model decision 只产生有界 typed feedback，不修改 graph；host invariant 错误不会被吞成模型纠偏。
6. focused tests、typecheck、严格 Track 校验及 source-conformance scan 全部通过。
