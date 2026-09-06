# 子图 Worker 准备：DEPA 接缝设计

## 原逻辑到目标映射

| 原位置（host 根相对路径） | 原职责 | 本 Track 的增量 |
| --- | --- | --- |
| `cell/packages/ai-organ-logic/src/workflow/runtime/AIDataWorkflowRuntimeDriver.ts` 的 decideAutonomousControl | 原生 typed control decision、checkpoint-bound Agent effect | 复用 frozen controller，增加独立 resource selection 调用；输入 genuine candidates 与可信运行反馈，输出仍为原生 Agent selection decision |
| 同文件 applyNode/子图调用 | 原生 child identity、父节点结果和失效记录 | 保留失败原因/验证反馈的可引用事实，native add-subflow 继续选择已有子图 capability |
| `WorkflowRuntimeService.ts` 的 childInvocationRuntime/startOrContinueChildWorkflow | resolve/freeze 后建立 child Prepared，随即 start | 在资源显式声明的 child preparation 接缝准备 Worker，再 start；无声明走原路径 |
| 同文件 prepareAIDataAgentDefinition | 只对 Prepared instance 准备并存 receipt | 子实例仍处于此合法状态，继续走同一 service/store；不放宽 running parent |
| `AIDataAgentResourcePreparation.ts` | 原生 host preparation + v2 frozen receipt/store | 转交 authentic previousExecution，保存反馈与 child lineage 关联；旧 receipt 不造新 proof |
| `EidolonAutonomousAgentResourceHost.ts` | genuine observation→native admission→Halfcode author→reconcile→freeze | 只扩展必要的 durable continuation 接缝，不复制 native admission |

## 方案

父控制器根据原目标 verifier 的失败观察，以原生 add-subflow/rewire-subflow 选择已 admission 的子图。普通输入端口携带能力需求/失败来源，不能携带伪造 proof。子图资源通过现有 Halfcode step extension 机制显式声明准备规则；不以固定文件名或 objective 关键词启用。

子实例由原 child owner 建立为 Prepared。宿主读取确切 parent checkpoint、实际失败 node/result/verifier 和原 frozen proof，形成可信 preparation input。在 fresh registry observation 上，调用已冻结的控制 Agent，使用原 bindAIAgentProcessors、确定性 invocationKey 与现有 durable Agent effect。AI 返回原生 select-existing/author-new/revise-existing decision，交既有 selection owner/authoring owner；宿主不替 AI 决策。

准备好的 Worker receipt 归 child instance 的原 FileAIDataAgentPreparationStore；start 将它固化进 child checkpoint 的原 preparation extension，并纳入真实 task proof 和 capability。父图只通过 child identity/freeze/start/load/settle 协议观测结果。父 run 的 agent proofs/registry 不变。

子图使用新的 Worker nodeId/instanceName，不能在该 nodeId 预绑定旧 Worker 后再覆盖 proof。父控制器承担资源选择调用时，其冻结 Input/OutputSchema 必须声明支持此 payload 和原生 selection decision；不得为了复用控制 Agent 绕过原 schema validation。没有该资源能力时在 effect 前给出精确不兼容结果，或由资源显式声明独立选择 Agent 并经既有绑定准备，不允许临时伪造任务绑定。

执行接缝细化：本增量不要求 child 自己也有 autonomous controller。child 可以在 TransformNode 显式声明 `preparedAgent` capability slot；首次 start 根据已存 exact receipt 经原生 graph patch 绑定新 Agent 后 advance。没有 autonomous control extension 时不发布动态 control catalog；有该 extension 时保留既有 capability admission。父图仍承担原目标 verifier 和后续纠偏，避免给每个单 Worker 子图平添一个控制循环。未声明 slot 的图不改写，已启动 child 只恢复原 patch。

## 事实边界与恢复

- 图裁决仍为原生 graph admission + checkpoint CAS；Agent 修订裁决仍为原生 Agent admission + Halfcode/VFS publication。没有第二 GoalGraph、Agent store 或 controller state machine。
- preparation 的请求、AI 决策与 receipt 是现有 child/authoring recovery 材料，不是可以绕过 owner 的 authority。调用前持久确定输入身份；重启不能重新询问模型产生另一个修改。
- durable preparation 必须将实际 observation 的 requirement/candidate-set/registry 身份与已存 intent 对齐，随后才保存 decision 或执行 effect；final receipt 以 digest-covered 的 preparation 字段关联 intentDigest/decisionDigest/targetDigest。历史直接准备的无关联 receipt 仍能 direct recover，但不能冒充本次 durable 准备结果。
- 完整 prepared receipt 存在时从其中冻结材料恢复，不读取 live 最新配方；child start/result 继续幂等。
- child start 的 descriptor、run receipt、Running instance 与初始 checkpoint 不假装一次跨存储原子提交。原 start owner 根据 generation-zero、原 request fingerprint、冻结 input/bindings/preparation receipts 恢复尚未完成的初始化；没有原生 checkpoint 时只在无 legacy graph 的情况下重入原 execute。已有初始 checkpoint 时通过原 CAS 补 receipt/capability，再绑定 slot；不得修改已执行 checkpoint 的准备身份。EntryNode 尚无结果时读取原 descriptor.frozenInput。
- authoring 已成功而 preparation 尚未保存是必须实测的窗口。若通过原 journal/receipt + 冻结输入重建 authentic admission/reconcile 可证明，则恢复原结果；若无法证明 exact publication/closure，明确待协调，保留现场，不偷偷 select latest、不自动重新发布。不得仅凭外层 JSON hash cast 成 proof。
- 所有模型调用经既有 Agent actor/effects，跨 actor 通信仍为原 mailbox。数据图 profile 适用；没有新增事件溯源要求。
- 真实执行异常作为既有 control extension 的 typed executionFailures 历史事实保留，按 node/generation 关联；父控制器 payload 与子图选择的相应失败证据显式包含原因。没有失败的原 payload 不增加该可选字段，非 Workflow 场景不引入 control phase。

## 验证与边界

首先在真实 WorkflowRuntimeService 测试建立 RED：旧 Worker 结果未通过 verifier；父 controller 选择 child；child 中真实 native update 新 Agent/Context；新 Worker 产生不同结果并回流。检查不是启动前预先写好新 Worker，且失败不是无信息 Invalidated。

跨 OS fixture 在准备完成、child start、结果回流和 publication-before-preparation-save 注入退出，以原 files/checkpoints/receipts 恢复。记录 controller invocations、revision receipts、old/new code digest 与不重复 effect。正常 select/create、无声明 child、旧 prepared-task、成熟上下文回归不退化。具体测试文件/命令在实现报告锁定。

默认 auto 采用 child-scoped preparation，不扩展任意 capability catalog，不引入新的全局预算/阈值。manual commit；源码绑定已批准的外部 dirty baselines；不 build/install/publish/付费测试。modeling/engineering 均显式关闭，结构知识留在本 design。
