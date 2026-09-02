# Mission Design：递归 AI Data Mission Control 与 canonical Holon runtime

## 1. 已收敛的方向

本 Mission 固化以下用户确认的方向，后续会话不得因上下文压缩重新发明相反方案：

1. 不引入 `GoalGraph`。分层目标和子目标由 `AIDataWorkflow` 的递归 `SubFlowNode`、typed `FlowContract`、child run/checkpoint reference 与 completion receipt 表达，结构上接近 Codument 主 Mission 调用子 Mission。
2. Mission Controller 不协调 GoalGraph 和 Workflow 两套模型。Data RunGraph 自描述节点、边、子 Flow、验证和完成关系；Mission Controller 只通过控制论循环观察并提出对这一张图的修订。
3. Dynamic Capability Catalog 延后，直到更多 capability 被 Halfcode 管理。届时 catalog 是 Halfcode effective registry/dependency snapshot 的投影，不是新的可写 authority。
4. `AIAgentDefinition` 必须继续作为普通 Halfcode resource 被统一管理。当前只实现了已有 definition 的加载/冻结/执行和 runtime instance 的创建/复用；自主 definition authoring 与按任务选择属于本 Mission 必须恢复的能力。
5. Holon 新路径必须成为唯一基础：File-XNL organization snapshot + HolonExecutionBinding + TaskSpace + HolonCoordinator + MemberRuntime + generic Agent runtime。旧 VM/TaskTree autonomous Holon 路径的有效行为先迁移，再删除旧实现。
6. “打通”必须区分 contract/runtime 接线与自治产品闭环：目前 Ctrl/Data 已能单次调用组织任务，但没有 canonical actor 持续推进完整 TaskSpace。因此当前不能宣称最终自治 Holon runtime 已完成。

## 2. 当前实际态与代码地图

### 2.1 AI Data 与 SubFlow

- depa-flows 的 `AIDataWorkflow` 接受 `EntryNode`、`TransformNode`、`SinkNode`、`SubFlowNode`、`ReturnNode`。
- `SubFlowNode` 通过 `eager-data-flow://<FQN>` 调用已注册子 Flow；inputs 与目标 `FlowContract.inputPorts` 精确相等，outputs 由目标 `outputPorts` 派生。父 Flow 不可寻址子图内部 port/completion。
- 当前 AI Data autonomous control 的 `assertCapability` 只接受 `TransformNode | SinkNode`，因此自主 Controller 无法添加或重连 `SubFlowNode`。
- 当前 RunGraph/checkpoint 已拥有 generation、patch history、invalidation、node result 与 recovery authority。新增子图能力必须复用这个 owner，不能引入 GoalGraph store。

主要位置：

- depa-flows `docs/flow-dsl/spec/ai-workflow/data-workflow.md`
- depa-flows `docs/flow-dsl/spec/eager-data-flow/nodes.md`
- depa-flows `packages/eager-data-flow-contract/src/index.ts`
- depa-flows `packages/eager-data-flow-logic/src/source-loader.ts`
- depa-flows `packages/eager-data-flow-logic/src/runtime.ts`
- depa-flows `packages/ai-data-workflow-contract/src/index.ts`
- depa-flows `packages/ai-data-workflow-logic/src/autonomous-control.ts`
- depa-flows `packages/ai-data-workflow-logic/src/filesystem.ts`
- Eidolon `cell/packages/ai-organ-logic/src/workflow/runtime/AIDataAutonomousControlRunner.ts`

### 2.2 AIAgentDefinition 与“动态 Agent”

当前已经具备：

- Halfcode ResourcePackage/Catalog/KindDefinition 加载与 effective registry。
- depa-flows 对完整 `AIAgentDefinition`、MessagePrefix、ContextPipeline、schemas、ToolRefs、EffectPolicy、MaterialPorts 和 dependency freeze 的 projection。
- Eidolon 将 frozen `AIAgentDefinition` 投影到通用 AgentRegistry、actor/session/provider/tool runtime。
- `runAgent` 首次创建 runtime instance，`runTargetedAgent` 按 `{byId}|{byName}` 复用 exact instance。

当前没有：

- Controller 在运行时产生新的 `AIAgentDefinition` resource document/patch。
- Halfcode 对 AI 提案执行受审计、可校验、可提交的 resource authoring transaction。
- 新 definition 的 exact content identity、dependency closure、publication/admission receipt 被父 RunGraph/child run引用。
- Controller 基于 typed task requirement 在多个 definition candidate 中自主选择。

