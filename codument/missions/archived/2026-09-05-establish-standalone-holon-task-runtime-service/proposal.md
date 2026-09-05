# Mission: establish-standalone-holon-task-runtime-service

## 背景

Eidolon 过去能够把任务直接 assign 给 autonomous collective/holon，由组织内部的 task board、claim 与 member actor 自治完成。后续 Holon 改造正确地淘汰了进程内 VM TaskTree，并建立了更可靠的 File-XNL Holon authority、`HolonExecutionBinding`、TaskSpace、共享 `HolonCoordinator`/`MemberRuntime` 与 durable pump。

但产品入口的最后一次切换把 canonical assignment authority 临时注册在 `WorkflowRuntimeService` 内：只有某个 AI Ctrl/Data Workflow 冻结了 `HolonTaskTarget` 并启动后，`HolonAssign`/`ActorAssign` 才能得到可执行 authority。结果是底层组织执行能力虽然已经成熟，却不能脱离 Workflow 单独使用。

## 目标

建立独立的 `HolonTaskRuntimeService`：

- 从 Halfcode 资源体系中的冻结 Holon snapshot、`HolonExecutionBinding` 与中立 task-runtime definition/admission 构造可执行 authority；
- 接受组织级与 canonical member 级任务派发，通过 TaskSpace 进行 claim、start、heartbeat、dispatch、settle 与 recovery；
- 支持 `final`、`none`、`stream` 三种既有 assign 语义；
- 让产品 `HolonAssign`/`ActorAssign`、canonical member assignment、AI Ctrl Workflow 与 AI Data Workflow 都成为同一服务的 adapter；
- 保留 generic actor/session 对对话历史的唯一 ownership，TaskSpace 只拥有任务生命周期与 receipts；
- 在退出、崩溃与 fresh process 后从本地文件恢复 pending TaskSpace，而不依赖存活的 Workflow instance。

## 核心约束

1. 不恢复已删除的 VM `AutonomousHolonTaskRunner` 或第二套 TaskTree writer。
2. Holon Workbench/File-XNL 仍是组织主数据 authority；TaskSpace 仍是 task/claim/result/history authority。
3. `HolonExecutionBinding` 仍是 member/role 到 AI、human、service、hybrid adapter 的唯一映射。
4. Workflow 的 `HolonTaskTarget` 保持 Workflow DSL adapter contract；中立运行时 contract 位于 `ai-organ`，不得要求核心服务携带 `workflowInstanceId`、`runId` 或 `nodeId`。
5. 组织或成员目标必须解析到一个精确冻结 admission；零个时 fail closed，多个时报告 ambiguity，绝不按名称或遍历顺序猜测。
6. session 内临时 Member 的 mailbox 语义可以继续存在，但必须与“冻结 Holon snapshot 中的 canonical member task”明确区分，不得互相伪装。

## 交付

- `@cell/ai-organ-contract` 中的中立 task-runtime contract；
- `@cell/ai-organ-logic` 中可独立 bootstrap/open/assign/observe/recover 的 `HolonTaskRuntimeService`；
- Workflow target → runtime admission 的薄适配器；
- 产品 Holon/member assign 入口的统一接线；
- 旧 persisted Workflow organization-task profile/subscription 的兼容读取；
- 无 Workflow 的 E2E、成员精确路由、并发/幂等、崩溃恢复、Ctrl/Data 回归与 canonical architecture 文档。

## 非目标

- 多节点/远程 transport、分布式 leader election 或 Mission 2 部署；
- 重新设计 Holon Workbench 的组织存储；
- 让任务命令直接选择任意 Agent instance；
- 把所有 session-local Member 强制迁入持久 Holon；
- 未经用户另行明确授权执行 `npm publish`、dist-tag 等 registry 写操作；`depa-flows` 的 0.3 公共库迁移与候选打包属于本 Mission，业务 app/server/web 仍不进入发布闭包。

## 成功标准

- 未启动任何 AI Workflow 时，存在唯一合法 runtime admission 的 autonomous Holon 和 canonical member 均可被 assign 并完成任务；
- 相同服务实例同时服务产品 assign 与 Workflow，代码中不存在 Workflow 私有的第二套 TaskSpace owner/pump lifecycle；
- fresh process 能恢复并继续既有 TaskSpace，且 TaskSpace、deployment store、journal 与 actor/session receipt 互相校验；
- 历史 Workflow task 数据仍可读、可观察、可完成；
- 相关 contract/typecheck/unit/E2E、Ctrl/Data Workflow regression 与 Codument strict validation 全部通过。

## 0.3 联合迁移扩展

normal VM 的最终物理验收依赖三个独立 authority 同步收敛，因此本 Mission 扩展到 `halfcode-compiler.xnl`、`holon-workbench.ts` 与 Eidolon：

- Halfcode 发布候选提供 0.3 envelope、exact Kind spec/fingerprint 与可独立消费的 npm tarball；
- Holarchy 作为 `HolonEffectiveSnapshot` owner 迁移其 canonical KindDefinition 与本地文件库包闭包；
- Eidolon 迁移 `HolonExecutionBinding`、`HolonTaskRuntimeDefinition`、资源树和 runtime consumer，再完成 normal VM/fresh restart 验收；
- 发布准备只覆盖库级能力，不发布 Holon Workbench server/web 等业务应用；真实 npm 发布另需明确授权并强制使用 `/Users/kongweixian/.npmrc_official`。

最终 clean build 还必须把 XNL VFS 当成独立 authority 纳入闭包：Eidolon 的 effective VFS materializer 只消费 `xnl-vfs` 公开 overlay/CAS API，不复制 planner 或 persistence owner。旧增量依赖树曾掩盖 `xnl-vfs@0.1.2` 尚未包含这些公开导出的事实；因此正式发布验收必须先发布经过原 owner 全包验证的新版本，再重做 lock 与 clean/frozen install。

## 正式发布与最终构建授权

2026-09-04，用户明确授权发布已通过联合验证的公共依赖候选。发布必须继续遵守以下边界：

- 只发布已经过 owner package 全包验证并有精确摘要的公共库 tarball；clean build 新发现的遗漏依赖必须先在其 owner 仓验证、形成新增候选并登记纠偏证据，不能在 Eidolon 复制实现；
- 每条 npm 命令显式使用 `/Users/kongweixian/.npmrc_official`，并在每个依赖层完成后回读 registry identity/integrity；
- 已占用且内容不一致的坐标立即 fail closed；Holon Workbench app/server/web 永不发布；
- 公共闭包可见后，从 registry 刷新 Eidolon `bun.lock`，执行 clean/frozen install、最终 terminal 构建和产物 smoke。
