# Mission：建立 Eidolon Anchor Resource-native App 与系统 Skill 架构

## 背景和动机

当前 Eidolon 已具备 AI Workflow 的 authoring、publication 与 runtime 骨架，但仍把产品能力收窄为 workflow definition 和 `agentType + prompt` 调度。Fabric平台 曾提供更完整的预制 App 组合：workflow、agent definition、prompt、skill、schema、material 与资源依赖共同形成可发现、可冻结、可运行的应用能力；其早期通用资源管理实现不应被复制。

Halfcode 已成为 XNL ResourcePackage、Catalog、KindDefinition、ResourceTree 与 SkillCapsule 的通用资源 authority；depa-flows 是 AI Workflow profile 与运行语义 authority；Eidolon 应只承担 host roots、资源消费 adapter、actor/runtime、安装入口和人类产品 surface。现有 `sys-ai-workflow` 把 DevOps 路由、authoring、Flow DSL 和运行协议集中在一个 Skill 中，并由 Eidolon 代码手工枚举文件，无法扩展到更多 App 资源类型。

本 mission 将以 Halfcode 标准资源编译链为基础，把 Eidolon Anchor 建立为 Resource-native App 消费与运行平台，并把单体系统 Skill 拆为一个 DevOps 总路由器、两个专属操作 Skill，以及一个由 Halfcode 所有的 XNL Resource DSL 基础 Skill。

2026-08-22 的产品复核发现，前一轮虽然完成了 ResourcePackage、完整 `AIAgentDefinition` 与 Ctrl/Data E2E，却把 depa-flows 已保留的 Definition→Instance→Run、state/config/seed 和 filesystem store 语义在 Eidolon host 中重新摊平成按事实类型分类的目录；同时 authored flow 仍直接使用 generic `effects.invoke`。这不是上一批能力的简单缺陷，而是完成边界过窄造成的架构偏差。因此 mission 已通过原子 lifecycle transition 从 completed 恢复为 active；既有 DONE 历史保持不变，新的纠偏阶段追加在原 DAG 末端。

## 目标

- 让 Halfcode 成为通用资源 package、catalog、Kind、layering、identity、revision/provenance 与 SkillCapsule 分发的唯一 authority，不复制 Fabric平台 的旧资源注册表。
- 在 Halfcode 增加多 Skill capsule dependency/distribution 能力，并发布面向消费者的 `sys-halfcode-resource-dsl` SkillCapsule。
- 修正 depa-flows 当前 `AIWorkflowAppBundle/ResourceCatalog` 与通用资源职责重叠的问题，改为消费 Halfcode normalized ResourceTree/ResourceRecord。
- 在 depa-flows 补齐 `AIAgentDefinition`、ordered messages、agent task resource ref、MaterialPort/Binding、依赖闭包与 exact run freeze 等 workflow 领域契约。
- 让 Eidolon 通过 Halfcode registry 发现和解析 App 资源，替代遍历 `manifest.xnl`、硬编码模板/预制资源和 workflow 私有 catalog。
- 将 `resource://<agent-fqn>` 的 AIAgentDefinition 投影到 Eidolon 现有 AgentRegistry、actor、provider、tool、session 与 effect runtime；不创建 workflow 专用 agent runtime。
- 将系统 Skill 拆为 `sys-eidolon-anchor-devops`、`sys-eidolon-anchor-authoring`、`sys-eidolon-anchor-run`，并以 `sys-halfcode-resource-dsl` 提供独立通用 XNL 资源规范。
- 所有编辑操作目录使用 `operations/`；Flow DSL 和其他 Kind 标准通过 Halfcode SkillCapsule 编译为带来源、版本和 digest 的渐进式 references。
- 让 `eidolon global init` 原子安装/替换完整系统 Skill dependency closure，成功迁移后移除旧 `sys-ai-workflow`。
- 保持模型拥有自然语言语义选择权；确定性代码只验证结构化 Kind、stage、operation、revision、resource ref、receipt 和 authorization。
- 恢复 depa-flows 原有 Definition/Instance/Run 不变量：启动前冻结完整 definition bundle；instance 是可检查的运行胶囊；每个 run 在 instance 下拥有一个 canonical checkpoint。
- 让 canonical checkpoint 统一拥有 input/config/state/output、controller/node sidecars 和 profile-owned durable state；AICtrl snapshot 与 AIData RunGraph 作为 typed profile state，不再形成多个并列可写半真源。
- 建立 DEPA 标准 Processor `runAgent(agentRuntime, input, config)` 与 `runTargetedAgent(agentRuntime, selector, invocation, config)`，并在 runtime-bound facade 中使用同名 typed methods；generic `invoke` 只允许作为内部 dispatcher。
- 支持 closed ergonomic selector `{ byInstanceId: string } | { byInstanceName: string }`，让 Ctrl/Data 后续节点通过返回的 instance id 或 authored instance name 复用同一 Agent 运行实例。
- 将 Eidolon session/actor/instance 等 opaque stable refs 存入 AI Workflow profile 的 run-local system state，但不复制 conversation、history、compaction 或 actor state。
- 将 Eidolon 旧 flat `WorkflowFactStore` 布局单向迁移到 depa store contract；新布局单写，旧布局只兼容读取或一次性迁移，禁止双写双 authority。

