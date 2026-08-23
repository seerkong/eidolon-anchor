# Mission Design：Resource-native App 与系统 Skill 控制面

## 控制目标

期望态由四层相互独立的 authority 构成：

1. Halfcode 提供通用 XNL resource package、catalog、KindDefinition、normalized ResourceTree、layering、revision/provenance、SkillCapsule dependency closure 与 deterministic distribution plan。
2. depa-flows 消费 Halfcode normalized facts，只定义 AI Workflow、Agent、Material 和 run freeze 的领域契约与投影。
3. Eidolon 消费上述公开 API，拥有 global/workspace root binding、App resource registry adapter、actor/effect/session runtime、global init、TUI/CLI/native tools。
4. 具体 App ResourcePackage 组合 workflow、agent、skill、prompt、schema 和 material；非 workflow 内容必须留在其 owner 项目。

实际态由三个可写 ProjectRef 对应项目中的代码、published package API、canonical docs、tests、track 状态，以及本 mission 的 analysis/reports 投影构成。`sparrow-python-reference` 只绑定 Python workflow fixture 与 host persistence 作为历史证据，不接受写入；其他翻译项目不参与本轮判据。ACE Workbench 只提供系统 Skill 分层证据，不成为新的 authoring authority。

## 历史纠偏证据与不可回退约束

本节是压缩安全的 requirements ledger。后续 track 必须把本节与本 track 相关的条目复制进自己的 proposal/design/behavior/decision，而不能仅引用聊天或 ignored analysis。

| 主题 | 已接受的目标 | 明确否决或退出 authority 的方案 |
|---|---|---|
| 资源 authority | Halfcode 唯一拥有 ResourcePackage/Catalog/KindDefinition/layer/revision/provenance | depa-flows/Eidolon 第二 scanner、catalog、overlay 或 resource compiler |
| workflow authority | depa-flows 拥有 Ctrl/Data DSL、AIAgentDefinition、Material、instance/run/state 语义 | Eidolon host 重新定义 workflow state machine 或目录语义 |
| Agent runtime | Eidolon 复用通用 actor/session/provider/tool/effect lifecycle | workflow-specific Agent runner、history、compactor 或 session store |
| Processor | 底层函数保持 runtime 首参；普通调用与 target invocation 分别遵守两种 DEPA 公式 | 在底层闭包隐藏 runtime、让核心逻辑读取全局或 outer host |
| typed DX | canonical 与 bound facade 都使用 `runAgent`/`runTargetedAgent`；public authored API 不需要 generic effect id/operation envelope | public `runtime.ai.effects.invoke({ operation: "ai.agent" ... })` |
| selector | closed union `{byInstanceId}` 或 `{byInstanceName}`，参数名统一为 `selector` | `{by:"instance-id", instanceId}`、互相重复的 targets/payload |
| state owner | Agent instance references 属于 run-local AI Workflow profile state；checkpoint 是一个 run 的 live authority | 新建平行 `system.json`、按事实类型横向分散多个可写 store |
| filesystem | Definition→frozen Instance→Run checkpoint；run/evidence 聚合在 instance 下 | `instances/<id>.json` 仅作索引、definition bundle 与 run facts 分散在 sibling roots |
| recovery | definition 修改隔离；seed 只初始化；旧 flat facts 单向迁移；新布局单写 | fresh resume 重读 live definition、运行态反写 seed、legacy/new 双写 |
| AI 语义 | host 只校验 typed selector/ref/revision/receipt/policy | regex、keyword、substring 或 topology label 猜语义 |

该 ledger 来自当前任务持久 user-message record 的连续修正，并由下列 executable evidence 复核：Python multistep fixture 的 input/config/state 端口与 step state；Python host 的 definitions/instances 物化、instance-local step facts 与 runs/checkpoint；depa-flows `order-fulfillment` 的 state.def/state.seed/config facets；当前 depa `materializeInstance`、WorkCtrl snapshot、AIData RunGraph；当前 Eidolon flat `WorkflowFactStore`。不得查看或引用其他翻译项目来覆盖这些结论。

## Project 与写入边界

