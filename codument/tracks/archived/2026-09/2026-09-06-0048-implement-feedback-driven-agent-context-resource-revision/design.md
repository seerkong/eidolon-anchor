# 资源修订设计

## 原实现与目标

EidolonAIAgentDefinitionAuthoringAdapter.author/transaction.prepare 当前拒绝非 create；Halfcode ResourceAuthoringOperation 已原生支持 update/expected present authorityDigest，复用它而非旁路写资源。EidolonAutonomousAgentResourceHost 已拥有 observe→selection→author→reconcile→freeze，不得删除动态创建。

EidolonAppResourceRegistryAdapter.materializeAgentContextPipeline 当前只接受 standard descriptor 和六阶段 ledger；AiAgentExecutor.assertCanonicalAgentContextPipeline 只验证名称。目标是 Halfcode 资源代码及依赖成为实际运行内容，冻结到 run/actor，可在更新后恢复原闭包。仅放宽 implementation 字符串不满足验收。

P1-T1 补充完整历史→目标矩阵及可执行测试命令后，设计后 AttractorCheck 再进入生产代码。保留 MessagePrefix 稳定前部；context 动态代码仅在历史链原有锚点工作，不能修改 prefix 来实现阶段切换。包括 workspace AGENTS、history 前后切分、WorkContextOverlay、provider handoff、compaction/tool pairing 和 provider conversion。

## Authority 与跨系统边界

Halfcode 为资源 authoring/publish authority，graph admission 为 frozen run authority；context code 是冻结执行输入，不是最新版隐式全局。修订反馈是有引用的不可变输入，不是新任务状态 owner。使用本项目已建立的 resource execution/binding 能力；若需要外部协议，先输出 owner/最小外部 Track 的证据供 Mission replan，不能修改 node_modules。

保守兼容：新修订供新 run，旧 run 不解冻；非 workflow coding 无阶段概念；测试零付费。modeling/engineering 当前显式 disabled，不生成空 delta。

## P1-T1 实证结论与实现顺序

2026-09-05 的设计调查覆盖 Eidolon 的 resource adapter、provider prompt 主链、workflow freeze/recovery，以及 Halfcode/depa-flows 的公开协议和对应源码。这里的外部文件引用以 ProjectRef 对应仓库为根，运行期物理位置由 Mission 解析，不写入持久文档。

结论是“现有能力可组合，但两个 owner 需要补齐协议”，不是重建资源管理库：

1. Halfcode 0.3.0 已有 single-file `create | update`、present authority CAS、plan/apply、candidate、receipt 与重试；Eidolon 的宿主事务桥接仍为 create-only。
2. Eidolon 已有资源目录字节冻结、Effective VFS provenance、冻结 registry 恢复，以及 Ctrl/Data workflow 外部代码源冻结。该能力必须复用，不能把当前系统描述为没有冻结能力。
3. 缺少的是 **AgentContextPipeline 的代码解析/执行与递归模块闭包 admission**。Halfcode `CodeBinding` 与 SkillCapsule 编译器目前生成按 moduleSpecifier 导入的 wrapper，不提供“从已冻结模块字节恢复并验证全部模块身份”的公开闭包入口。
4. depa-flows 的 selection/reconcile 仍强制 `author-new → create/absent → authorityDigestBefore=null`，不能直接承接 update。`compileAgentContextPipeline` 目前只出现在 Kind semantic-operation 声明里，不是实际导出的可执行 compiler。

执行顺序：本设计经 design-after AttractorCheck → Mission 将下述外部最小 Track 纳入真实 DAG → 外部协议验收 → Eidolon P1-T2 以新依赖公开入口接入并进行真实恢复验收。两个外部项目已在 Mission 授权范围内；协议缺失交父层重规划，不据此结束整个 Mission。P1-T1 不修改生产代码，也不自行修改外部项目。

## 成熟消息链的逐项映射

表中路径均为 Eidolon 仓库相对路径。`L` 指 `cell/packages/ai-organ-logic/src`，`C` 指 `cell/packages/ai-core-contract/src`，`P` 指 `cell/packages/ai-persistence-logic/src`。行号用于本次定位，函数名是后续重构时的稳定锚点。

