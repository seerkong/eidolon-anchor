# 设计：Eidolon StepSpace 与状态 sidecar 采用

## 1. Authority map

| 事实 | 唯一 owner | Eidolon 责任 |
|---|---|---|
| ResourcePackage、Workflow、StepSpace 与 extension descriptor | Halfcode effective registry + depa DefinitionStepForest | 冻结完整被选 closure；不扫描目录推断 membership |
| frozen Instance bundle 与 source identity | depa `materializeFlowInstance` | 提供 support root 与 exact source revision/digest/provenance |
| Run input/config/state/output/profile/stepExtensions | depa `FlowRunCheckpointStore` | 注入同一个 store/profile authority/codec registry |
| physical record/tree/receipt/head 与 fsync/CAS | depa `FilesystemFlowRunCheckpointStore` | 物理布局完全 opaque，不重做 codec/Merkle/transaction |
| Agent actor/session/provider/effect | Eidolon generic runtime-control | checkpoint 仅保存 opaque refs 与 depa typed Agent durable facts |
| Authoring candidate 与 publication proof | Eidolon authoring owner + Halfcode/depa loaders | 验证 closure 和 schema，不复制第二套 Step schema |

`DefinitionStepForest` 与 `RunStepStateIndex` 是两个不同投影：前者属于 frozen definition，后者属于每个 run 的 checkpoint 物理投影。Eidolon 不把其中任意一个序列化为新的 host schema。

## 2. Exact published dependency closure

本 track 绑定以下已发布 terminal-smallest versions；只有直接 import 的包进入 direct dependencies，但 lock/测试对完整 closure做ratchet：

- `flow-step-space-contract@0.1.1`
- `flow-step-space-logic@0.1.1`
- `instant-ctrl-flow-contract@0.1.2`
- `instant-ctrl-flow-logic@0.1.4`
- `work-ctrl-flow-contract@0.1.3`
- `work-ctrl-flow-logic@0.1.3`
- `eager-data-flow-contract@0.1.3`
- `eager-data-flow-logic@0.1.4`
- `ai-workflow-contract@0.1.7`
- `ai-workflow-logic@0.1.7`
- `ai-ctrl-workflow-contract@0.1.4`
- `ai-data-workflow-contract@0.1.4`
- `ai-ctrl-workflow-logic@0.1.6`
- `ai-data-workflow-logic@0.1.8`
- `ai-workflow-flow-dsl-reference@0.1.5`

禁止 range、workspace/file/link substitute、`publishConfig.registry`、命令行 registry参数或npmrc修改。Halfcode版本继续服从各发布包的exact dependency；Eidolon不人为统一跨owner branded runtime。

## 3. Frozen definition and profile authority

Resource-backed instance admission已复制完整registry layer closure到instance。采用StepSpace后：

1. publication proof用真实Halfcode/depa loader解析 `StepSpaceRef` 及其显式 step/group/extension closure。
2. instance materialization把 Workflow、StepSpace、Step、Extension schema/initial value与Agent/Material closure一起冻结；definition revision覆盖全部bytes。
3. fresh runtime只从 `instances/<instanceId>/definition` 与冻结的resource layers装配profile authority；live workspace/global resource修改、删除或损坏不影响既有instance。
4. runtime-only `DefinitionStepExtensionCodecRegistryPort`由component长生命周期装配；函数永不写入ResourcePackage、checkpoint或config。未知kind、schema错配、normalize不等价在mutation前fail closed。

Ctrl membership由frozen Ctrl binding/StepSpace派生；Data membership由frozen declaration order与已录取patch facts派生。不得按目录、节点标签、自然语言或当前物理record集合猜测。

## 4. Checkpoint and local mutation

`WorkflowDepaPersistence`继续只构造一个 `FilesystemFlowRunCheckpointStore`，但必须注入匹配instance/profile的 `FlowRunProfileAuthorityPort` 与 codec registry。Ctrl/Data owners在v0初始化 `stepExtensions`，后续所有保存必须保留同一logical carrier。