- `eidolon-anchor` 是 host，拥有 mission 控制面、Eidolon adapters、system Skill installation、runtime 和产品验收。
- `halfcode-compiler` 是 external，拥有全部通用 resource/SkillCapsule compiler changes。
- `depa-flows` 是 external，拥有全部 AI Workflow/Agent/Material 领域资源 changes。
- invocation session 提供 ProjectRef 到 workspace 的临时 binding；持久 mission、track、decision 和 report 不记录机器路径。
- 如果未来为具体非 workflow App 确认新的 owner 项目，必须以 evidence 驱动的 replan 增加 ProjectRef；不得把临时目录或仓库路径写进现有 ProjectRef。

## 资源 authority 与编译链

canonical pipeline 固定为：

```text
XNL ResourcePackage authority
  -> Halfcode loader / Kind registry / layered ResourceTree
  -> domain consumer projection（depa-flows 或其他 Kind owner）
  -> Halfcode SkillCapsule / distribution plan 或 Eidolon App registry adapter
  -> Eidolon staged global installation / actor runtime
```

`AIWorkflowAppBundle` 可以保留为 workflow 领域级 App projection 或 entrypoint collection，但不得拥有通用 Catalog、目录扫描、overlay 或安装 authority。Eidolon 的 root path、global-only policy 和安装 transaction 是 host policy，不进入 Halfcode parser，也不进入 depa-flows definition。

## Skill 拓扑

安装后的目标依赖图：

```text
sys-eidolon-anchor-devops
├── Code -> sys-eidolon-anchor-authoring
│           ├── base grammar -> sys-halfcode-resource-dsl
│           └── selected Kind -> generated versioned references
└── Deploy / Operate / Monitor -> sys-eidolon-anchor-run
```

职责边界：

- `sys-halfcode-resource-dsl`：只描述 ResourcePackage、Catalog、KindDefinition、XNL channels、source shapes、identity/ref、VFS、authority/projection 与静态诊断；不写 workspace、不调用 Eidolon tools。
- `sys-eidolon-anchor-devops`：薄的 Plan/Code/Build/Test/Release/Deploy/Operate/Monitor/Improve 生命周期路由器，只传递阶段事实并加载专属 Skill。
- `sys-eidolon-anchor-authoring`：拥有 `operations/`、AuthoringChangePlan、CAS/digest apply、resource Kind 选择与 diagnostics routing；不拥有通用 DSL 或领域 Kind 真源。
- `sys-eidolon-anchor-run`：拥有已发布 resource entrypoint 的 resolve、binding/instance、start/resume/resolve/reject、inspect/replay 与 evidence 操作；不加载 authoring grammar，不修改 definition。`Cancelled` 只在既有 typed wait-resume protocol 明确支持时作为 outcome，不扩张为通用 run cancellation contract。

Halfcode SkillCapsule 必须显式表达 sibling Skill dependency 或等价 typed relation，编译器校验 identity/version/closure 和 target collision，并生成一次多 capsule distribution plan。Eidolon 只消费该计划并执行 staged atomic replace；不得重新实现 capsule dependency resolution。

## Authoring 与运行事实分离

Authoring 产生 ResourcePackage source revision、validation/build evidence 与 release candidate；Release 固化 immutable artifact；Deploy 生成独立 binding/instance；Run 生成 session/run id、snapshot、RunGraph 和 receipts。运行 evidence 不回写 source definition。

Resource-native publication 必须以整个 workspace ResourcePackage 为 transaction boundary：candidate 保留既有 Agent/Prompt 等资源，经过 Halfcode/depa proof 后，以 expected base package revision 做 CAS，再原子替换 `.eidolon/resources`、刷新 component-owned registry 并验证同一 snapshot 的 readback。`.eidolon/workflows` 中的 legacy workflow bundle 仍是 VFS authoring artifact，不能仅通过返回 `resource://` 字符串取得 ResourcePackage authority。