| 行为 | 当前代码证据 | 目标承载与不变量 |
| --- | --- | --- |
| MessagePrefix 有序异构拼接 | `L/resources/EidolonAppResourceRegistryAdapter.ts:990`，`materializeAgentExecutionPlanFromSnapshot` 遍历 `agent.messagePrefix`；`:1098` 将结果变成 seedMessages | 保留 Prompt/MessageSource 顺序、role、schema 与 contentDigest；编译时冻结 prefix 的最终值。动态反馈不得插入或改写该前部。Agent 修订可以为后续新 run 指定新配方，但一次 run 的 prefix 固定。 |
| workspace AGENTS | 同文件 `:1007` 的 MessageSource 分支与 `:1863` 的 `loadWorkspaceAgentInstructions`；builtin 生成器 `cell/packages/mod-ai-coding/tools/generate-builtin-eidolon-vfs.ts:101` | `AgentMessageSource` 原生代码 binding 只在 admission 的显式 workspace-read effect 中执行一次，结果和 digest 进入旧闭包。恢复不重新读取工作目录 AGENTS。保留无文件/空文件不产出消息及 `AGENTS.md (workspace):` 格式。 |
| PromptPlan 与 identity seed | `L/exec/AiAgentExecutor.ts:686,856`；`L/runtime/ContextControlPlane.ts:350,496` | 新资源 entry 编排现有 build/record 处理器；Actor.systemPrompts + thin-context identity seed 仍是真源，不能读 actor.messages 拼另一份 provider prompt。record 模式仍每次 provider request 一代；estimate 模式零写入。 |
| 历史前部、compaction prelude 与活动 tail | `P/ConversationProjection.ts:459` 的 target-generation 选择，`materializePromptTransformPrelude`，`:581` visible messages，`:643` runtime prompt；`L/conversationCapsule/internals/domainRuntime.ts:3349` | 资源代码调用现有 `materializeConversationRuntimePrompt` 纯逻辑；保持 summary/ack、context asset prelude、活动 history generation 的切分。不能把所有历史 flatten 后重跑自建拼接算法。 |
| 历史锚点与动态事实 | `P/ConversationProjection.ts:284,314` 校验 sequence/head、generation、messageCount、frontierDigest 并按 count 插入 | 反馈/阶段中允许给 provider 的内容先经现有 fact owner admission，资源代码只读已接受的事实。保留 `eidolon-context-fact/v1`、同锚点顺序、未知 frontier 拒绝，不能按“最新 user”猜测位置。 |
| 稳定 system 前部去重 | `P/ConversationProjection.ts:597,620,643` 的 system prompt stage；`L/runtime/ContextControlPlane.ts:476` estimation completion | 保持 trim 去重和原顺序；identity 与系统指令不能在每次状态变化时重建成不同前部。验证最终 provider request 的共同前缀，不能只比较 descriptor。 |
| WorkContextOverlay | `L/runtime/ContextControlPlane.ts:419,445,496`；`P/ConversationProjection.ts:307`；`L/conversationCapsule/internals/domainRuntime.ts:414,2383` | **现行为是 work context 仅为控制元数据**：overlay 文本 helper 存在，但新 prompt 不合成该 system overlay；恢复的 `work-context` fact 被过滤。不得借“保留 overlay”重新把可变 work mode/task phase 暴露给模型。legacy late-status transforms 按既有兼容规则读取。 |
| conversation boundary overlays | `P/ConversationProjection.ts:243,561,643` | 保留稳定 system 前部后的既有边界插入规则；资源代码只通过该原算法处理现有合法 transform，不能改 prefix 或重写已有 transcript。 |
| provider handoff / epoch | `L/conversation/ProviderEpoch.ts:89`；`L/conversation/ProviderEpochProjection.ts:263,352`；`L/exec/AiAgentExecutor.ts:4407` 的 epoch transition | 使用当前 provider/model、head、handoff digest 与 accepted frozen revision 转换协议。代码更新不能偷换旧 actor 的 epoch；新 run/显式新 admission 获得新版本。provider handoff 仍由 canonical conversation facts 投影。 |
| compaction 与 tool pairing | `L/exec/AiAgentExecutor.ts:777,1122,1650,5293,5658,5745`；`L/compression/ContextCompressor.ts:470`；`P/ConversationProjection.ts:358,429` | 压缩继续经原 conversation authority 提交新 generation；pending first delivery、受保护历史 split、call/result pairing 与 delivered 状态保持。ContextPipeline 不写压缩 authority、不创建第二份 history。 |
| provider conversion 与 request | `L/exec/AiAgentExecutor.ts:368,923,2339`；`L/llm/OpenAIChatHelpers.ts` | 最后仍走 `prepareMessagesForLlmAdapter`：移除内部 messageId；OpenAI Chat 正规化；DeepSeek 保留 reasoning；Codex Responses 不进入 Chat adjacency repair。现有 tools/schema admission、stream/request correlation 保持。 |
| 旧运行和恢复 | `L/resources/EidolonAppResourceRegistryAdapter.ts:552,1458,1621`；`L/workflow/runtime/WorkflowRuntimeService.ts:743,2573`；`L/workflow/runtime/AIDataAgentResourcePreparation.ts:152,244`；`cell/packages/ai-support/src/runtime/LocalFileRuntimeSnapshotRepository.ts:367,437` | 复用 instance definition files + frozen VFS reader；补足动态 prepared task 的独立版本闭包。当前 fixed registry 对 prepared task 选择 live 并检测 drift，recover 也重新 observe live，故“拒绝漂移”尚不等于“live 修订后恢复旧版本”。要改成按 preparation receipt 读取冻结闭包。 |

