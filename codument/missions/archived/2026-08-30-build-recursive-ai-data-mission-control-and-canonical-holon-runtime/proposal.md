# Mission：递归 AI Data Mission Control 与 canonical Holon runtime

## 背景与动机

上一轮 `autonomize-ai-data-cybernetic-planning` 已建立 provider-neutral 的 Goal / Observation / Decision / Admission / RunGraph 控制循环，上一轮 `local-file-single-node-holon-task-actor-runtime` 已建立 File-XNL Holon authority、TaskSpace、HolonCoordinator、MemberRuntime 与 Ctrl/Data Workflow 的单任务产品链路。但进一步复核发现，两个能力仍停在局部闭环：

1. 底层 `AIDataWorkflow` 已支持 `SubFlowNode`，自主控制协议却只允许动态添加 `TransformNode` 与 `SinkNode`。如果再引入独立 `GoalGraph`，会产生目标图和执行图两个 authority；正确方向应当是让递归 Data Flow 自身表达主目标、子目标、子 Workflow 与完成关系。
2. 当前“动态 Agent”只动态创建或复用 runtime instance。Controller 只能引用已经进入 frozen catalog/task proof 的 `AIAgentDefinition`；它不能自主编写、校验、登记和冻结新的 Halfcode `AIAgentDefinition`，也不能依据 typed task contract 在多个 definition 之间自主选择。
3. 当前 Capability Catalog 仍是一次运行的 frozen admission 白名单。大量 Tool、Skill、Processor 和其他 capability 尚未完成 Halfcode 化，因此本 Mission 不把 catalog 扩张为新的动态资源 authority；以后应从 Halfcode effective registry 和 dependency snapshot 派生。
4. 新 Holon 链路已经能由 Ctrl/Data Workflow 创建或引用 TaskSpace，并经 HolonCoordinator、MemberRuntime、Agent execution、settlement 回到 Flow checkpoint/MaterialPort；但产品入口仍需显式 `holon-process` 一次处理一个 task，没有持续观察和推进整个 TaskSpace 的 canonical actor pump。
5. 旧 `AutonomousHolonTaskRunner` 仍在 VM/TaskTree 路径中自动 claim、消息分发和 idle 处理，并且会主动跳过 canonical Holon TaskSpace。这导致“新路径是事实 authority、旧路径拥有自治驱动能力”的并存状态。
6. 既有 Holon Mission 完成时验证通过；当前 HEAD 的聚焦回归中 Data 产品 E2E 通过，Ctrl 产品 E2E 在 replan tool lookup 处因 tool surface 隔离后的 registry 组合漂移失败。因此最终验收必须以当前代码的 fresh Ctrl/Data 多任务 E2E 为准，不能只引用历史完成报告。

这些变化跨越 depa-flows、Halfcode、Eidolon 和 Holon 组织资源边界，需要多个真实 Track、跨仓依赖、迁移与删除门禁、失败反馈和受控重规划，不能由单个 Track 安全完成。

## 目标

- 把现有 `SubFlowNode` 接入 AI Data 自主 observation/decision/admission/patch/checkpoint 链路；以递归子 Flow 表达分层目标，明确取消 `GoalGraph` 方向。
- 为长期 AI Data run 建立 durable child workflow invocation：父节点只持有 exact child definition/instance/run/checkpoint reference、contract output 与 settlement receipt，不穿透子图内部状态。
- 恢复 AI 自主创建 Halfcode `AIAgentDefinition` 的能力：生成普通 Halfcode 资源、按 KindDefinition 校验、进入受审计 authoring transaction、产生 exact content/dependency identity，并由既有 Agent runtime 执行。
- 增加按 typed task contract 自主选择多个 `AIAgentDefinition` 的能力；严格区分 definition authoring、definition selection、runtime instance creation 和 instance targeting。
- 以新 TaskSpace/HolonCoordinator/MemberRuntime 为唯一 Holon 任务执行基础，实现持续运行、可恢复、幂等的 canonical Holon task pump。
- 将旧 VM runner 中仍有价值的 ready-task claim、eligible roster、mailbox 消息分发、member active/idle、background settle 与可观测事件语义迁移到新的 actor；TaskSpace 保持 task/claim/settlement 唯一 owner。
- 在 feature parity、恢复和产品 E2E 通过后，删除旧 `AutonomousHolonTaskRunner`、旧 TaskTree 自主 Holon 路由及专属兼容代码/测试。
- 建立 Ctrl/Data 多任务、有依赖、失败恢复、fresh process reconstruction、组织 snapshot replan 和最终 Flow 消费的 E2E；测试不得通过显式逐任务 `holon-process` 冒充自治 pump。