当前 `AIDataAutonomousControlLoop.selectAIDataAgentDispatch` 中的 `mode="new"` 仅代表“新 runtime instance”；`resolveAIDataDynamicAgentBinding` 仍要求已有的 `agentDefinitionRef + taskProofRef`。后续实现和文档必须禁止继续把 instance creation 称为 definition creation。

主要位置：

- Halfcode `packages/resource-core/src/**`
- Halfcode `docs/resource-dsl/**`
- depa-flows `packages/ai-workflow-logic/src/agent-resources.ts`
- depa-flows `packages/ai-workflow-logic/src/run-freeze.ts`
- depa-flows `packages/ai-workflow-logic/src/agent-invocation.ts`
- Eidolon `cell/packages/ai-organ-logic/src/resources/EidolonAppResourceRegistryAdapter.ts`
- Eidolon `cell/packages/ai-organ-logic/src/workflow/runtime/AIDataAutonomousControlLoop.ts`
- Eidolon `cell/packages/ai-organ-logic/src/workflow/runtime/AIDataAutonomousControlRunner.ts`

### 2.3 新旧 Holon 路径

新的 canonical 路径已经实现：

```text
File-XNL organization authority
  -> issuer snapshot + receipt
  -> frozen HolonExecutionBinding / Workflow HolonTaskTarget
  -> independent TaskSpace
  -> HolonCoordinator assignment
  -> MemberRuntime + generic Agent runtime
  -> TaskSpace settlement
  -> Ctrl checkpoint / Data MaterialPort
```

关键代码：

- `cell/packages/ai-organ-logic/src/organization/HolonCoordinator.ts`
- `cell/packages/ai-organ-logic/src/organization/HolonMemberRuntime.ts`
- `cell/packages/ai-organ-logic/src/organization/HolonWorkflowTaskRuntime.ts`
- `cell/packages/ai-organ-logic/src/workflow/runtime/WorkflowRuntimeService.ts`
- `cell/packages/ai-organ-logic/src/workflow/tools/WorkflowRuntimeTools.ts`
- `cell/packages/ai-organ-logic/tests/workflow/holon_execution_binding_registry.test.ts`

缺口是 `processHolonTask`/`workflow holon-process` 一次只处理一个外部指定 task，没有长生命周期 actor 订阅 TaskSpace 并持续推进 ready frontier。

旧路径位于：

- `cell/packages/ai-organ-logic/src/organization/AutonomousHolonTaskRunner.ts`
- 旧 VM actor/task tree/organization tools 与相关 tests。

旧 runner 能扫描旧 TaskTree、筛选 roster、claim、发送 mailbox 消息、维护 active/idle、等待后台任务与发出事件，但会在检测到 canonical Holon Task authority 时直接跳过。因此旧路径不能驱动新 TaskSpace，新路径也尚未吸收其自动循环。

## 3. 术语与禁止混淆

| 术语 | 本 Mission 精确定义 |
| --- | --- |
| Definition authoring | 创建或修订 Halfcode resource authority 中的 `AIAgentDefinition` 文档/资源版本 |
| Definition selection | 根据 typed task requirement 从多个已验证 definition projection 中选择 exact resource revision |
| Instance creation | 从 frozen definition 创建一个 Eidolon runtime Agent instance/session |
| Instance targeting | 通过 `{byId}` 或 `{byName}` 复用已存在 instance |
| SubFlow | 父 Data Flow 通过 contract 调用子 Flow；子 invocation/run 有隔离状态 |
| Mission Controller | 观察 canonical RunGraph/verification 并提出 patch 的 resource-managed Agent actor，不是 graph owner |
| canonical Holon task pump | 持续观察 TaskSpace readiness、经 Coordinator 分配并驱动 settlement 的长生命周期 actor |
| Capability Catalog | 当前 run 的 frozen admission projection；本 Mission 不把它升级为动态资源 authority |

## 4. Authority ledger

