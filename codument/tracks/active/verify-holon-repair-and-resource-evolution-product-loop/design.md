# 产品闭环与冻结执行设计

## 1. 已有逻辑与增量映射

所有源码定位相对 ProjectRef host。

| 现有位置 | 已有 owner / 语义 | 本次验证与窄增量 |
| --- | --- | --- |
| `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts` 的 createExecutionAdapters | 原 generic actor 调用；当前从 live AgentRegistry 取 config | RED 检查旧任务是否漂移；实际 adapter 通过 Bootstrap 已提供的 deployment 取得冻结执行计划，仍调用原 addressed child actor |
| `LocalHolonTaskRuntimeBootstrap.ts` 的 openLocalHolonTaskRuntime | 组合 admission/deployment/store、原 pump 与 capability | 读取现有 journal 和不可变 deployment 恢复旧 route；新 assign 仍按当前 catalog，不能历史版本导致模糊路由 |
| `cell/packages/ai-organ-logic/src/organization/HolonDeploymentDefinition.ts` | 不可变 definition/files/原组织和绑定 receipt | 冻结与恢复原 Agent code、MessagePrefix 和实际 workspace 指令；实测 physical 与 Effective VFS，二进制不能 UTF-8 损坏 |
| `EidolonAppResourceRegistryAdapter.ts` 的 materializeAgentExecutionPlan / prepareWorkflowAgentExecution / frozen bundle | native resource reader、code compiler、统一 plan、schema/tool/effect contract | 在原公共 materialization 链提供真实 standalone payload 与被冻结 prefix/code，不伪造 Workflow task；必要的通用 capture/restore 从原实现提取 |
| `WorkflowRuntimeService.ts` 的 workflowHolonTaskProcessorRuntime | 原冻结 deployment、Flow checkpoint、Agent effect、TaskSpace | 用相同业务输入验证共有配置投影；保留 Workflow 专属 identity/Material 语义 |
| `HolonTaskRuntimeService.ts`、Observe/Repair tools 与 slash | 原 owner-backed 观察、resume/successor | 用真实产物证明停滞→诊断→修复完成，不直接改 task status |
| Data child preparation/controller/native revision | 原 verifier observation、原 selection/authoring admission、child checkpoint | 真实 V1 产物不合格→反馈→V2 资源→新 child 产物合格；不是按调用序号宣布成功 |
| `ContextControlPlane.ts` / `AiAgentExecutor.ts` 与 Conversation capsule | Prompt plan 写入与 History materialization 的 session 身份 | 真实 wire RED 发现 sessionDir-only VM 被前者写入 `__unsessioned__`、后者从目录 basename 读取；统一调用既有 Conversation owner 的 resolver（包含显式 ID trim），不添加消息补丁或第二存储 |
| `WorkflowComponent.ts` 与原冻结 registry | authoring workspace 和用户实际工作目录用途不同 | 捕获实际 workspace 指令字节并随原资源闭包恢复；不能从冻结定义临时目录、authoring 目录或 process cwd 猜用户 AGENTS.md |

## 2. 事实边界

TaskSpace 拥有 task/claim/lease/result；pump journal 拥有 dispatch recovery；外部适配器 ledger 拥有 acceptance。不可变 deployment 继续拥有已采用组织/资源文件，原 registry/native compiler 解释这些材料；既有 generic actor/Conversation 继续拥有会话历史。新测试证据只是观察，不构成新的产品 proof。

冻结“可执行配方”包括 Agent 内容、实际有序 MessagePrefix、Context 代码依赖、tool/schema 和 effect policy。共有身份不含入口特有 run/node/invocation/task/session ID；三入口必须保留各自完整身份但比较共有投影。不要求三个不同 Workflow proof 的整体 digest 相同。

现有 standaloneDeploymentId 只关联组织/绑定资源身份，不包含 workspace-only AGENTS.md 变化。新采用的 deployment 身份必须纳入实际捕获的配方/前缀 digest（或由原 deployment owner 提供等价版本转换），使旧任务仍执行旧配方，而仅 workspace 指令变化的新任务也有不同冻结版本。捕获身份与实际保存材料须一致，不能计算 digest 后又读一次不同 live prefix。TDD 单独覆盖“只改 AGENTS.md”的旧任务/新任务双版本场景。current assign 路由与历史恢复路由的区分仅是 existing runtime context/capability 的装配角色，不成为另一个可写资源或任务真源。

若 legacy 现场没有足够材料证明某段动态前缀，不可伪造历史冻结结果。保持既有兼容路径或明确缺失证据，新增产生的 deployment 必须完整恢复。本次不改用户现场数据。

恢复旧 journal 路由时只能读取其 exact deployment/admission/snapshot/config；不能把历史绑定当作新的 current assign 选择导致 alias 歧义。source/receipt 冲突在 effect 前拒绝。native admission 与 code compilation 不在 Terminal 或 fixture 重做。

## 3. 测试与可观测证据

共同业务任务建议固定订单输入（整数金额），生成含输入 digest、分项与总额的 JSON 文件。verifier 独立重算并读取文件，不接受 Worker 的“已完成”字符串；产物由实际工具/既有 material output 或显式测试外部 effect 产生，测试事后不补写正确文件。

1. 三入口使用同一输入/Agent 配方/验证器。至少两个同配方请求检查稳定 prefix 与 schema；不同输入只出现在原动态插入位置。
2. 一项可诊断故障后用正式 Observe/Repair 完成；旧 Failed 保持、successor lineage 与输入可追踪。重放同 repair request 不重复接受 effect。
3. Data 真实失败反馈驱动 native 资源更新并在下一 child 冻结；原 verifier 检查内容改善。父旧闭包不变，live V3 不覆盖 child V2。
4. 真实 OS accepted-before-result 窗口，独立进程重读 fsync ledger、产物、task/actor recovery 材料；每个 logical key 的接受和产物写入一次，重放 lookup 可多次。未知接受明确 pending，不宣称任意外部系统 exactly-once。
5. 优先真实 ProviderRuntimeLlmAdapter + 本地 SSE，观察 final wire 与正常 usage normalization；合成 token 记 synthetic-transport，未经过该路径记 unavailable。paidRequests=0，paidCost=0，liveProviderMetrics=not-run，不承诺远端 99.5%。不修改生产闭合 cache scenario 白名单来制造 proof。

复跑现有 Holon OS/repair、子图准备、resource/Context/provider tests。记录当前实际命令、源码指纹、失败与修复，不用历史全绿替代。物理资源 tests/resources 与 fixtures 分离；共享 helper，避免复制巨型测试文件。

## 4. 执行与风险控制

Mission auto 创建；T1 明确设计后，T2 生产冻结闭包与 T3 测试/产物 harness 边界可并行，重叠文件由单一 owner 编辑，T4 统一联调。阶段 GapLoop(max5, verify_round=true) 和 coding AttractorCheck 沿 Mission 显式要求。modeling/engineering 显式 disabled，知识留在本设计。不安装/构建/发布/提交，也不清理其他 dirty changes。