## 非目标

- mission 本身不直接修改代码、规范或测试；真实落地由各项目的真实 track 承担。
- 不复制 Fabric平台 的 ResourceRegistry、global/workspace overlay、Skill inventory 或安装器实现。
- 不把 Halfcode 的通用 ResourcePackage/Catalog 重新定义在 depa-flows 或 Eidolon。
- 不把 Flow DSL 手工复制到 Eidolon 作为第二 authoring authority。
- 不修改 ACE Workbench；它只作为 DevOps Skill 与 authoring Skill 分离的参考证据。
- 不把尚未确定 owner 项目的非 workflow 预制 App 内容塞入 depa-flows、Halfcode 或 Eidolon。
- 不实现 workflow-specific history compactor、conversation store 或 Agent runner；跨节点复用只通过 Flow checkpoint 中的稳定 instance/session references 驱动 Eidolon 通用 actor runtime。
- 不在 host 代码中通过正则、关键词、substring、模糊匹配或有序 heuristic 推断业务意图。
- 不从历史翻译项目重新抽象资源或 runtime；本轮历史证据只采用 Python workflow fixture/host persistence 与 depa-flows canonical examples，且不会修改该 Python 参考项目。
- 不把新 Flow system state 放进额外的 `ai-state/<runId>/system.json` 或其他平行 host 目录。

## 成功判据

- Halfcode 的公开 API 能加载有版本的 ResourcePackage，形成可验证 layered registry、content/dependency closure，并原子规划多个 sibling SkillCapsule 的生成结果。
- `sys-halfcode-resource-dsl` 完全由 Halfcode canonical docs/SkillCapsule 生成，安装制品可追溯到 source version 与 digest。
- depa-flows 不再拥有第二套通用 catalog/scanner；AI Workflow 和 Agent 资源通过 Halfcode ResourceRecord 投影为领域事实。
- Eidolon 不再通过遍历所有 `manifest.xnl` 或硬编码数组发现 App 资源；TUI、CLI 和 native tools 共享同一个资源 component/adapter。
- workflow 的 agent node 可以引用标准 `AIAgentDefinition`，其 message/resource/material closure 被绑定到不可变运行快照并由 Eidolon 通用 actor runtime 执行。
- 标准 `AIAgentDefinition` 的 message/input/output schema、effect policy 与 MaterialPort/Binding 不得停留在 projection 或 unsupported-profile；它们必须由通用 runtime 精确校验、执行和持久化，Ctrl/Data 两种 workflow 都有端到端证据。
- `eidolon global init` 在一个 staged/validated transaction 中安装四个系统 Skill，重复执行幂等，任一 capsule 失败不暴露部分版本。
- `sys-eidolon-anchor-devops` 在 Code 阶段引用 authoring Skill，在 Deploy/Operate/Monitor 阶段引用 run Skill；authoring 先加载 Halfcode Resource DSL，再按 Kind 渐进加载领域 references。
- 新系统 Skill 身份从 `1.0.0` 开始并只增长 `1.0.x`；旧 `sys-ai-workflow` 不再参与运行 authority。
- 真实安装后的 TUI/CLI 可以从自然语言创建一个 Resource-native AI Workflow App、验证、发布、实例化、运行并取得可追溯结果；全链路无自然语言 host heuristic 和平行资源 authority。
- definition 修改不会改变已启动 instance；fresh process resume 只从冻结 instance 与其 run checkpoint 恢复，不重新读取 live definition。
- instance 目录下能检查完整冻结 bundle、run checkpoint 和 run-local evidence；`state.seed` 作为 instance bundle 的只读 facet 被复制，并且每个新 run checkpoint 恰好应用一次，instance 本身不产生第二份 mutable Flow state。
- authored Ctrl/Data code 使用 typed `runAgent`/`runTargetedAgent`，不出现 public `effects.invoke({ operation: "ai.agent" ... })`；底层 Processor 保留显式 runtime 首参。
- Ctrl/Data 分别证明先创建具名 Agent instance，再由 `{byInstanceName}` 与 `{byInstanceId}` 复用；同一 Flow run 内名称必须唯一，两键同传、未找到或冲突均 fail closed 且不得静默创建新实例；等待中、完成后和 fresh process recovery 均不产生第二个 Agent instance/provider child。
- 旧 flat facts 的迁移幂等、可中断恢复且不会与新 checkpoint 双写；历史 run 保持可读和可恢复。

## 为什么需要 mission 而不是单个 track

该目标横跨 Halfcode 通用资源与 Skill 编译器、depa-flows workflow 领域资源、Eidolon host/runtime/CLI/TUI，以及安装迁移和跨入口验收。每个项目拥有独立的事实 authority 和验证链，单个 track 无法同时安全修改三个仓库，也无法在底层 API 漂移时受控重规划。

本 mission 只维护控制面、ProjectRef、期望态 DAG、track binding 和跨项目反馈；代码、规范、behavior delta、测试与迁移均由对应项目中的真实 track 拥有。