AI Workflow Agent 节点使用 `resource://<agent-fqn>` 指向 `AIAgentDefinition`。depa-flows 编译 ordered messages、resource/material refs 与 semantic fingerprint；Eidolon adapter 将 normalized agent definition 投影到已有 AgentRegistry/actor config，并通过通用 actor/mailbox/provider/tool/session runtime 执行。不得复制 agent runner，也不得创建 workflow-specific history、compactor 或 session store。

完整执行 profile 要求每个标准字段都有确定 owner。depa-flows 投影 closed JSON Schema、exact effect policy 和 Material value delivery facts；Eidolon 的通用 Agent runtime 在 dispatch 前验证 message/input/Material，在 child 返回后验证 output，并把 exact MaterialPort 顺序的 immutable typed context 交给同一 delegate actor。标准 contract 不得再以 `unsupported-profile` 作为成功终态；只有 malformed、unknown-version 或 runtime 无法证明的扩展 contract 才 fail closed。

## Definition、Instance 与 Run envelope

目标物理模型恢复为 depa-owned store contract，而不是 Eidolon 私有目录约定：

```text
definitions/<definition-revision>/
  complete immutable bundle

instances/<instance-id>/
  frozen definition bundle + instance metadata
  runs/<run-id>/
    checkpoint.json
    run-local derived projections / evidence
```

首次 start 在执行任何节点前冻结完整 bundle，包括 code、manifest、`state.def`、`state.seed`、config facets 与 referenced local materials，并记录 source revision/digest/provenance。后续 start/resume/recovery 只从 instance copy 编译；live definition 变化只影响新 instance。host 可以选择物理根和 durable backend，但不得改变这个 hierarchy/authority，也不得把 path policy写入 depa contract。

每个 run 只有一个 canonical checkpoint。checkpoint 至少包含 run/instance/definition identity、version/CAS、input/config/state/output、controller/node sidecars、profile-owned durable state 与稳定 effect/actor/session references。Ctrl 的 WorkCtrl snapshot与 Data 的 RunGraph 是该 checkpoint 的 typed profile payload；events、receipts、node files和查询索引是单向 projection，不可反写 checkpoint。`state.seed` 作为 instance 冻结 bundle 的只读 facet 被复制，每个新 run checkpoint 恰好应用一次；instance 本身不产生第二份 mutable Flow state。

## Agent invocation Processor、facade 与 selector

depa-flows public logic 冻结两个标准 Processor：

```ts
runAgent(agentRuntime, input, config)

runTargetedAgent(agentRuntime, selector, invocation, config)
```

`runAgent` 对应普通三参数公式；`runTargetedAgent` 是本领域对 targets 公式的单目标寻址 specialization，参数在 contract、logic、runtime adapter、generated code、docs 与 Skill 中统一命名为 `selector`。bootstrap 可以把 `agentRuntime` 闭包绑定成同名 facade，因此 authored flow 调用 `runtime.ai.effects.runAgent(input, config)` 或 `runtime.ai.effects.runTargetedAgent(selector, invocation, config)`；这种便捷形态不能反过来替代底层 Processor，也不能让 runtime logic消失。

selector 是 closed、互斥、plain-data union：

```ts
type AIAgentSelector =
  | { readonly byInstanceId: string; readonly byInstanceName?: never }
  | { readonly byInstanceName: string; readonly byInstanceId?: never }
```

`runAgent` 返回 output 与稳定 instance reference，至少含 `instanceId`，可选 authored `instanceName` 与 Eidolon opaque session reference。AI Workflow profile state 同时维护 id index 与 name index；只记录稳定 refs、generation/effect receipts和恢复所需绑定，不复制 actor conversation/history/state。

`instanceName` 在同一 Flow run 内必须唯一。selector 是 closed mutually-exclusive union：同时提供两键、缺键、空值、未找到、id/name 指向冲突或重复名称都必须 fail closed；`runTargetedAgent` 不得在解析失败时退化为 `runAgent` 或静默创建新 Agent instance。

## Ctrl/Data DSL 使用方式

