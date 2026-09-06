# Mission：任务修复与反馈驱动的资源自主能力演进

## 背景
用户于 2026-09-05 明确将第 3 项“Holon 停滞诊断/修复/跨 OS 进程恢复”与第 5 项“反馈驱动 Halfcode Agent/Context 配方升级、下一子图新 Worker”合并。本 Mission 不是重新实现独立派发或动态创建定义：这些已经存在，缺口在运行反馈到修复/能力升级的连通性。

## 目标
- 无 Workflow 时，组织或 Member 接单后能观察当前任务、claim、actor/session、进展、错误与可执行下一动作。
- 人和 AI 经同一 owner-backed command 修复任务，形成旧失败→修复动作/后继任务→目标完成的因果链。
- 补真正新 OS 进程恢复测试，覆盖接受 effect 后尚未写 result 的崩溃窗口；不复用进程内 Map/closure。
- AI 根据任务反馈选择复用、创建或修订 Halfcode 管理的 Agent/Context 配方；资源托管的动态代码能实际进入 MessagePrefix/ContextPipeline 消息编译执行链。
- 父目标执行过程中发现能力缺口后，在下一子图/子 run 准备并冻结新 Worker，执行结果回流，必要时继续控制论纠偏。
- 保留旧 run 的冻结资源/可执行依赖闭包和恢复能力；有意版本升级与无意上下文漂移可区分。

## 非目标与硬约束
- bun.lock 坚决不纳入版本管理，不改其 gitignore；支持引用本地其他项目未发布包，不把 registry-only/frozen 开发安装设为前置。
- 不包含之前建议 1 的全仓交付工程和 2 的通用会话性能改造；遇到本任务所必需的局部阻塞按证据处理。
- 第 4 项职责归位属于独立 Mission `realign-runtime-effect-and-composition-boundaries`，不将其整体完成作为前置。
- 不新建 GoalGraph、第二 TaskSpace/scheduler/Agent store，不恢复旧 VM TaskTree；图自身描述父子协调。
- 不强制普通 coding 归属 Workflow stage，不把使用 Workflow 变成缓存成本大幅增加的理由。
- 不做全线 Agent 定义替换、任意动态 Capability Catalog、多节点 transport、human/service 全 adapter 接入。
- 用户已明确授权使用 codument-impl-mission 实施本 Mission；原规划轮的“仅创建 pending”限制已被本次实现请求替代。提交仍为 manual；本次不自动 build/local install、commit 或发布。npm 发布须单独确认，使用 ~/.npmrc_official，业务应用不得发布 npm。

## 成功判据
1. 独立 Holon 任务出现至少一种可恢复停滞后，观察可解释“停在哪里/为何/下一动作”；人和 AI 均可经正式入口完成修复。
2. 真实两个 OS 进程，仅靠持久数据重开；intent-before-dispatch、accepted-before-result、settlement-before-observation 各窗口都有证据。外部 effect ledger 证明无不符合契约的重复接受/执行，模糊结果明确为待协调而非冒充成功。
3. 至少一个目标因 Worker/配方能力不足未通过 verifier，系统从该反馈产出资源修订，Halfcode 发布有效新版本；下一子图采用新 Worker，产生真实文件/材料并通过原目标 verifier，无人工偷改产物。
4. 父子 lineage、资源内容身份及可执行依赖 closure、修订 receipt、任务 attempt、结果回流与控制决策均可在重启后关联；旧版本 run 能继续恢复。
5. 无 Workflow、Ctrl、Data 三入口复用同一任务执行闭包；AI Data 自主子图修订链有专项测试，Ctrl 不被强行赋予同一控制器语义。
6. 相同冻结配方/模型配置的稳定 prefix 与工具 schema 保持稳定，动态 context 仅按原锚点 splice；配方升级的预期 cache epoch 变化可解释。真实模型指标单独记录，不以历史缓存率代替现值。
7. 所有落地 Track 验收与 Mission 总体验收有当前可运行证据；结构校验、owner 边界与资源协议符合 DEPA。

## 为什么是 Mission
观察、修复、跨进程恢复、Halfcode 资源修订、子图 Worker admission 涉及不同 owner，并且需要依据实际失败迭代。Mission 负责控制面与跨 Track 编排；代码、规范、测试由 mission.xnl 的真实 candidate Tracks 承担。没有绕过 Track 的隐式产品实现任务。
