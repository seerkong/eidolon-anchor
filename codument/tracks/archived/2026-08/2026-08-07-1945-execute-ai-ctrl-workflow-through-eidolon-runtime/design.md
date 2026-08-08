# 设计：AICtrlWorkflow Eidolon Runtime Adapter

`WorkflowRuntimeService` 以 VM 为 binding scope。它解析资源、创建 canonical controller，并维护可重建的 run descriptor。`WorkCtrlFlowStore` 使用 workflow runtime fact files；当 sessionDir 存在时放在该 session 下，否则放在 workspace workflow root 的 runtime 子树。恢复时 descriptor + snapshot 重建 controller，不保存 engine 私有对象。

Flow code 使用 depa-flows filesystem resolver，base URI 被限制在 bundle 目录。默认 bundle code 提供通用 `invokeEffect`，operation/nodeId 位于 XNL config。

Embedded effect provider：tool call 进入现有 ToolFuncRegistry；同步 agent operation 通过 `spawnChildExecutionActor(mode="sync_wait")` 进入既有 actor 体系，durable async wait 则由 ExternalJob 表达；material read/write 进入共享 authoring workspace。请求/结果/失败在 sessionDir 可用时追加到现有 runtime-control effect evidence。Workflow 仅保存 effect ref/event，不复制 provider/tool/actor facts。

ExternalJob 由 WorkCtrlFlow 打开稳定 WaitHandle；`WorkflowResume` 必须回传 signalKind/signalKey/resumeToken/payload。状态定位使用 node ID 与 invocation key，不使用数组位置。