| Fact | Grade | 唯一 owner | 本 Mission 规则 |
| --- | --- | --- | --- |
| AI Data graph/generation/patch history | canonical runtime fact | depa-flows Flow checkpoint owner | Mission Controller 只提案；admission 后由现有 transition 提交 |
| parent-child flow relation | canonical run relation | parent RunGraph node + exact child invocation receipt | 不另建 GoalGraph；父层不穿透子图内部 state |
| child workflow runtime state | canonical runtime fact | child Flow checkpoint owner | 独立恢复；父节点只保存 ref/status/output receipt |
| resource document | authored fact | Halfcode authoring authority | AI 生成的是 proposal；只有 resource authoring transaction 可写 |
| effective resource view | derived projection | Halfcode effective registry composer | selection 只读，不反写 registry |
| frozen resource closure | immutable run fact | Halfcode dependency snapshot/freeze owner | 新 child run 使用新 revision；不得改 parent frozen snapshot |
| AgentDefinition selection decision | proposal/admission fact | Controller proposal + typed selector admission | 必须引用 exact candidate/resource identity |
| Agent runtime instance/session | canonical runtime fact | Eidolon generic Agent/Conversation runtime | 不由 Workflow 或 Halfcode复制 |
| organization master data | canonical domain fact | Holon File-XNL authority | Workflow/TaskSpace 只消费 issuer snapshot/receipt |
| TaskSpace tasks/relations/claim/settlement | canonical runtime fact | TaskSpace owner | pump 只能发送 typed commands，不直接改 snapshot |
| Holon routing/member runtime refs | deployment runtime fact | Holon deployment/Coordinator actor | 不能成为 task 或 conversation owner |
| Flow consumption of task result | canonical Flow transition | parent Flow checkpoint owner | 仅消费 accepted settlement/material receipt |

## 5. 递归 Data Flow，而不是 GoalGraph

### 5.1 目标结构

```text
AIDataWorkflow RunGraph
  ├─ observation / verification nodes
  ├─ Transform/Sink/Agent nodes
  ├─ SubFlowNode -> child AIDataWorkflow definition/instance/run
  │                   ├─ local nodes
  │                   ├─ Holon TaskSpace node
  │                   └─ nested SubFlowNode
  └─ ReturnNode
```

分层目标不是另一种 graph kind，而是子 Flow 的 contract、输入、输出、verifier 与 completion semantics。父图通过 child receipt 获知“子目标是否完成”，类似 Codument 父 Mission 持有子 Mission/Track 的 lifecycle evidence。

### 5.2 自主控制协议扩展

现有 `add-capability/rewire-capability/remove-node` 协议需要增加结构化子流操作，或者抽象成仍然 closed 的 node-source union。无论采用哪种内部命名，都必须满足：

- Controller 只提交 `subflow resource ref + exact contract binding + input bindings`，不能提交任意 host path 或 implementation object。
- admission 从 Halfcode/depa registry 解析目标 definition 与 contract，验证 input/output schemas、依赖 DAG、禁止直接/间接递归。
- patch 仍下降为现有 `AIDataWorkflowGraphPatch` 并由同一 owner 提交。
- observation 能显示 child ref、child run status、latest receipt、output schemas 与 failure summary，不暴露子图内部可写引用。
- invalid/stale/missing child resource 返回 typed feedback，graph 不变。

### 5.3 Durable child invocation

基础 EagerDataFlow 的 isolated invocation 需要在 AIData 长任务 profile 中扩展为 durable child lifecycle：

1. admission 冻结 exact child definition revision/contract/dependency closure。
2. 父 `SubFlowNode` 首次执行时创建 child instance/run/checkpoint，并把稳定 child run ref 记入父节点扩展事实。
3. child 未终态时，父节点保持 Running/Waiting，不伪造 output。
4. fresh reconstruction 通过 child run ref 恢复或查询 child checkpoint；已接受的 child effect/result 不重复执行。
5. child 成功后生成 contract-validated completion receipt，父节点原子接受 outputs。
6. child fault/cancel 规范化为父节点 failure evidence；Controller 可根据 observation 修订父图或创建 successor child run，但不能重写旧 child history。

## 6. 自主 Halfcode AIAgentDefinition authoring 与选择

### 6.1 Generic Halfcode authoring transaction

Halfcode 只提供通用资源 authoring 能力，不引入 AI 领域语义。建议的数据/处理边界是：

```text
ResourceAuthoringProposal
  -> parse/KindDefinition/source-shape validation
  -> closed ResourceAuthoringPlan
  -> explicit ResourceAuthoringPort effect
  -> atomic authority write / CAS
  -> ResourceAuthoringReceipt
  -> refresh EffectiveResourceRegistry
```

