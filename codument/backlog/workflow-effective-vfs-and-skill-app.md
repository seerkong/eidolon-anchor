# Workflow 整包写入与动态 Skill App 后续

本页记录 Holon 共享基础能力之后的 Workflow 修复和用户确认的演进顺序。2026-09-13 更新：前置资源端口与真实 E2E 已完成，完整动态 Skill App 拆分尚未启动。

前置改造与 E2E 由 [complete-workflow-vfs-authoring-and-skill-driven-e2e](../tracks/active/complete-workflow-vfs-authoring-and-skill-driven-e2e/track.xnl) 承接；详细结果和历史失败见其 [验收矩阵](../tracks/active/complete-workflow-vfs-authoring-and-skill-driven-e2e/acceptance.md)。完整 Halfcode Skill App 拆分仍为后续工作。

## 2026-09-12 历史基线

共享原生组织 snapshot、typed mutation、解释与三方重放的 Eidolon 消费已在 `adopt-shared-holarchy-dsl-and-reconciliation` track 归档。随后正常 CLI、GPT-5.6 Terra 与 system skill 验收发现的派单路由、父子串行队列自等待、Agent 发现阶段输入校验和标题截断空格问题已修正。

公开 HolonAssign(final) 和 MemberAssign(final) 创建的两个独立任务均已 Succeeded/settled，输出 3948；两个 Worker 自行读取四个 system skill 根及 Authoring 的 ai-workflow 操作，provider 可见证据已核对。定向资源、路由、Skill 和 global 回归 42 项通过，标题边界另复跑 4 项，固定工具链类型检查通过。这些是本轮历史验证结果。

主会话在 900 秒边界仍未自然收尾，CLI 为 paused_with_progress，最终退出非零。任务成功不能替代整轮 CLI 自然完成验收。

归档提交前又运行了离线验证：`bun run verify:holon-shared` 的三个类型检查、adapter 2 项和集成 90 项通过；system skill/global/progressive loading 48 项及 113 文件生成一致性检查通过。首轮与其他仓回归同时运行时，有一个 physical standalone 用例触发内部 2 秒等待超时；单例复跑及随后单独运行的完整集成检查均通过。保留这次时序波动记录，本轮未修改测试等待阈值，也未重发真实 provider 请求。这些离线结果不填补下述真实 Workflow E2E 缺口。

## 当时的缺口与本轮修复

当时正常 Terminal 已注入 Effective VFS；WorkflowComponent 因此清空 physical resourceLayers，而 WorkflowAuthoringSessionStore 仍强制要求 workspace layer，publisher 也只支持物理目录。这使既有包编辑与全新包创建都在源码校验前被阻断。该断点现已由统一资源读取、草稿和整包发布端口修复。

本轮复用已有 VFS mutation、prepare/admit 和 CAS，已接通整包 session 的基础版本、可信写入范围、类型化文件集变更、完整候选校验、单次准入、权威回读、持久投影与恢复。publication receipt 绑定实际候选和 revision；single-file AgentDefinition 编辑复用同一准入边界。旧 physical 模式保留显式适配，不旁路 Effective VFS authority。

标准 KindDefinition 现从可信安装契约加载并冻结，模型引用精确契约；宿主能力未绑定、包缺失、源码无效和发布未知已用结构化诊断区分。真实测试还修复了生命周期工具向业务 Agent 的错误继承、Prompt.template 文档冲突和派单派生标题问题。

正常 production composition 的 create/patch/prepare/publish/readback、并发冲突、失败与重启恢复已通过。真实 Eidolon 使用 iqingwa / DeepSeek v4 Pro，Codex 执行者和独立验证者使用 GPT-5.6 Terra：Data 输出3948，编辑后的 V2 输出3898且旧 V1仍3948；Ctrl 实际调用业务 Agent 得到 total950/approved=true；Holon/Member 两条路由各自结算3948。四个成功场景均正常 CLI exit0，并有各自 Skill/provider/native 证据。Ctrl→Data 持久嵌套调用不属于本轮已实现能力。

四项 system skill 的正式分发和默认 global 安装已更新。公共 Halfcode trusted Kind 扩展目前通过可重复构建的未发布候选消费；正式发布和完整 Host 能力拆分仍需后续工作。

原始会话与脱敏复现材料位于 Git 忽略的 `codument/reports/holon-system-skills-e2e-2026-09-12/`，不随提交发布。

## 用户补充的后续演进边界

用户计划在上述 E2E 初步修正后，借鉴 depa-codument 的 `codument-cli-skill-app-refactor` mission，将 Eidolon 进一步拆分为 Halfcode CLI Skill App。前置验证已完成；本页记录边界，实际承接见下节。

- 复用版本化的 `halfcode-cli-lite-*` 公共包；通用宿主能力由 Halfcode 持有，Eidolon 保留领域逻辑和必要产品封装，不跨仓引用私有源码。
- 将变化快的 AI 确定性操作与文本协议变为可动态发现、加载的资源；现有动态 AIAgentDefinition 是可延续的基础。具体包拆分与操作映射留待后续设计。
- 标准 Kind 与安装契约归公共提供方，Skill App 引用这些契约；不在每个 App 复制系统 KindDefinition。
- 近期修复应形成明确的包编辑/发布端口和结构化结果，便于未来 Skill App 调用；避免把易变操作流程继续堆入 KernelRules，或另造一套动态宿主。
- 动态加载不改变资源 authority、工具授权、CAS、工作流实例冻结及恢复责任；知识加载和真实业务执行仍需分别验收。

参考背景是 depa-codument 的同名重构 mission 与 Halfcode CLI Lite 公共 Host 设计。此处只保留适用于 Eidolon 的约束，不把外部项目的实施状态当作 Eidolon 已实现事实。

## 承接：adopt-halfcode-cli-skill-app-runtime

完整拆分已立项为 [mission adopt-halfcode-cli-skill-app-runtime](../missions/pending/adopt-halfcode-cli-skill-app-runtime/mission.xnl)，期望态与约束见其 [design.md](../missions/pending/adopt-halfcode-cli-skill-app-runtime/design.md)。

该 mission 的关键判断：**Halfcode 公共包当前的资源访问止于只读 `ResourceEffect` 与面向操作系统的 `WorkspacePort`，因此动态加载的 Skill App 无法触及 Eidolon 的 Effective VFS**——这正是本页「公共宿主需支持可替换资源后端」这一要求的落地缺口。因此 mission 的第一步在 Halfcode 侧新增公共资源后端协议（读取 / 草稿编辑 / 发布准入三层）并用独立第三方 consumer 证伪，之后才改 Eidolon 接线。首个垂直切片选 Workflow authoring/run 操作族，因为其三端口已有真实 E2E 证据。

注意：depa-codument 与本 mission 都尚未把公共包发布到 npm（当前经本地内容寻址制品消费），因此「已打包可安装」不等于「已发布」。