公开mutation保持DEPA Processor公式：

```ts
mutateRunStepExtension(runtime, selector, invocation, config)
```

runtime-bound facade可以闭包runtime，但使用相同方法名；selector是逻辑 `instanceId/runId/stepId/kind` identity，不包含物理路径。一次成功mutation只允许一个step的一个extension revision `+1`，且由同一次checkpoint CAS录取。Eidolon不得直接写 `records/trees/receipts/head`。

物理效率证据由depa receipt/readback给出：core record复用，新增extension material + step leaf + Merkle path有界，head最后切换并保持fresh recovery。产品API只返回逻辑revision/value/root digest等稳定facts，不返回bundlePath/storeRoot或物理record路径。

## 5. Authoring and publication proof

作者态支持modular StepSpace，而不是把所有节点重新塞回单一flow manifest：

- tree/read/patch能以显式virtual refs编辑 `step-space.xnl`、`steps/*/step.xnl` 与extension source。
- publication proof要求closure完整、source ref containment、普通文件/no symlink、UTF-8/XNL、step identity/order、extension registration/schema/codec availability一致。
- 未引用目录项不自动成为成员；局部step/extension修改不重写无关authored file。
- proof失败不改变live ResourcePackage、effective registry snapshot、instance、checkpoint或durable receipt。

已有typed Agent proof仍从同一frozen complete closure重建；StepSpace adoption不得退回伪造task tuple或live registry lookup。

## 6. Native surfaces, Skills and product install

Status/result/summary/replay/evidence继续从logical checkpoint投影，并在Ctrl/Data fresh process恢复后保留extension revision/value。Authoring Skill从 `ai-workflow-flow-dsl-reference@0.1.5`渐进读取最新StepSpace/instance-run规范；Run Skill描述逻辑selector和恢复，不描述物理文件布局。

Strict type gate直接编译生产 `WorkflowStepExtensionAuthoredFacade` binder、resource loader、DEPA persistence及exact published source packages；Ctrl/Data runtime共用该binder，测试不得复制一份synthetic binding来代替生产证据。

system Skill内容通过既有generator生成并由 `generate:system-skills:check`绑定统一构建。最终产物使用canonical `build:terminal:tui`构建，local install沿项目既有安装方式指向该产物，随后 `eidolon global init`更新四枚exact managed Skills；普通Skills保留，旧managed closure退出。

## 7. Compatibility and migration

- 已存在的无StepSpace/extension checkpoint继续由depa legacy-compatible logical decoder读取；不补写第二store。
- 已有one-way legacy migration保持只读输入、canonical checkpoint单写；不得重新启用flat `ctrl`、`ai-state`、`data-graphs`、`agent-executions`写入。
- 已终态run不可通过extension mutation重开；mutation只作用于depa允许的非终态transition。
- 回滚只能切回上一完整Eidolon binary；新binary不通过双写做兼容。

## 8. Validation strategy

- 依赖与类型：exact closure、frozen install、published runtime/type smoke。
- 作者态：真实ResourcePackage fixture含Ctrl/Data modular StepSpace与schema-bound extension，proof/publish/registry readback通过。
- 冻结性：录取后修改/删除live source，fresh service仍从instance bytes恢复StepForest、codec authority和结果。
- 运行态：Ctrl wait/resume与Data partial/resume均保留extension；按step targeted mutation只推进一个revision。
- 局部性：比较前后depa receipt，证明无关core/step material复用，新增写入有界；不使用墙钟阈值替代结构证据。
- authority：产品读面无物理path，production无第二store、目录扫描、模糊路由或legacy dual write。
- 产品：focused/full tests、type/build、system Skill generator、strict Codument、diff/static、compiled local install、隔离global init与manifest-bound逐文件readback。

## 9. Decisions

关键取舍记录在 `decisions.xnl`：物理owner完全留在depa；codec是runtime port；作者态与运行态只共享冻结descriptor/value和逻辑refs，不共享函数或host path。
