# Workflow 整包 VFS 编辑发布与 Skill 驱动验收

## 为什么
正常 Terminal 已采用 Effective VFS，Workflow 整包会话和 publisher 仍要求 physical workspace layer，导致创建和编辑都在源码验证前失败。真实 Agent 虽读取了 system skill，生成的未发布候选仍缺少标准 Kind 的 schemaRef 并复制示例指纹；两个 Holon/Member 子任务成功后，主会话也未在 900 秒内自然收尾。这些问题分别需要接口装配、契约获取和生命周期验证。

## 目标
完成完整 Halfcode CLI Skill App 拆分前的一条可运行闭环：正常 Eidolon 启动，经 system skill 与公开工具完成 ResourcePackage 创建、编辑、整包验证、准入、回读、Data/Ctrl 执行和恢复；以稳定接口承接未来动态操作入口。

本 Track 由用户明确要求创建并批准实施；执行状态和验收回执以 track.xnl 为准，历史离线结果不计作本 Track 的真实验收。

## 变更范围
- 区分资源读取、候选工作区编辑、权威发布三个能力；当前公共处理逻辑接受显式 runtime，保留旧工具入口。
- 接通 Effective VFS 整包 session、typed 文件 mutation、整候选 prepare 和单次 CAS；单文件 AgentDefinition 编辑委托同一写入能力。
- 支持 create/update/delete/move、XNL/代码等真实类型、跨文件引用、来源与写入范围、prepared proof 失效、receipt、幂等查询及持久投影恢复。
- 标准 Kind 从可信安装契约获取；补齐结构化错误分流和 system skill 的准确操作协议。
- 验证普通文件资源与 VFS 适配的共同读取/草稿契约，排查 registry、解析、候选校验和代码加载中的物理路径假设。
- 正常 CLI 使用 iqingwa / DeepSeek v4 Pro 真实执行 Data/Ctrl 与 Holon/Member 场景；Codex 执行者使用 GPT-5.6 Terra。核对相关 skill 正文 provider 可见性、结果、旧实例冻结及 CLI 收尾。

## 范围边界
完整 Halfcode Skill App 迁移、新通用 dispatcher/存储引擎、替换 AI Data/Ctrl 运行器、不相关 UI/组织模型演进和 npm 发布不在本 Track。Halfcode 公共能力列表尚无包发布端口；本轮以 Eidolon 的 typed runtime 接通能力，记录公共宿主所需的最小扩展契约。确需上游修复时，只通过公开包版本及独立消费验证接入，不永久跨仓 import 私有源码。

不恢复 physical publisher 对 Effective VFS 的写入旁路。保留现有 authoring/publication/execution 的独立授权协议；隔离 E2E 使用明确结构化授权，不从会话文本推测权限。旧 mission 与旧 track 的完成状态保持不变。

## 影响与交付
影响 ai-organ-logic 的 authoring/component/tools/resources、symbiont-contract/logic 的 Effective VFS 发布协议、mod-ai-coding 的装配、ai-support system skill 与 TerminalRuntime。修改既有四项 behavior capability 的增量，设计自包含于本目录；不改生产行为 registry 直到归档。

交付包括代码、行为测试、故障恢复测试、正常安装和启动测试、带预算的真实 E2E harness、脱敏结果矩阵及公共化接续说明。模型与日志材料保留在被忽略的 reports；可提交文档不含凭据和本机项目路径。提交模式沿用 manual，未请求 push。