要求：

- proposal 是普通 closed data；代码引用仍走 Halfcode code-package/resource rules。
- plan/apply 分离，apply 绑定 expected revision/content identity，防止 silent overwrite。
- source document、logical path、resource id、content digest 和 provenance 可审计。
- 失败不产生半个 resource，也不修改 effective registry。
- runtime-created resources 进入明确的 working/runtime authoring layer；是否长期提升为 workspace/package 资源是后续显式操作，不由成功运行自动决定。

### 6.2 AIAgentDefinition-specific projection

depa-flows 在 generic receipt 之上验证：

- root kind/apiVersion/version 和 canonical KindDefinition；
- MessagePrefix、ContextPipeline、workspace `AGENTS.md` source、schemas、ToolRefs、EffectPolicy、MaterialPorts；
- code/resource refs 的 dependency closure；
- input/output contract 与任务需求；
- semantic fingerprint 和 exact frozen task proof。

Eidolon 不自行解析 XNL 私有字段，只消费 depa-flows 的 typed projection并复用现有通用 Agent runtime。

### 6.3 Definition selection

选择协议至少包含：

- `AgentTaskRequirement`：input/output schema、required effects/tools/material ports、context needs、task objective 与可选 policy constraints。
- `AgentDefinitionCandidateProjection[]`：来自当前 Halfcode effective registry 的 exact refs/revisions 与可机器校验的 typed capability facts。
- `AgentDefinitionSelectionDecision`：选择 existing candidate 或请求 author-new；模型解释可以作为 evidence，但 admission 只依赖 typed fields。
- `AgentDefinitionSelectionAdmission`：复核 schema/effect/tool/policy compatibility，冻结 exact task proof。

禁止按文件名、Agent 名称或 prompt 文本在代码中做 fuzzy routing。自主选择是模型/Controller 的 proposal，compatibility 与 resource identity 由确定性 Processor 证明。

### 6.4 与 frozen parent run 的关系

动态创建资源不能篡改 parent definition freeze。正确关系是：

- parent run 的原始 dependency snapshot 保持不变；
- authoring transaction 产生新 resource revision/receipt；
- 新增的 Worker node 或 child Flow invocation 引用这个 exact receipt，并为新的 executable binding 建立增量 run proof或独立 child run freeze；
- parent checkpoint记录 proof/ref，不把新资源内容复制为第二 authority；
- recovery 依 exact resource identity 重建，缺失即 fail closed。

## 7. Capability Catalog 延后策略

本 Mission 不构建动态 Capability Catalog。过渡期规则：

- 既有 frozen catalog 继续服务于旧 Transform/Sink capability admission。
- SubFlow 和动态 AIAgentDefinition 通过 exact Halfcode resource/proof 进入新的 typed admission surface。
- 不扫描目录，不允许 Controller写 catalog，不维护 catalog 与 registry 的双向同步。
- 等 Tool、Skill、Processor、Flow、AgentDefinition 等资源化覆盖足够后，单独规划“Halfcode registry -> Capability Catalog projection” Mission/Track。

## 8. Canonical Holon task pump

### 8.1 Actor 边界

建议在现有 Holon deployment/Coordinator 之上建立长生命周期 pump actor，而不是把循环塞进 CLI 或 `WorkflowRuntimeService`：

```text
TaskSpace snapshot/change signal
  -> HolonTaskPump mailbox
  -> observe ready frontier
  -> HolonCoordinator assignment proposal
  -> TaskSpace claim command/CAS
  -> ensure MemberRuntime
  -> mailbox dispatch execution
  -> TaskSpace start/settle/fail command
  -> observe next ready frontier
  -> terminal TaskSpace receipt
  -> notify parent Workflow actor
```

TaskSpace owner仍是 task/claim/settlement 单写者。Pump actor只拥有 subscription cursor、in-flight correlation、retry/backoff/idle control 和 actor refs；不能直接修改 TaskSpace snapshot。

### 8.2 从旧 runner 迁移的能力清单

