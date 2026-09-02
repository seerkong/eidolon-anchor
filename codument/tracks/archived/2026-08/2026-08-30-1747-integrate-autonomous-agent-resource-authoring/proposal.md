# 变更：接入自主 AgentDefinition 资源 authoring、selection 与 workflow freeze

## 背景和动机 (Context And Why)

Eidolon 已能从 Halfcode effective registry 加载既有 `AIAgentDefinition`，也能在 AI Data checkpoint 内创建或 target 一个 Agent instance；但这两层之间缺少“按任务要求选择 existing definition，或经 Halfcode transaction 创建新 definition，再冻结为 workflow task proof”的 host 能力。当前所谓 dynamic Agent 只覆盖 instance creation/targeting，不能恢复早期 AI Workflow 的 definition authoring 自主性。

depa-flows 已提供 typed requirement、candidate、`select-existing | author-new` admission、durable receipt reconciliation 与 run-freeze authority；Halfcode 已提供 generic proposal/plan/apply/CAS/receipt。此 Track 只在 Eidolon owner 边界实现 effect adapter 与产品 host 组合，不重写这些领域规则。

## "要做"和"不做" (Goals / Non-Goals)

目标：

- 在 workspace ResourcePackage authority 上实现 Halfcode resource-authoring transaction port，并通过现有 registry publication fence 原子刷新 effective snapshot。
- 建立一个 typed Eidolon host service：输入 task requirement、selection decision 与 exact workflow task identity，输出 selected/authored definition、authoring receipt（如有）与 frozen task proof。
- existing selection 零写入；author-new 必须绑定原 admission、durable receipt、refreshed registry与当前 content/origin facts。
- 让 AI Data Mission preparation 使用该 host service生成固定 Worker capability，再由现有 Agent runtime完成 instance creation/targeting；fresh recovery从持久 refs/receipts重建同一 proof与instance identity。
- parent frozen workflow snapshot保持不变；新资源进入 live workspace resource layer，不回写 parent instance-owned closure。

非目标：

- 不引入 `GoalGraph` 或第二 graph store。
- 不动态扩展 `AIDataControlCapabilityCatalog`；本 Track 只在 run preparation 时把选定 Worker冻结为本 run 的固定 capability。
- 不创建第二套 Agent执行器、instance store或消息通道。
- 不发布 npm package、不修改 dist-tag；只消费 Mission 已准备的本地 exact distribution candidates。
- 不在此 Track 退役旧 VM Holon路径或完成最终 Ctrl/Data 产品矩阵。

## 变更内容（What Changes）

- 扩展 `EidolonAppResourceRegistryAdapter` 的受控 workspace resource authoring边界，复用Halfcode plan/apply与当前publication fence。
- 新增 autonomous Agent resource host Processor/port，组合 depa-flows candidate admission、Halfcode authoring transaction、registry refresh与task freeze。
- 新增可序列化的 workflow preparation receipt；checkpoint只持久exact resource/proof/instance refs、digests与transaction receipts，恢复时重新投影authentic runtime proof。
- 把AI Data的Controller/Worker准备与现有`selectAIDataAgentDispatch`、`bindAIAgentProcessors`链路接通。
- 增加真实workspace authoring、tamper/CAS、existing/author-new、parent snapshot不变、fresh recovery与instance reuse测试。

## 影响范围（Impact）

- 受影响能力：`eidolon-resource-native-app-registry`、`ai-data-workflow`
- 受影响代码：`cell/packages/ai-organ-logic/src/resources`、`cell/packages/ai-organ-logic/src/workflow/runtime`及对应测试/类型测试
- 外部依赖：本地 `halfcode-compiler.xnl@0.2.9`、`ai-workflow-contract@0.1.9`、`ai-workflow-logic@0.1.11`、`ai-data-workflow-logic@0.1.14`、`ai-ctrl-workflow-logic@0.1.10` distribution candidates