- AICtrlWorkflow 保持 WorkCtrlFlow substrate grammar；Agent invocation 是 AI profile 对 typed task/effect 的解释，不把角色特定 `AgentTask` 塞进 generic WorkCtrlFlow grammar。
- AIDataWorkflow 在 RunGraph node 的 processor/config 中声明同一 typed task；selector 可以来自 authored constant 或前驱节点返回的 instance reference。
- 两个 profile 都必须把 resolved selector、instance binding 和 execution receipt写入同一 run checkpoint 的 AI profile state；后续节点和 fresh recovery从该 owner解析。
- authoring/static proof 必须理解 named methods 与 selector binding；`invoke` 仅可留在 runtime internals，generated flow-code、Flow DSL references 和系统 Skill 不得继续教授它。

## Eidolon persistence 与迁移边界

Eidolon 只实现 depa store/support port和 root binding。现有 `WorkflowFactStore` 的 `ctrl/`、`runs/`、`ai-state/`、`data-graphs/`、`agent-executions/` 等 flat facts必须被分类为 migration input或 derived projection：

1. 旧 run 通过显式 legacy reader或一次性 migration生成 canonical instance/run checkpoint。
2. 新 runtime只写 checkpoint owner及其受控 projection，不向旧/new两套 authority双写。
3. migration以 durable attempt/CAS 实现中断恢复和幂等；完成后 legacy facts只读。
4. generic Eidolon actor/session/effect lifecycle继续拥有实际 Agent execution；Flow checkpoint只保存 stable reference与receipt。
5. authoring ResourcePackage、publication receipt与 runtime instance store保持不同 lifecycle，不把 authoring workspace当运行实例。

## Track 切片原则

- Halfcode track 只改变通用机制或 Halfcode-owned SkillCapsule，不写 Eidolon policy。
- depa-flows track 只改变 workflow domain contract/logic/docs/examples，不实现 host roots、installer 或 actor provider。
- Eidolon track 只消费公开 package API，负责 adapters、system authority、tools、installation 与用户 surface。
- 每个 candidate TrackLink 只在一个叶任务上出现一次；真实 track 创建后原地绑定，验收和归档由该 track 自己拥有。
- 已完成但未归档的 `optimize-ai-workflow-authoring-control-loop` 作为回归基线；新 track 不重开其性能/proof/context-policy范围。
- 第一个 depa track先修复 Definition/Instance/Run 与 checkpoint authority；typed Agent invocation 必须在其后，不能先在 Eidolon 添加新的 state 文件。
- Eidolon typed facade track同时拥有 bootstrap typings、generated flow-code、authoring publication AST/type proof与新包禁用 authored generic `invoke` 的验收；Skill更新不能替代编译与发布门禁。
- historical evidence、已接受与已否决方案必须写入各 track 的 standard artifacts；analysis/report 只作补充恢复点。
- 原定 instance/run、typed Agent、Skill 与 E2E 验收完成后，单独使用 depa-expert 分析 checkpoint 写放大：深度参考 `task-manager-*` 的独立 TaskSpaceStore、`bp-ctrl-flow-*` 的 TaskStep exact-ref bridge，以及 Codument Track/Mission TaskSpace 的递归 TaskGroup/Task DSL、独立 Schedule 和 CLI-owned状态转换，建立同构但领域独立的 StepSpace/StepForest。节点通用状态与自定义扩展可评估同 run capsule 下的 versioned sidecar/projection，但必须通过同一个 StepSpace/checkpoint transition/CAS 录取，禁止形成可独立裁决的第二 authority。

## Codument 版本兼容

host mission 按当前工作区内置的 `codument/std` 规范维护 `mission.xnl`。当前系统正在开发中的新版 Codument CLI 只有在与目标 workspace authority 兼容时才作为验证入口；不兼容时使用目标项目规定的 XML/XNL parser、测试或其他 best-effort 验证。外部项目创建 track 时遵循目标项目自己的当前 Codument authority 和序列化格式，host mission 仅持久化路径无关的 ProjectRef 与 track id。

## 受控重规划

以下证据触发 replan：