| 旧能力 | 新归属 | 迁移判据 |
| --- | --- | --- |
| 扫描 claimable task | TaskSpace ready frontier/query | 只读取 canonical TaskSpace relations/status |
| roster eligibility | HolonCoordinator + frozen snapshot/binding | 不读取旧 VM organization projection |
| claim race handling | TaskSpace CAS command | 幂等 receipt、冲突后重新观察 |
| member assignment | HolonCoordinator | workflow 不预选 Member |
| 给 member 发送工作消息 | MemberRuntime mailbox dispatch | 不直接调用 member 内部方法 |
| member active/idle | MemberRuntime/Coordinator actor facts | task completion后可观测，idle 不删除 task truth |
| background settle/tick | pump mailbox loop + bounded scheduler | 不依赖 VM tickUntilBackgroundSettled |
| claim/idle/event observability | canonical actor/TaskSpace events + readonly projection | 不保留旧 autonomous_holon_event authority |
| shutdown/retirement | actor lifecycle command | retirement 单向且可恢复 |

### 8.3 恢复与幂等

- 每个 assignment/start/settlement/failure 使用稳定 command id 和 TaskSpace expected revision。
- Agent 完成但 settlement 前崩溃：恢复后先查询 receipt，存在则 replay，不重复 provider execution；若只存在 Agent run receipt，则完成 settlement。
- pump 崩溃不改变 task owner；fresh actor 从 TaskSpace snapshot和 deployment refs 重建 subscriptions/in-flight projection。
- lease expiry、retry、terminal failure 通过 TaskSpace command表达，不能靠内存计时器成为唯一事实。
- TaskSpace terminal 后向 parent Workflow 发送 exact completion receipt；父 Flow checkpoint 再消费，避免跨 owner transaction。

## 9. 旧路径删除门禁

删除顺序必须是“行为盘点 -> 新 actor parity -> products 切换 -> E2E -> 静态引用清零 -> 删除”，不能先删再猜：

1. 为旧 runner 每项有效行为建立新路径测试映射。
2. 所有 product/bootstrap/Tool/CLI 组合改为 canonical pump；旧 runner不再被实例化。
3. Ctrl/Data 多任务 E2E 在没有 `holon-process` 的情况下通过。
4. source search 证明旧 TaskTree autonomous Holon symbols只剩明确的迁移文档，然后删除实现、exports、tests、fixtures、events和 compatibility schema。
5. 运行完整 actor/organization/workflow/CLI regression，确认普通非 Holon TaskTree 行为没有被误删。

不得保留“默认关闭但可重新启用”的旧 product path；如存在只读历史 migration decoder，必须明确其单向用途且不能驱动任务。

## 10. E2E 验证矩阵

| 场景 | Ctrl Workflow | Data Workflow | 必须证明 |
| --- | --- | --- | --- |
| 多任务依赖 | 顺序/分支 task 完成后恢复 Ctrl node | 多 task outputs 映射到 typed MaterialPorts | pump 自动推进 ready frontier |
| AgentDefinition 选择 | 至少两个 candidate，选择满足 task contract 者 | 同上并将结果交下游 port | 不是按名称硬编码 |
| 动态 Definition 创建 | 缺少 candidate 时创建 Worker definition | 创建并执行新的 transform Worker | 真实 Halfcode receipt/freeze |
| 子 Flow | Ctrl 可调用承载 Data child run 的 processor/typed boundary | 自主 patch 加入 durable SubFlowNode | 无 GoalGraph/双 graph owner |
| 执行失败 | member/Agent 一次失败后由 task policy重试或失败 | failure observation触发 graph/task纠偏 | 没有重复 accepted effect |
| fresh recovery | pump/Workflow runtime 重建 | parent和child checkpoint重建 | refs/receipts 足够继续 |
| organization replan | 显式采用新 snapshot并创建 successor task/run | 新 snapshot只影响 successor | in-flight frozen target不漂移 |
| terminal consumption | Ctrl checkpoint接受 settlement | Data Return/MaterialPort接受 output | TaskSpace先 durable settle |

反作弊要求：

- 测试不得逐任务调用 `WorkflowProcessHolonTask` 或 CLI `holon-process`。
- harness不得预写 expected graph patch、expected AgentDefinition 或 candidate choice。
- dynamic definition必须在测试开始时不存在于 effective registry。
- recovery必须销毁 runtime对象并从文件/checkpoint重建。
- 历史 mission report不能替代当前 HEAD 的运行证据。

## 11. 跨项目 Track 边界