六阶段 ledger 是阅读提示，不是可执行协议。目标是加载并调用冻结的资源代码，该代码通过显式 runtime 依赖调用以上成熟处理器；不能只换 implementation 字符串，也不能把上述函数复制进若干字符串分支。

## 最小可实施代码闭包

### 资源与 runtime 的边界

保留 `AIAgentDefinition → MessagePrefix + ContextPipeline + ToolRefs/MaterialPortRefs`。用 Halfcode 原有 `CodeBinding`、Kind reader/semantic contract 及编译链承载 AgentMessageSource/AgentContextPipeline 的入口。`Content` legacy JSON 可作为兼容 reader 输入，正规化为 builtin 标准实现的真实 binding；新的 authoring 使用 owner 定义的新 spec revision，不能宣称任意 JSON implementation 已经是代码。

目标入口是同步纯组合 `output = contextPipeline(runtime, input, config)`；资源加载/解析/编译和绑定在 async admission 完成，保持当前同步 `buildProviderPromptForActorTurn` 与压缩估算调用契约。runtime 只承载类型化成熟处理器及 effect port；input 为本次 prompt 输入和只读 domain 视图；config 为冻结的枚举/数值策略，不放函数、VM 或 registry。外层 adapter 组装 runtime，资源不取得 whole VM，不创建新的 provider/actor/client。

最小默认实现仍调用原有 prompt-plan、domain materialization、estimation completion、provider conversion 处理器。要让资源修订的执行差异可观察，测试资源可以选择或格式化 **已 admission 的动态 context fact 内容**；其输出经过原 frontier/role/tool-pair/prefix 约束，不能任意覆盖稳定历史。把有副作用的 fact append/prompt record 留给宿主已有 port，估算调用不得触发 append。资源 runtime 通过 narrow effect 契约请求操作，而不是自己写文件或 domain state。

### 必须冻结的内容

一次 Agent admission 的执行身份包含：

- exact Agent/Context/MessageSource resource identity、authority/content digest、reader/spec revision、Kind owner fingerprint 与 Halfcode registry/snapshot revision；
- 有序 prefix 的最终 role/content/schema，包括 admission 时读取的 AGENTS；
- CodeBinding 的入口/export、资源包内部的代码字节、静态可解析递归 import、声明的文本/JSON 资产、模块依赖边、每个模块 digest 与逻辑来源；
- Halfcode 编译目标/版本、生成物 digest，以及宿主能力 ABI/实现版本身份；
- Workflow task proof、preparation receipt 和该执行闭包 digest/ref 的不可变关联。

**可复现边界**：冻结资源包拥有的源模块与资产闭包，验证宿主依赖身份。Node/Bun 内置模块、原生二进制、宿主 provider/effects 及整个 node_modules 不复制到每个 run。它们作为明确的 ambient dependencies 记录 package/version 或宿主 ABI/content identity，恢复时匹配，不能匹配则给精确不兼容结果。未知动态 import、越过声明 source root 的相对引用、未声明外部包不得退回 live resolve；先拒绝 admission，并让作者改为静态依赖或明确 ambient binding。测试不能承诺任意 Node 程序的全环境时间旅行。