## 非目标

- 不引入 `GoalGraph`、第二份 graph store、第二份 Mission state 或从 RunGraph 派生后再反写的可写 projection。
- 本 Mission 不实现动态 Capability Catalog。当前 catalog 只保留为兼容的 frozen admission 输入；未来 catalog 必须从更完整的 Halfcode 资源体系派生。
- 不把 Agent definition 写入 Workflow 私有 JSON/config store，也不创建 workflow-specific Agent/Conversation/provider runtime。
- 不允许新资源修改已经冻结的 parent run dependency snapshot。动态创建的 definition/child flow 必须形成新的 exact resource revision 与 child invocation proof，父图只记录引用与 receipt。
- 不让 Mission Controller 成为 RunGraph 写 owner。模型输出仍是 proposal，只有 admission + checkpoint owner 可以提交 graph transition。
- 不改变 Holon Workbench 的人机中立组织主数据；`principalKind` 不自动选择执行 adapter。
- 不实现 RabbitMQ、跨机器 actor placement、远程 mailbox、node lease 或 distributed fencing。
- 不在本 Mission 中优化 provider/cache 成本；但不得破坏现有 stable prefix、ContextPipeline、Conversation 和 DeepSeek compatibility authority。

## 成功判据

1. 自主 Controller 能向 canonical AI Data RunGraph 提交并执行至少一个 `SubFlowNode`，子 Flow 具有 exact contract、独立 durable run/checkpoint 和可恢复 completion receipt；源码、测试和文档中没有新的 `GoalGraph` 产品类型或第二 graph authority。
2. 一个真实自主 E2E 能让 Controller 基于任务创建一个新的 Halfcode `AIAgentDefinition`，通过真实 KindDefinition/ResourcePackage/effective registry/dependency freeze 链路被执行；不是 fixture 预置 definition，也不是把 runtime instance creation 误称为 definition creation。
3. 一个独立 E2E 能让 Controller 在至少两个可用 `AIAgentDefinition` 中依据 typed task/schema/effect requirements 选择正确 definition，并能对缺失能力选择创建新 definition；选择结果有 proposal、admission 与 exact resource receipt。
4. Capability Catalog 没有发展成独立动态真源；新增的资源发现与选择只读取 Halfcode canonical/effective registry，run freeze 保持可重建和可审计。
5. canonical Holon task pump 能在没有逐任务人工/CLI `holon-process` 的情况下推进一个包含多个依赖 task 的 TaskSpace，使用 HolonCoordinator 选择 MemberRuntime，并在中断后从 TaskSpace/actor/checkpoint authority 恢复。
6. 旧 VM runner 的有效行为有逐项迁移证据；`AutonomousHolonTaskRunner`、旧 TaskTree autonomous Holon route、旧 ownership facts 和只为该路径存在的 compatibility code/tests 被删除，仓库中不存在可重新激活旧 authority 的 product path。
7. Ctrl 与 Data 两个产品 E2E 都覆盖：多 task 依赖、一次执行失败、重试或恢复、fresh runtime reconstruction、组织 snapshot 显式 replan、TaskSpace terminal settlement，以及父 Flow 的 checkpoint/MaterialPort 消费。
8. 现有 Workflow、Agent、Conversation/provider、Holon File-XNL、TaskSpace 和 CLI 回归保持通过；当前 Ctrl replan registry wiring 漂移被修复并有防回归测试。
9. 每个真实实现 Track 都在 owner 项目中创建、绑定、执行、验证并归档；Mission 最终完成审计能逐条回指当前源码、测试输出和 Track evidence。

## 为什么需要 Mission 而不是 Track

Mission 负责控制面和跨 Track 编排：维护唯一目标、跨仓 DAG、现状观察、authority 对比、迁移门禁、E2E 反馈和受控重规划。代码、行为契约、测试与删除工作分别由 owner 项目的真实 Track 承担。Mission 不直接用一个“大改动”绕过 Track 生命周期；仅证据盘点、最终总体验证和 Mission 文档维护作为普通 Mission Task 执行。
