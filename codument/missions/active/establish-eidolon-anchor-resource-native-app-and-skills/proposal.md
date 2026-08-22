# Mission：建立 Eidolon Anchor Resource-native App 与系统 Skill 架构

## 背景和动机

当前 Eidolon 已具备 AI Workflow 的 authoring、publication 与 runtime 骨架，但仍把产品能力收窄为 workflow definition 和 `agentType + prompt` 调度。Fabric平台 曾提供更完整的预制 App 组合：workflow、agent definition、prompt、skill、schema、material 与资源依赖共同形成可发现、可冻结、可运行的应用能力；其早期通用资源管理实现不应被复制。

Halfcode 已成为 XNL ResourcePackage、Catalog、KindDefinition、ResourceTree 与 SkillCapsule 的通用资源 authority；depa-flows 是 AI Workflow profile 与运行语义 authority；Eidolon 应只承担 host roots、资源消费 adapter、actor/runtime、安装入口和人类产品 surface。现有 `sys-ai-workflow` 把 DevOps 路由、authoring、Flow DSL 和运行协议集中在一个 Skill 中，并由 Eidolon 代码手工枚举文件，无法扩展到更多 App 资源类型。

本 mission 将以 Halfcode 标准资源编译链为基础，把 Eidolon Anchor 建立为 Resource-native App 消费与运行平台，并把单体系统 Skill 拆为一个 DevOps 总路由器、两个专属操作 Skill，以及一个由 Halfcode 所有的 XNL Resource DSL 基础 Skill。

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

## 非目标

- mission 本身不直接修改代码、规范或测试；真实落地由各项目的真实 track 承担。
- 不复制 Fabric平台 的 ResourceRegistry、global/workspace overlay、Skill inventory 或安装器实现。
- 不把 Halfcode 的通用 ResourcePackage/Catalog 重新定义在 depa-flows 或 Eidolon。
- 不把 Flow DSL 手工复制到 Eidolon 作为第二 authoring authority。
- 不修改 ACE Workbench；它只作为 DevOps Skill 与 authoring Skill 分离的参考证据。
- 不把尚未确定 owner 项目的非 workflow 预制 App 内容塞入 depa-flows、Halfcode 或 Eidolon。
- 不实现此前明确延期的自定义 agent history compaction prompt 或跨 workflow step 的 agent session 复用能力。
- 不在 host 代码中通过正则、关键词、substring、模糊匹配或有序 heuristic 推断业务意图。

## 成功判据

- Halfcode 的公开 API 能加载有版本的 ResourcePackage，形成可验证 layered registry、content/dependency closure，并原子规划多个 sibling SkillCapsule 的生成结果。
- `sys-halfcode-resource-dsl` 完全由 Halfcode canonical docs/SkillCapsule 生成，安装制品可追溯到 source version 与 digest。
- depa-flows 不再拥有第二套通用 catalog/scanner；AI Workflow 和 Agent 资源通过 Halfcode ResourceRecord 投影为领域事实。
- Eidolon 不再通过遍历所有 `manifest.xnl` 或硬编码数组发现 App 资源；TUI、CLI 和 native tools 共享同一个资源 component/adapter。
- workflow 的 agent node 可以引用标准 `AIAgentDefinition`，其 message/resource/material closure 被绑定到不可变运行快照并由 Eidolon 通用 actor runtime 执行。
- `eidolon global init` 在一个 staged/validated transaction 中安装四个系统 Skill，重复执行幂等，任一 capsule 失败不暴露部分版本。
- `sys-eidolon-anchor-devops` 在 Code 阶段引用 authoring Skill，在 Deploy/Operate/Monitor 阶段引用 run Skill；authoring 先加载 Halfcode Resource DSL，再按 Kind 渐进加载领域 references。
- 新系统 Skill 身份从 `1.0.0` 开始并只增长 `1.0.x`；旧 `sys-ai-workflow` 不再参与运行 authority。
- 真实安装后的 TUI/CLI 可以从自然语言创建一个 Resource-native AI Workflow App、验证、发布、实例化、运行并取得可追溯结果；全链路无自然语言 host heuristic 和平行资源 authority。

## 为什么需要 mission 而不是单个 track

该目标横跨 Halfcode 通用资源与 Skill 编译器、depa-flows workflow 领域资源、Eidolon host/runtime/CLI/TUI，以及安装迁移和跨入口验收。每个项目拥有独立的事实 authority 和验证链，单个 track 无法同时安全修改三个仓库，也无法在底层 API 漂移时受控重规划。

本 mission 只维护控制面、ProjectRef、期望态 DAG、track binding 和跨项目反馈；代码、规范、behavior delta、测试与迁移均由对应项目中的真实 track 拥有。