Halfcode 持有闭包构建/验证与 code execution binding 的通用协议。Eidolon support 实现其 source-read/artifact-storage/runtime-effects 端口；沿用现有 frozen resource files 保存 opaque closure artifact，不另建 resource registry。模块缓存以 closure digest + module identity 寻址，不能只按 resourceId 或 live moduleSpecifier；同进程 V1/V2 并存也必须正确。旧运行持有的 artifact 不因 live update 删除，最低保留期为引用它的 instance/run/actor 的可恢复期。

### 运行和恢复顺序

1. `observe` 取得 authentic candidate set；feedback 引用当前失败 attempt/observation/verification 与旧 execution digest。作者产生修订提案，反馈本身不拥有资源或图状态。
2. 经 owner admission 校验 `update` 对象、expected present digest、候选集版本与反馈引用，调用 Halfcode plan/apply。新 entry/依赖代码必须先通过 compiler/closure 检查。
3. publication fence 内先验证 isolated candidate，原生 receipt durable 后 reconcile，才可产生新的 selectable execution identity。Agent/Context 联动如果需要多次单文件更新，分为明确的修订序列：先准备新的依赖版本，再以 Agent 引用更新作为 recipe admission 点；不把两个单文件事务宣称成跨文档原子提交。半完成序列没有新 Agent admission。
4. 对新任务冻结全部闭包并持久化 preparation artifact，然后 graph admission 关联 task proof，才创建/恢复 actor。新 graph generation 不原地替换旧 task 的 preparation；新任务身份或新 run 指向 V2。
5. 旧 task 从 receipt 的 closure artifact 构造 isolated frozen registry，通过原公开 owner API 重新获得 authentic proof。不能 JSON cast 成 branded admission，不能 observe 最新 registry 后假定旧 proof 仍成立。
6. Actor snapshot 保存可序列化 binding/ref/digest，process 内 executable handle 不序列化。恢复先验 artifact、dependency/ambient identities，编译或加载冻结 artifact，再绑定 handle。旧文件/模块缺失给明确恢复失败，不执行 latest fallback。

## 原生 update 的宿主事务修订

Halfcode owner 证据：`halfcode-compiler.xnl/packages/runtime-authoring/src/resource-authoring.ts:17,24,37,154`，原生 `ResourceAuthoringOperation`、present expectation 与 transaction port；`:245` 附近做 operation/expected 校验；原生测试已覆盖 concurrent updates 与 stale update。

Eidolon `EidolonAIAgentDefinitionAuthoringAdapter` 的改动不是只删 `:133` 和 `:178` guard：

- planningAuthority/inspector 按实际目标 Kind 取得已注册 catalog/spec；最小开放 AIAgentDefinition、AgentContextPipeline，以及需要时的 AgentMessageSource，不开放任意未知 Kind。保持 native single-file 文档作为 CAS 单元。
- journal v2 写入 operation、expected state、before digest/存在性、必要 before bytes、after digest、documentUri、planDigest、registryRevisionBefore 和明确阶段；旧 v1 create journal 继续按原规则读取。
- prepare 在 fence 内比较 registryRevision **和**被选中 effective origin 的 authorityDigest；workspace 覆盖全局资源时，effective before 与 workspace 文件是否存在分开记录。不能把“workspace 未落文件”误判为 resource absent。
- Effective VFS `prepare` 构建 candidate，仅 candidate 检查通过才发布。具体 mutation 类型遵循 VFS owner 原语，不手写第二套 overlay 合并/CAS。
- 物理 overlay 替换使用宿主受控原子 write/rename 与 CAS 检查，durable journal/receipt 围住现有物化时序。update rollback 仅在当前字节仍为本事务 after digest 且未 admission 时恢复 before bytes；create 才可以移除新文件。不能沿用当前 `rollback` 的直接 unlink。
- uncertain commit：在 Effective VFS 已 admission、receipt 尚未最终落地时，recovery 读取 pending receipt、原 owner publication identity 与 journal，完成原交易的 reconciliation；绝不恢复成旧字节。反之仅 prepared、未 admission 时撤销暂存。后续另一更新已成功时，恢复旧 journal 不得覆盖它，也不得因为 live 已是 V3 就遗忘已经完成的 V2 receipt；恢复要使用原交易的 durable publication evidence。
- 完全相同 plan 重放返回同一 receipt；相同旧 expected 的不同 plan 只有一个胜者；foreign symlink/path、不同 Kind/id、缺 code export、closure compile failure 在变更 live authority 前失败。