- Halfcode 当前 API 已具备某个候选能力，track 可缩小或 supersede。
- Halfcode 的 layered registry 与 Skill distribution 需要拆成更多独立发布批次。
- depa-flows 的旧 AppBundle/catalog 已有外部消费者，需要兼容 projection 而不能直接删除。
- system Skill sibling dependency 无法由 Halfcode 当前 Kind contract 表达，需要先升级 KindDefinition 或 distribution API。
- Eidolon 的 system authority loader 仍强绑定单 Skill/stage，必须先拆 infrastructure 与内容 migration。
- 真实 TUI/CLI 验收暴露 provider、tool schema 或运行 receipt 问题，但不得以 workflow/product 名称增加 host 特判。
- 用户确认具体非 workflow App 的 owner 项目，需要新增 ProjectRef 和独立 track 分支。
- fresh resume 仍读取 live definition，或 Ctrl/Data/profile state 无法收敛到一个 run checkpoint owner。
- named Agent facade 需要通过破坏底层 runtime-first Processor 才能实现，或 selector/state 产生第二份 actor authority。
- legacy flat facts 无法在不双写的情况下迁移，需要先冻结兼容读取期限和恢复策略。

每次 replan 必须有 implementation/test/consumer evidence 或 human decision，写入 reports，递增 mission revision，并说明 actual、desired、diff 与 DAG 变化。

## 风险与控制

- 通用资源职责再次泄漏到 depa-flows/Eidolon：通过 dependency scan、public API review 和禁止第二 scanner/catalog 的静态验收控制。
- 多 Skill 安装出现部分版本：通过 Halfcode complete plan、Eidolon staging、全 closure preflight、atomic replace/readback 控制。
- generated references 漂移：每份输出记录 source FQN、apiVersion、content digest 与 generated-by；Eidolon 不允许手工修订生成正文。
- system Skill 同时生效导致双 authority：新四件套 readback 成功后才移除旧 `sys-ai-workflow`，失败时保留上一完整安装集。
- prompt 取代确定性验证：Skill 只做语义建模和 operation 选择，parser、catalog、containment、CAS、digest、build 和 state transition 必须由组件执行。
- 为自然语言方便增加 host 模糊匹配：所有 track 均加入 no-regex/no-keyword/no-substring/no-heuristic acceptance scan。
- 外部项目 Codument 格式漂移：由各 ProjectRef 自己的规范拥有，mission 不把某个 CLI 版本当作跨项目 authority。
- 历史设计再次因对话压缩丢失：以本 design ledger、mission decisions、track behavior delta 与 executable tests 四层互证，不接受只在聊天中的约束。
- instance/run backend 被误当成目录美化：验收必须证明 definition isolation、fresh-process recovery、CAS、path containment、derived index rebuild 和单一 checkpoint owner。

## 收口条件

mission 只有在全部 bound track 完成并由最终 acceptance track 证明以下事实后才能 completed：

- 通用 resource 和 Skill 编译只有 Halfcode 一个 authority。
- workflow domain resource 只有 depa-flows 一个 authority。
- Eidolon global init 安装四个版本一致的系统 Skill，旧单体 Skill 已退出 authority。
- authoring 使用 `operations/` 和生成 references，run 使用独立已发布资源操作协议。
- Resource-native workflow App 能通过 installed CLI/TUI 从自然语言创建、发布和运行。
- agent resource 复用 Eidolon 通用 actor/session/runtime。
- 标准 AIAgentDefinition 的 ordered messages、message/input/output schemas、exact tools、effect policy 与 Material delivery 全部可执行，并同时通过 AICtrlWorkflow、AIDataWorkflow 与恢复链路验证。
- Definition→Instance→Run 的 store contract由 depa-flows拥有，Eidolon只绑定 support；每个 run只有一个 canonical checkpoint owner。
- authored code、generated references 与系统 Skill只暴露 typed `runAgent`/`runTargetedAgent`，底层 Processor保持显式 runtime，selector仅为 byInstanceId/byInstanceName。
- Ctrl/Data 都能跨节点和 fresh process通过 Flow profile state复用 Agent instance，且不复制通用 actor/session/history authority。
- 旧 WorkflowFactStore 事实完成单向、幂等、可恢复迁移，新写入不再形成 flat并列真源。
- 无自然语言 host heuristic、无平行 resource scanner/catalog、无手工复制 Flow DSL。
