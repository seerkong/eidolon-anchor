# Workflow 整包写入与动态 Skill App 后续

2026-09-12，Holon 共享基础能力收口时保留的后续事项。本页记录未完成范围和用户确认的演进顺序，不表示新的实现计划已经完成。

## 已验证的边界

共享原生组织 snapshot、typed mutation、解释与三方重放的 Eidolon 消费已在 `adopt-shared-holarchy-dsl-and-reconciliation` track 归档。随后正常 CLI、GPT-5.6 Terra 与 system skill 验收发现的派单路由、父子串行队列自等待、Agent 发现阶段输入校验和标题截断空格问题已修正。

公开 HolonAssign(final) 和 MemberAssign(final) 创建的两个独立任务均已 Succeeded/settled，输出 3948；两个 Worker 自行读取四个 system skill 根及 Authoring 的 ai-workflow 操作，provider 可见证据已核对。定向资源、路由、Skill 和 global 回归 42 项通过，标题边界另复跑 4 项，固定工具链类型检查通过。这些是本轮历史验证结果。

主会话在 900 秒边界仍未自然收尾，CLI 为 paused_with_progress，最终退出非零。任务成功不能替代整轮 CLI 自然完成验收。

归档提交前又运行了离线验证：`bun run verify:holon-shared` 的三个类型检查、adapter 2 项和集成 90 项通过；system skill/global/progressive loading 48 项及 113 文件生成一致性检查通过。首轮与其他仓回归同时运行时，有一个 physical standalone 用例触发内部 2 秒等待超时；单例复跑及随后单独运行的完整集成检查均通过。保留这次时序波动记录，本轮未修改测试等待阈值，也未重发真实 provider 请求。这些离线结果不填补下述真实 Workflow E2E 缺口。

## 待修正与验收

正常 Terminal 已注入 Effective VFS；WorkflowComponent 因此清空 physical resourceLayers，而 WorkflowAuthoringSessionStore 仍强制要求 workspace layer，publisher 也只支持物理目录。这使既有包编辑与全新包创建都在源码校验前被阻断。已有单文件 AgentDefinition 编辑端口尚不能承担整包发布。

需要基于已有 VFS mutation、prepare/admit 和 CAS 能力，接通整包 session 的基础版本、可信写入范围、类型化文件集变更、完整候选校验、单次准入、权威回读、持久投影与恢复。publication receipt 必须绑定实际提交的候选和 revision；不得用旧 physical publisher 绕过 Effective VFS authority，也不能用逐文件多次准入冒充整包原子提交。

模型生成的未发布候选还存在独立的契约错误：两个 SpecRevision 缺少 schemaRef，并复制示例指纹。标准 KindDefinition 应从可信安装包或 registry 获取精确契约，由模型引用；不能要求模型复刻或编造标准 Kind。宿主能力未绑定与 workspace 没有完整包须用结构化诊断区分，Skill 据此分流。

先在正常 production composition 下通过公开工具验证 create/patch/prepare/publish/readback、并发冲突、失败与重启恢复；然后用 Terra、正常 CLI 和 system skill 验证 Data/Ctrl 创建、编辑、执行及新旧实例版本冻结。Workflow 当前未通过，也未实际执行新建的 Data/Ctrl 实例。

原始会话与脱敏复现材料位于 Git 忽略的 `codument/reports/holon-system-skills-e2e-2026-09-12/`，不随提交发布。

## 用户补充的后续演进边界

用户计划在上述 E2E 初步修正后，借鉴 depa-codument 的 `codument-cli-skill-app-refactor` mission，将 Eidolon 进一步拆分为 Halfcode CLI Skill App。本次归档只保留该方向，不启动整库迁移。

- 复用版本化的 `halfcode-cli-lite-*` 公共包；通用宿主能力由 Halfcode 持有，Eidolon 保留领域逻辑和必要产品封装，不跨仓引用私有源码。
- 将变化快的 AI 确定性操作与文本协议变为可动态发现、加载的资源；现有动态 AIAgentDefinition 是可延续的基础。具体包拆分与操作映射留待后续设计。
- 标准 Kind 与安装契约归公共提供方，Skill App 引用这些契约；不在每个 App 复制系统 KindDefinition。
- 近期修复应形成明确的包编辑/发布端口和结构化结果，便于未来 Skill App 调用；避免把易变操作流程继续堆入 KernelRules，或另造一套动态宿主。
- 动态加载不改变资源 authority、工具授权、CAS、工作流实例冻结及恢复责任；知识加载和真实业务执行仍需分别验收。

参考背景是 depa-codument 的同名重构 mission 与 Halfcode CLI Lite 公共 Host 设计。此处只保留适用于 Eidolon 的约束，不把外部项目的实施状态当作 Eidolon 已实现事实。
