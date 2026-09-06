# Holon 修复与反馈驱动的资源演进

本页说明任务失败后的两条路径：修复原任务运行，或根据能力缺口修订配方并在下一子图使用新 Worker。两者共享已有 owner，但不混淆运行失败与资源能力不足。

## 先观察，再决定动作

独立 Holon 的工具和人工 `/holon` 命令都调用 `HolonTaskRuntimeService.observe/repair`。完整命令与字段见 [独立任务运行服务](standalone-holon-task-runtime-service.md#任务诊断与修复)。

- 非终态、尚可推进的任务：使用 observation 的 revision 提交 `resume`。它唤醒原协调器，不偷改 claim 或制造新任务成功状态。
- Failed/Cancelled 且需要新输入、目标或能力：提交 `successor`。原失败保留，后继任务通过原 TaskSpace replan 和修复 artifact 关联。
- 外部 effect 接受状态未知：先按原 adapter 协议查询/协调，不把重启解释为未执行，不用后继任务掩盖不确定状态。

相同 requestId 必须重放同一完整请求；换目标、输入、revision 或时间时使用新 requestId。收到 accepted 后继续 observe，accepted 不等于业务完成。

## Data 子图怎样准备新 Worker

没有新增 GoalGraph 或第二套 Mission Controller 存储。原 Data graph 与 checkpoint 描述目标、verifier、控制决策及父子关系。

1. 原 Worker 执行，原目标 verifier 检查真实产物；执行异常也进入原控制扩展的失败观察。
2. 原控制 Agent 根据 observation 决定继续、失败、完成或修订图；只有显式自主控制配置的图走此路径。
3. 新子图的冻结定义声明 `eidolon.ai-data-child-agent-preparation` 扩展，指明需求、失败源输入、目标节点及可准备的 capability。
4. 宿主保存原观察材料和 intent，使用原 Agent selection/admission 流程选择、创建或修订 Halfcode 资源。`revise-existing` 必须关联原 candidate、requirement、执行反馈与 native authoring receipt。
5. 原 Halfcode compiler 捕获资源代码、依赖和资产；准备 receipt 关联原观察、决策和冻结执行材料。子图只绑定显式 `config.preparedAgent` 槽位，不把任意节点隐式变成 Agent。
6. 下一 child 使用新冻结配方；原父 run 的冻结配方不被替换。结果返回原图，再由同一个目标 verifier 判定。

扩展的正式 schema 是 `schema://eidolon.ai-data-child-agent-preparation/v1`。字段包括 `sourceNodeInput`、`nodeId`、`instanceName`、`requirement` 和 `capability`；节点端口必须与 receipt 的输入/输出契约一致。具体可执行定义见 `cell/packages/ai-organ-logic/tests/workflow/fixtures/subgraph-worker-preparation-runtime.ts`，协议及校验由 `AIDataChildAgentPreparation.ts` 提供，不能从这篇文档自行推导新的节点语法。

Ctrl 仍保持自身流程语义；独立 Holon 也不因此强制进入 planning/coding/testing 等阶段。普通派发不需要搭建隐藏 Workflow。

## 重启与冻结的边界

准备流程的 intent、decision、receipt 是既有准备 store 中的不可变证据，不是另一套 Agent store。恢复时重读原 observation 与已接受决策，不依据当前 live candidate 重新选择。原发布证明缺失、lineage 不符或 receipt 被替换时明确拒绝。

workspace 指令也是冻结配方的一部分。Workflow definition 将捕获到的指令字节或显式缺失 `null` 放进原资源闭包；native child observation 将同一信息纳入既有 closure digest。恢复不再读取 authoring 目录或当前进程目录的 `AGENTS.md`。旧材料如果未记录这些信息，保留明确的兼容分支，不回填一个假定的“历史前缀”。

子图恢复测试使用两个独立 OS 进程，在以下位置退出后重开：child start 前、descriptor 写入后、checkpoint 创建前、checkpoint 创建后、receipt 关联后、child 结果产生后。退出方式是注入 `process.exit(73)`，不是任意磁盘损坏或断电证明。native V2 已发布而 live V3 存在的恢复另有专项验证。

## 指标的解释

同一冻结配方的有序 MessagePrefix 和工具 schema 应保持稳定；明确的配方升级可以改变 prefix 身份。ContextPipeline 继续使用原动态插入规则，不用升级配方暗改旧 run 的稳定前缀。

本 Mission 的产品回归默认零付费。loopback DeepSeek HTTP/SSE 测试验证真实请求投影、流解析和用量归一化，但 token 是标明的合成值；这不证明线上缓存命中率，也不能拿历史 99.5% 代替当前实测。真实模型评估需另行授权并单独报告。