## 外部 owner 最小 Track（供 Mission replan）

| 建议 Track | Owner 与范围 | 当前缺口证据 | 最小验收 |
| --- | --- | --- | --- |
| `add-native-code-binding-execution-closure` | `halfcode-compiler.xnl`；扩展现有 application-assembly/资源编译与 runtime-authoring，公开受控 source/read、compile/capture/restore/execute binding 协议 | `packages/application-assembly/src/index.ts:450` CodeBinding 只有 package/module/export/moduleSpecifier；`packages/compiler-skill/src/index.ts:1299` wrapper 从 moduleSpecifier import；`packages/resource-core/src/dependency-snapshot.ts:42` snapshot closure 只有身份，无可执行字节 | 两级内部 module import 与资产在 V1 freeze 后 live 改 V2/移除 source，fresh runtime 恢复仍执行 V1；V2 新 freeze 执行 V2；digest/edge/export/ambient 不匹配拒绝；相同 source+compiler identity 产出相同闭包；现有 SkillCapsule、CodeBinding、authoring update 回归。 |
| `extend-agent-resource-revision-admission` | `depa-flows.ts` 的 ai-workflow-contract/logic；依赖前项公开协议，扩展当前 selection/reconcile 与 Agent code Kind 语义 | `packages/ai-workflow-logic/src/agent-definition-selection.ts:221,289,520` 精确 author-new/create-only；`packages/ai-workflow-contract/src/resource-kind-contracts.ts:74,101` 仅声明 compile operation，ContextPipeline reference roles 为空 | closed `revise-existing`（最终名字由 owner 确定）携旧 candidate/requirement/feedback identity，native update receipt reconcile 校验 before/after 与 exact durable receipt；reader 产生真实 code binding/dependency edges，freeze 覆盖代码闭包；fresh restore 重建 authentic proof；create/select 兼容不回退。 |

Halfcode 的 package 级 `CodeBinding` 是既有执行入口；AgentMessageSource/AgentContextPipeline 是 depa-flows 拥有的 Kind。Halfcode 不加入 Eidolon/work-context/failure 术语，depa-flows 不复制 filesystem journal 或 module bundler。反馈字段只引用上游观察记录并参与修订因果 identity；feedback 的业务诊断分类留 Eidolon。

外部 Track 接口名是待 owner 落实的建议，不能在 P1-T2 假装这些 export 已安装。先验包的真实 exports/声明与 contract tests，再改本仓库 import。无需为这些协议发布 npm；按 Mission 的开发绑定方式验收，禁止手改 node_modules 或把源码复制到 Eidolon。

## TDD 验收闭包与真实入口

### 联合协议验收后的宿主持久化细化

P3 接入调查进一步确认：现有 EffectiveEidolonVfsMaterializer 硬编码 MemoryRevisionedVfsAuthority，缺少历史 publication 的持久查询；不能凭 authoring pending receipt 或 latest 文件摘要相等证明 V2 已发布。后者在 live 已为 V3 时必然丢失恢复依据。这是本 Track 原“uncertain commit、旧 receipt 不被 V3 遗忘”验收所必需的同仓库 owner 补齐，不新增资源状态 owner。

实施沿用 xnl-vfs 已公开的 RevisionedVfsAuthority.read/compareAndSwap，向原 materializer 注入本地 durable backend。原 CAS 的单次提交同时持有 snapshot/revision 与 publication 的 plan/transaction 关联；不能先发布内存再通过普通回调补写 proof。文件 support 在同一跨进程 writer 边界内读取、校验、提交，head 与 publication history 原子更新；恢复从该提交重建派生 view。业务 adapter journal 只保存 prepared intent/before-image/receipt 恢复材料，通过原 owner 查询结论。

bootstrap 先恢复未决 publication，再装载物理 overlays；不能将尚未 admission 的 after-image 自动当作已发布。全局覆盖的 effective before 与 workspace before-image 分开记录。更新使用原 VFS CONTENT_UPDATE 及实际 node identity，不推算 workspace id；同一个 native plan 的历史重放必须保留可信 planning pins，经原 native 校验，不因 V3 当前 revision 而回滚 live 或跳过校验。

