# Proposal：从 authoring 发布真正的 Resource-native App Package

## 背景和动机

当前 Resource discovery/runtime 与 authoring publication 之间存在断裂：`EidolonAppResourceRegistryAdapter` 只从显式绑定的 `~/.eidolon/resources` 与 `<workspace>/.eidolon/resources` Halfcode ResourcePackage 读取；`WorkflowAuthoringSessionStore` 却把 `/work` 当作单个 workflow bundle 写入 `<workspace>/.eidolon/workflows/<target>`，然后直接构造 `resource://<definitionFqn>`。因此这个返回值没有 registry authority，无法被 App/Agent/Material projection 或 resource-backed runtime解析，最终 lifecycle acceptance 的发布判据不可达。

本 track 把 canonical authoring 单元改为“完整 workspace ResourcePackage 候选”。可恢复 session 继续提供 `/base`、`/refs`、`/work`、`/out` 与 CAS batch patch，但准备阶段必须让 Halfcode loader、layered registry/content identity 与 depa App/Agent/Material projections对同一候选 revision给出 exact proof；发布阶段在独立授权后，以 workspace resource root 为固定目标执行同父 transaction，随后由同一个 component-owned registry refresh/readback产生唯一可信的 `resource://` refs。

## 目标

- resource-native session 的 `/base` 与 `/work` 表示整个 workspace ResourcePackage；从已有 workspace package 开始时，未改动的 baseline `AIAgentDefinition`、Prompt、KindDefinition 与其他资源逐字节保留。
- 允许以完整、显式 ResourcePackage 文件集作为 session 起点；production 不硬编码、拼装或复制通用 Halfcode KindDefinition authority。
- 对 exact working revision 执行 Halfcode package load、global→candidate workspace layer composition、content identities，以及 depa App/Workflow/Agent/Material projection、workflow profile验证和依赖冻结证明。
- 仅在独立 publication authorization、current proof 与 live-root CAS均成立时替换 `<workspace>/.eidolon/resources`。
- 使用同父 staging/backup、target-scoped lock、持久 attempt journal、readback和恢复，覆盖并发、重复调用与进程中断。
- swap 后必须调用同一个 `EidolonAppResourceRegistryAdapter.refresh()`；publication receipt 只返回 refresh readback确认的 registry revision、App、entrypoint Workflow、Agent、Material refs。
- authoring、publication 与 runtime authorization始终分离；publication不创建 instance/run。
- legacy workflow bundle 路径继续可读写和运行，但只返回真实 `vfs://` ref，不得声称 `resource://` authority。
- 更新 `sys-eidolon-anchor-authoring`/DevOps 的 `operations/` 与 generated plan，使模型选择整包 authoring protocol；host 仅按显式 mode、revision、ref、authorization和receipt工作。

## 非目标

- 不实现新的 ResourcePackage loader、catalog、overlay、dependency resolver或 manifest scanner；全部复用 Halfcode。
- 不在 Eidolon 重新定义 depa App、Workflow、Agent、Material Kind语义；projection继续来自已发布 depa packages。
- 不把测试 fixture 或 KindDefinitions编译进 production catalog/system Skill；fixture只是显式、完整的 ResourcePackage输入。
- 不自动把 global package复制为 workspace authority，也不允许编辑一个 leaf workflow 时丢弃同包的其他资源。
- 不合并 publication authorization与 execution authorization，不在 publication阶段运行真实 effect。
- 不新增 workflow-specific actor、child history、session或compactor；后续 CLI验收只复用 outer Eidolon session，并通过持久 typed receipts把 fresh `WorkflowFulfill` child连接起来。
- 不通过正则、关键词、substring、别名、有序规则或其他模糊 host逻辑选择 Kind、operation、App、Agent或授权。
- 不发布 npm package，不传 registry参数，不修改 npmrc。

## 变更内容

- 将 `WorkflowAuthoringSession` 升级为 typed mode：`resource-package` 与 `legacy-vfs-workflow-bundle`，共享一个 recoverable session authority，分别使用真实 publication strategy。
- 新增 ResourcePackage candidate validator/proof projector和 workspace publication transaction，并注入现有 WorkflowComponent/registry adapter；不创建第二 registry。
- 让 resource-backed open/edit 克隆完整 workspace package并记录 live base revision；只对显式 workspace origin开放，其他来源要求显式完整 package输入。
- 修正 legacy draft/publication receipts：使用 `vfs://`，永不构造 `resource://`。
- 补充 native tools/CLI JSON read model、Authoring/DevOps operations与 generated system Skill plan。
- 建立一个完整物理 fixture：package manifest、所需 KindDefinitions、baseline exact Agent+Prompt+MaterialPort，以及新增 App/Workflow/Material/Binding；KindDefinitions属于fixture输入而非 production常量。

## 影响范围

- 受影响 behaviors：`eidolon-ai-workflow-native-capability`、`eidolon.ai-workflow-native-component`、`eidolon.workflow-cli`。
- 受影响代码：`cell/packages/ai-organ-logic/src/workflow/authoring/**`、`src/resources/EidolonAppResourceRegistryAdapter.ts`、`src/workflow/component/**`、workflow native tools/read models、相关 CLI/TUI tests。
- 受影响 Skill：`cell/packages/ai-support/src/system-skill/resource-package/**`、generator与 generated plan；版本只在 `1.0.x`增长。
- 兼容影响：旧 workflow bundle发布结果从伪 `resource://`改为真实 `vfs://`；需要 resource authority的调用方必须走 resource-package mode。
