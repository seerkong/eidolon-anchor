# 变更：采用 depa-native AI Workflow Instance/Run 持久化

## 背景和动机 (Context And Why)

Eidolon 当前的 `WorkflowFactStore` 按事实类型把 definition、instance、Ctrl snapshot、AI state、Data graph、events、receipts 和 Agent execution facts 平铺在多个目录。该布局与 depa-flows 已恢复并发布的 Definition → frozen Instance → Run checkpoint authority 冲突：fresh process 可能重新读取 live definition，Ctrl/Data/profile state 存在多个可写半真源，运行记录也不能作为一个完整 instance capsule 检查。

本 track 消费已发布的 depa runtime 最小补丁，把 Eidolon 收敛为 host storage/binding adapter。新运行只写 depa-owned instance/run checkpoint；旧 flat facts 仅作为显式迁移输入或兼容读取来源。

## “要做”和“不做” (Goals / Non-Goals)

**目标：**

- 将 Eidolon 的 AI Workflow definition 物化为完整、冻结、可检查的 instance bundle。
- 每个 `instances/<instanceId>/runs/<runId>/checkpoint.json` 成为 input/config/state/output、controller/node sidecars 及 typed profile state 的唯一 live authority。
- Ctrl 与 Data runtime 都从 frozen instance + canonical checkpoint 启动、恢复和重复读取；live definition 后续变化不影响既有 instance。
- 把旧 flat `WorkflowFactStore` facts 通过 durable、幂等、可恢复的一次性迁移转换为 canonical checkpoint；禁止新旧双写。
- 只在 checkpoint 中保存通用 Eidolon actor/session/effect 的 opaque stable refs 与 receipts，不复制 conversation/history/compaction/provider state。
- 精确升级到本 mission 已发布的 depa patch packages；依赖、lock、pack 与安装流程不指定 registry，也不写 npmrc。

**非目标：**

- 不在本 track 实现 `runAgent` / `runTargetedAgent` 的 Eidolon authored facade、bootstrap typings 或 publication AST proof；这些属于后续 typed-facade track。
- 不更新系统 Skill 的 targeted Agent 教程；属于后续 Skill track。
- 不改变 Halfcode ResourcePackage、authoring workspace 或 publication registry authority。
- 不创建 `ai-state/`、`data-graphs/` 或其他新的 host-private并列状态目录。
- 不实现 workflow-specific actor/session/history store。

## 变更内容（What Changes）

- **BREAKING（内部持久化）**：新 run 停止写入旧 flat Ctrl/Data/AI state authority，统一写 depa checkpoint store。
- 为 Eidolon workflow runtime 增加 depa instance materialization、filesystem checkpoint 与 profile adapter。
- 把 `WorkflowRuntimeService`、Ctrl controller、Data driver、query/result/recovery surface 接入同一 component-owned persistence port。
- 提供 closed legacy inventory、迁移 receipt、跨进程锁/CAS 与中断恢复；迁移完成后旧 facts 只读。
- 更新 exact package versions、lock、focused/E2E/static gates。

## 影响范围（Impact）

- 受影响能力：`eidolon-ai-workflow-native-capability`、`eidolon-workflow-architecture-boundaries`。
- 主要代码：`cell/packages/ai-organ-logic/src/workflow/runtime/`、workflow component/runtime tools、相关 package manifests/lock 与 workflow tests。
- 数据：Eidolon workflow runtime root 下的 legacy flat facts 与新的 depa-native `instances/` tree。