实施验证后的时序细化：使用 Bun 内置 SQLite 的本地事务后端，`BEGIN IMMEDIATE` 内原子提交原 VFS head、历史 publication 与 closed pending projection，再物化工作区文件（head-first）。head 是运行时唯一 authority，物理 overlay 是该提交的派生投影；物化失败不撤销已 admission 的 head，bootstrap 只补已提交投影。此顺序替代新路径中的 physical-before-head 窗口；旧 journal 无法证明 admission 时仍拒绝猜测。该 SQLite 只持久化本地 VFS 发布控制，不改变 Holon 文件存储的领域方案。

2026-09-06 动态事实呈现细化：不能用每轮任意 formatter 改写旧 fact 的 provider 字节。原 ContextPipeline 代码可显式通过 frozen config 的 `factPresentationProtocol = "eidolon.context-fact-presentation/v1"` 声明准备能力，并在 admission 的 `{ kind: "describe-fact-presentation" }` 调用返回闭合配方；同一代码仍在每轮编排成熟处理器。首版配方可对已 admission 的 task-tree/workflow-stage payload 选择顶层字段并选择 canonical/pretty JSON，身份、role、事实数量、原锚点和顺序不变；work-context 仍排除，provider-output-recovery 保留完整恢复指令。配方随原 ActorDurableMaterial bundle 固定，不建立第二个 fact store 或渲染缓存。原 ConversationProjection 在验证事实链与锚点之后解释它；正常请求、语义恢复和 Responses continuation 基线三个 provider 路径使用同一冻结配方。没有 workflow 时不产生 stage 概念。这里先采用可证明 append 稳定性的呈现能力，避免依赖模型或当前 history 的回调隐式改写旧前缀。

具体证据、文件闭包与故障矩阵见 `analysis/authoring-update-handoff.md`。实现分为原 VFS durable owner、authoring update 接入、资源执行与冻结恢复三个边界；最后运行同一个 P1 Gate，保留原 create/select、真实跨 OS 断点和所有成熟上下文不变量。

以下命令从各自仓库根执行，需已安装 Bun；此轮实际使用 Bun 1.3.14。所有测试使用本地 fixture/mock provider，无付费请求。不调用 build/install/publish。

Eidolon 已有成熟行为基线：

```sh
bun test cell/packages/ai-organ-logic/tests/AIAgent/conversation/single_in_memory_truth_conformance.test.ts cell/packages/ai-organ-logic/tests/AIAgent/runtime/context_control_plane.test.ts cell/packages/ai-organ-logic/tests/AIAgent/runtime/provider_context_projections.test.ts cell/packages/ai-organ-logic/tests/AIAgent/openai_chat_driver_helpers.test.ts cell/packages/ai-organ-logic/tests/AIAgent/compression/context_compressor.test.ts cell/packages/ai-persistence-logic/tests/conversation_projection_recovery.test.ts
```

2026-09-05 实跑：**70 pass，0 fail，254 assertions**。包括 domain-only prompt、raw array 不进入 provider、work context 不形成模型消息、DeepSeek reasoning、dangling/split tool call 修复、compaction 与纯恢复。

资源/authoring/动态创建回归入口：

```sh
bun test cell/packages/ai-organ-logic/tests/workflow/agent_definition_authoring_adapter.test.ts cell/packages/ai-organ-logic/tests/workflow/autonomous_agent_resource_host.test.ts cell/packages/ai-organ-logic/tests/workflow/workflow_app_resource_registry.test.ts
```

本轮首次实跑：registry 文件 **25 pass**（包括资源外部代码冻结、live 包不可用恢复、动态 SubFlow author/select），另外两文件在加载时 `Cannot find package 'xnl-vfs'`，合计命令 **25 pass / 2 fail / 2 errors**。父层随后补齐与既有 symbiont 依赖一致的 ai-organ-logic 测试 devDependency；本设计 worker 使用下面的原入口复跑缺依赖的两个文件，结果 **11 pass / 0 fail / 65 assertions**。首次失败已定位为依赖解析，并非功能断言失败；两次执行合计覆盖 registry/authoring/host 的 36 个现有测试。本设计 worker 未安装或修改依赖。

```sh
bun test cell/packages/ai-organ-logic/tests/workflow/agent_definition_authoring_adapter.test.ts cell/packages/ai-organ-logic/tests/workflow/autonomous_agent_resource_host.test.ts
```

