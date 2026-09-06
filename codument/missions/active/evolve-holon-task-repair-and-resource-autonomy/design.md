# Design：任务修复与资源自主能力演进

## 1. 规划基线与约束
规划基线提交 f28c0d6；本次实现已校准到 8df4a6f，吸收已完成的职责归位 Mission，不回退 logic/support 边界。本设计依据源码和已归档独立 runtime、自主 authoring 设计，不依赖被忽略的分析目录作为唯一输入。沿用 `codument/attractors/product.md` 的 Holon 自组织和项目级 DEPA、显式 runtime、通用机制、可验证性吸引子。标准 Mission ActorSet 协议以 `codument/std/spec/mission-xnl-spec.md` 为准。

用户已决定：第 3+5 项合并；第 4 项独立；bun.lock 不纳入版本管理，因为开发会引用本地未发布包。两 Mission 都必须保留此形态。验收可记录本地依赖的版本、内容 digest、源码修订及脏状态说明，不能偷换成强制提交 lock 或禁止本地依赖。用户本次明确授权 impl-mission；question_severity=auto 用于 routine 规划并持续推进无冲突的 ready 分支。代码提交 manual，发布/安装另行明确。

## 2. 原实现到增量的映射
所有源码定位均相对 host 根；执行前重查行号和实际公开 API。

| 现有能力/位置 | 已实现语义 | 本 Mission 的增量 |
|---|---|---|
| ai-organ-logic/src/organization/HolonTaskRuntimeService.ts:164；完整前缀 cell/packages/ | assign/admission/TaskSpace/wake/observation 的中立服务 | 增加一致 task observation 与 repair command，不另建 owner |
| cell/packages/ai-organ-logic/src/organization/HolonTaskSpaceCoordinatorActor.ts:115/129 | durable subscription 的可重建 wake timer；局部失败只重排 | 将停滞阶段、最近错误、可执行动作纳入 owner-backed 观察；不把 timer 当任务真源 |
| cell/packages/ai-organ-logic/src/organization/HolonTaskSpacePump.ts:286/297/312 | claim/execute/settle，失败终态 | 经合法 transition 重试、改派或建立后继修复任务；保留旧失败 |
| cell/packages/ai-organ-logic/tests/workflow/holon_execution_binding_registry.test.ts:780/801 | fresh VM，但复用 effects | 新 OS 进程与独立持久 external-effect ledger，不能共享 JS 对象 |
| cell/packages/ai-organ-logic/src/resources/EidolonAutonomousAgentResourceHost.ts:95/129/145/206 | select-existing/author-new，Halfcode publication、reconcile、freeze | 接入反馈证据和既有资源修订，不重复实现 create |
| cell/packages/ai-organ-logic/src/resources/EidolonAIAgentDefinitionAuthoringAdapter.ts:127/130 | create-only，调用 Halfcode plan/apply | 使用 owner 的版本修订/事务协议扩展多资源配方；保留 CAS/fence 与 receipt |
| cell/packages/ai-organ-logic/src/resources/EidolonAppResourceRegistryAdapter.ts:1900/1907 | ContextPipeline standard implementation、固定 stage ledger | 让 resource-managed 可执行代码成为可版本化实现闭包；不是只放开字符串校验 |
| cell/packages/ai-organ-logic/src/workflow/runtime/WorkflowRuntimeService.ts:644/669/1746 | Prepared 时准备 Worker，run 内恢复已冻结 proof | 下一子图/子 run 有自己的准备与 admission，父目标运行不中断、旧 run 不解冻 |
| cell/packages/ai-organ-logic/src/workflow/runtime/AIDataAutonomousControlLoop.ts:456/505；AIDataWorkflowRuntimeDriver.ts:398 | observation→decision→admission→graph patch→checkpoint CAS | 缺口决策驱动子图执行和新 Worker准备；不引入 GoalGraph |
| cell/packages/ai-support/src/conversation/local/LocalConversationRuntime.ts:779；cell/packages/ai-organ-logic/src/conversationCapsule/internals/domainRuntime.ts:44 | 成熟 Prompt/history 与上下文物化 | 作为行为等价基线；实体迁移由兄弟 Mission 拥有，不在这里重新发明算法 |

历史输入：`docs/ai/architecture/standalone-holon-task-runtime-service.md`；`codument/missions/archived/2026-09-05-establish-standalone-holon-task-runtime-service/design.md`；`codument/tracks/archived/2026-08/2026-08-30-1747-integrate-autonomous-agent-resource-authoring/proposal.md`。

## 3. 事实 owner 与可写边界
| 事实 | role/model/owner | 合法变化与读取 |
|---|---|---|
| task、claim、lease、attempt、result | current authority / durable / TaskSpace | repair command 进入现有 Processor/owner transition；observation 只读 |
| dispatch intent/result | recovery + historical / durable / pump journal | append/幂等 receipt；不由 UI 直接改状态 |
| 外部 effect 接受事实 | external authority / adapter 所在系统 | journal 记录对方 receipt；unknown acceptance 要协调，不能伪造 exactly-once |
| actor 地址与会话历史 | live/durable / generic actor-session runtime | MemberRuntime 提供引用；TaskSpace 不复制 history |
| Agent/Context 配方 | versioned resource authority / Halfcode + effective VFS | proposal→plan/apply→publication/reconcile；新版本及依赖身份可追踪 |
| frozen Worker 执行闭包 | fixed execution input / run admission | 旧 run 只读取冻结 closure；新子 run 冻结新 closure |
| 父子 graph 与 checkpoint | current authority / graph admission + checkpoint CAS | parent-child lineage、结果 material 经既有图协议；观察通过决策请求变化 |
| 任务诊断视图 | derived observation / none | 关联 task/actor/resource receipt，不成为第二可写任务状态 |