| ProjectRef | 真实 Track | owner 范围 |
| --- | --- | --- |
| `depa-flows` | `add-autonomous-ai-data-subflow-composition` | SubFlow control contract/admission、durable AIData child invocation/checkpoint |
| `halfcode` | `add-transactional-runtime-resource-authoring` | generic resource proposal/plan/apply/CAS/receipt/effective registry refresh |
| `depa-flows` | `add-autonomous-agent-definition-authoring-and-selection` | AIAgentDefinition authoring projection、typed candidates/selection/admission/freeze |
| `eidolon-anchor` | `integrate-autonomous-agent-resource-authoring` | Controller tools/ports、Halfcode adapter、generic Agent runtime execution/recovery |
| `eidolon-anchor` | `add-canonical-holon-taskspace-pump` | actor pump、Coordinator/TaskSpace/MemberRuntime lifecycle与迁移 parity |
| `eidolon-anchor` | `retire-vm-autonomous-holon-tasktree` | product切换、旧路径删除、compatibility/static gates |
| `eidolon-anchor` | `verify-recursive-ai-data-and-canonical-holon-e2e` | Ctrl/Data综合产品 E2E、当前回归修复、完成审计证据 |

`holon-workbench` 是组织主数据与 File-XNL snapshot authority 的观察项目。本 Mission 默认不修改其中立 domain；只有 E2E 发现真实 contract 缺口时，才经 replan 新增该项目 Track。

## 12. 控制论 Mission loop

```text
@delimiter: --
@node: #
@marker: ?
-- #loop ?mission until="all success criteria hold on current sources and fresh tests"
---- #step ?observe
读取 Mission/Track authority、四项目当前源码与 dirty-state、Halfcode resource facts、AI Data checkpoints、TaskSpace/actor receipts和测试证据。
---- /?observe
---- #step ?compare
逐项比较递归 SubFlow、AgentDefinition author/select、canonical pump、旧路径删除与 Ctrl/Data E2E 的 desired/actual state。
---- /?compare
---- #switch ?reconcile on="observed gap"
------ #case ?ready when="planned Track boundary仍成立"
-------- #step ?apply
在 owner项目创建、绑定、执行、验证和归档真实 Track；保留他人 dirty hunks。
-------- /?apply
------ /?ready
------ #case ?drift when="现有 authority/API/依赖使计划失效"
-------- #step ?replan
写 replan report，修订 Mission DAG/Track边界，不创建平行 authority 或缩水验收。
-------- /?replan
------ /?drift
------ #case ?evidence_gap when="实现看似完成但证据不覆盖原目标"
-------- #step ?strengthen
增加当前 HEAD 的产品 E2E、fresh recovery、静态删除或 resource receipt 证据后重新观察。
-------- /?strengthen
------ /?evidence_gap
---- /?reconcile
-- /?mission
```

## 13. 重规划触发器

- 基础 Eager SubFlow 无法承载 durable AIData child checkpoint：保持 SubFlow产品语义，新增 profile extension，而不是退回 GoalGraph。
- Halfcode 当前只有 loader、缺少安全 write transaction：先补 generic authoring Track，不在 Eidolon私建资源 store。
- 动态资源与 parent freeze 冲突：创建 exact child/additive run proof，不修改已冻结 parent snapshot。
- Agent selection 需要更多 capability metadata：只增加 typed AIAgentDefinition projection；不提前建设通用动态 Capability Catalog。
- canonical pump 发现 TaskSpace缺少 query/receipt/lease命令：在真正 owner项目通过新 Track补齐，不回写 VM TaskTree。
- 删除旧 runner导致普通非 Holon TaskTree回归：只恢复普通 TaskTree能力，不恢复 autonomous Holon第二 authority。
- 当前工作树有其他 session重叠：先通过 `.tmp/chat.jsonl` 协商、重读文件和拆分 hunk；不得覆盖或回滚他人成果。

## 14. 完成审计

Mission 完成前逐项检查：

- 所有七个 linked Track 真实存在、已绑定、已完成并归档或有明确 supersede evidence。
- 源码没有 `GoalGraph`、第二 graph state owner或 dynamic catalog authority。
- dynamic definition creation、definition selection、instance creation、instance targeting 各有独立测试。
- canonical Holon pump 是 product bootstrap 唯一路径；旧 runner及兼容 surface引用清零。
- Ctrl/Data综合 E2E在当前 HEAD fresh运行且不使用逐任务 process命令。
- depa-flows、Halfcode、Eidolon相关 strict validation/typecheck/tests通过。
- Mission proposal的九条成功判据均能回指源码、测试输出和 Track report。