P1-T2 先在上述两个 authoring/host 测试文件及 `workflow_app_resource_registry.test.ts` 加以下 RED 场景，继续使用相同真实入口，不创建只断言文档文字的假验收：

| 场景 | 必须观察到的事实 |
| --- | --- |
| update 成功与因果 | feedback 引用失败 attempt + V1 execution digest；真实 native plan/apply 的 operation=update，before=V1、after=V2；native reconcile 后 candidate 与新 run 指向 V2。 |
| CAS 和 rollback | 两提案基于同一 V1：一个成功，一个精确冲突；同 compositionRevision 的内容变化仍冲突；candidate 编译/验证失败旧字节、registry、prefix 均不变。 |
| crash/reconcile | 在 prepare 后、physical write 后、VFS admission 后、durable receipt 后各注入中断；fresh adapter 重试只完成一次原 intent；已 admission 不回滚，过期 journal 不覆盖更新后的 V3。 |
| 真实代码执行 | V1/V2 使用同一资源 ID 和入口名，但绑定代码/内部 helper 导致不同动态事实输出；抓实际 provider request 证明差异来自执行代码；仅变 descriptor label 测试必须失败。 |
| 完整旧闭包 | freeze V1（Agent、Context、MessageSource、AGENTS、内部 helper、声明 asset），发布 V2，再修改/移除 live source；同进程旧 actor 与 fresh process 旧 run 都执行 V1，新 run 执行 V2。破坏 frozen artifact 或 ambient identity 必须精确拒绝。 |
| prepared task 恢复 | V1 动态 author/select 后经 graph admission 执行；V2 发布后进程重启；原 task 从 preparation closure 重建 proof，不依赖 live observe。新 task 才使用 V2。 |
| 上下文等价和 prefix | 同一 canonical raw-state fixture 同时经现有标准组合和冻结代码组合；逐项比较 prefix、prelude/history split、锚点、overlay/handoff、工具配对、最终 provider messages；仅显式新增的 anchored fact 有预期差异。再追加动态反馈/phase 变化验证稳定 prefix 字节相同，work-context 仍不出现在 provider wire。 |
| 副作用与兼容 | estimate 运行两次没有 prompt generation/fact append；record 只一次；旧 descriptor 正规化到真实 builtin binding；无 ContextPipeline 的非 workflow Agent 保持当前默认链，author-new/select-existing 原测试全部通过。 |

还需回归以下已存在入口，覆盖 handoff、request/recovery 的承重边界：

```sh
bun test cell/packages/ai-organ-logic/tests/AIAgent/provider_epoch_projection.test.ts cell/packages/ai-organ-logic/tests/AIAgent/runtime/provider_context_epoch_transition.test.ts cell/packages/ai-organ-logic/tests/AIAgent/runtime/provider_context_multi_actor_recovery.test.ts cell/packages/ai-organ-logic/tests/AIAgent/conversation/provider_equivalence_gate.test.ts cell/packages/ai-organ-logic/tests/AIAgent/runtime/runtime_snapshot_repository.test.ts
```

上述补充入口已定位，P1-T1 未运行；P1-T2 在修改相关逻辑后运行。source-level 测试如 `single_in_memory_truth_conformance` 当前包含 direct-call 正则；若抽取 adapter 改了代码布局，应保留其 domain authority 反例与真实输出断言，更新锚点，不能直接删除测试或放宽成“某字符串存在”。

外部 owner 的已执行原生基线：

```sh
# halfcode-compiler.xnl 仓库根
bun test packages/runtime-authoring/src/resource-authoring.test.ts
# depa-flows.ts 仓库根
bun test packages/ai-workflow-logic/test/agent-definition-selection.test.ts
```

本轮分别 **24 pass / 81 assertions**（含真实 concurrent/stale update）、**2 pass / 22 assertions**（create→reconcile→freeze）。新增外部闭包与 revision tests 由外部 Track 添入同一 owner 的测试目录，再把实际新增命令回传到本 Track。通过当前 create 基线不代表 update reconcile 已实现。

### P1-T1 交付边界

本次仅扩充 design.md；没有生产改动、fixture 伪实现、外部写入、commit 或依赖安装。上表每项都有现状代码、目标 owner、必要变更和验收方向。代码编译/冻结和 revision admission 的最终公开 API 需外部 Track 落地后验证；完成 design-after AttractorCheck 前不进入 P1-T2。