DEPA 要求实现 Tracks 在设计和每次 replan 时复核 owner、显式 ports、同步 command/跨 actor message、真实 capsule closure。ReactiveDataGraphProfile 因 AI Data graph 激活；不因为 journal 名字强制全域 event sourcing。不确定的 accepted-effect 边界先观测，不加数字重试上限掩盖。

## 4. 产品闭环
普通 transient/可协调故障走修复；能力缺口可选择已有 Worker、修订配方或下一子图创建新 Worker。修订的收益必须由原任务 verifier 判断，不由“资源发布成功”代替任务完成。

```text
@delimiter: --
@node: #
@marker: ?
-- #loop ?goal until="原目标 verifier 达成或真实待人决策"
---- #step ?observe
从 task/actor/checkpoint/resource receipts 形成同一份带证据观察。
---- /?observe
---- #switch ?repair on="失败或缺口类型"
------ #case ?recover when="现有能力足以完成"
向原 owner 请求重试、改派或后继修复任务，保存因果 lineage。
------ /?recover
------ #case ?evolve when="需要新能力或配方修订"
经 Halfcode 发布资源版本与可执行依赖 closure；在下一子图/子 run 准备并冻结 Worker。
------ /?evolve
---- /?repair
---- #step ?verify
执行子图并回流结果，验证原目标；未达成则把新证据反馈下一轮。
---- /?verify
-- /?goal
```

运行目标、图和 TaskSpace 保持各自语义；“控制论循环”不是另造一个全局 MissionController store。独立 Holon 仍可不创建 Workflow。AI Data 增强子图能力，Ctrl 只按既有控制图语义复用新的任务/Worker能力。

## 5. MessagePrefix 与 ContextPipeline
资源修订 Track 的 design 必须进一步逐项列出原代码→Halfcode 模式映射：通用/coding system instructions、workspace AGENTS.md、history 前后切分与动态插入锚点、WorkContextOverlay、provider handoff、压缩与 tool-pair、provider conversion。不得仅复制简短提示词或丢失成熟行为。

MessagePrefix 继续表达稳定前缀组合；ContextPipeline 容纳 Halfcode 引用的动态可执行代码及依赖。需要冻结的不只是 descriptor 文本，还包括实际执行代码/资源依赖身份；历史 run 的恢复不能悄悄加载最新版代码。动态信息在原声明锚点 splice，不因任务阶段跳转重写前部稳定 prefix。配方显式升级可以产生新 prefix/epoch，但必须归因，不要求不同配方内容相同，也不承诺未经测试的 99.5% 命中率。

## 6. Track DAG 与反馈
G1 普通 Mission 任务负责校准/设计。G2 两条真实 Track 验证 OS 恢复、实现观察修复。实证重规划新增 G3P：Halfcode 原生执行代码闭包、depa-flows 修订 admission 两条外部 Track；G3 依赖 G3P，再落实宿主资源修订。G4 依赖 G2+G3，完成下一子图 Worker admission。G5 用真实产物跑产品闭环。G6 为总目标独立验收，不挂 TrackLink。外部工作树基线已获用户明确批准，可保留未提交改动继续增量实施。

每条实施 Track 使用当前 codument-impl-track，设计中配置阶段 GapLoop 与 verify_round，保持 manual commit；Mission 每 operation 后 reconcile。不得因为单项用例通过就停止反馈或宣布全部能力完成。任何未知外部协议、无效 receipt、重复 effect 或缓存非预期漂移都形成报告并决定局部纠偏/切片重规划。

## 7. 跨项目与兄弟 Mission 协作
ProjectRefs：host=Eidolon；halfcode、depa-flows、holarchy、task-manager 为潜在协议 owner。持久文档不写 workspace path；执行时 WorkspaceBinding 解析。优先公开 API：Eidolon 只拥有封装适配和 host effects。若缺少通用协议，在 G1 把证据、owner 和最小外部 Track 写入 replan 后绑定，不在 Eidolon 复制 Halfcode/graph/task 核心。

兄弟 Mission `realign-runtime-effect-and-composition-boundaries` 是独立 peer，不是本 Mission 子节点。其 G2 characterization 可供此 Mission 使用；本 Mission G2 的跨进程验收可供其迁移后复检；不互相等待整个 Mission。涉及 TerminalRuntime、resource registry、Conversation materializer、journal/bootstrap 时，以最小 Track/文件清单交接，同一文件只允许一个在途写入方，必要时使用 .tmp/chat.jsonl 协调并将稳定约定写回 Track。不能用互相 completed 的条件制造调度环。

## 8. 验证与收口
先零付费合成工作区和持久 fake external adapter，再按执行时确认的模型/预算运行真实 provider 样本。非 Workflow、Ctrl、Data 使用同一问题与 verifier；AI Data 增补“运行中缺口→子图新 Worker”证明。记录目标完成率、首次有效进展、停滞时长、恢复时长、duplicate effect、修订次数、tokens/cache/cost，并区分旧配方基线与新配方变化。本轮不做付费测试。

完成必须达到 proposal 全部成功判据，不能以写了文档、返回错误码、创建新资源或重新实例化 VM 替代。交付文档给出诊断/修复使用方式、可执行案例与遗留边界。任何 npm 发布、安装、Git commit 都不由本次规划自动触发。
