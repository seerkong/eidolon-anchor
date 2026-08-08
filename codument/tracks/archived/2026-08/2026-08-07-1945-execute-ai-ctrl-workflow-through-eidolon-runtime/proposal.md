# 变更：通过 Eidolon Runtime 执行 AICtrlWorkflow

## 背景

当前 `WorkflowRun` 只把 workflow ref 包成 prompt 并创建一个 detached actor，整个图从未被加载或运行。AICtrlWorkflow 必须由 depa-flows WorkCtrlFlow controller 推进，Eidolon 只提供资源、effects、actor/session facts 和 workflow-fact persistence。

## 目标

- 从 runtime-bound workspace 解析 resource/vfs ref 并加载 canonical AICtrlWorkflow binding。
- 使用 `createAICtrlWorkflowController` 执行、等待、恢复和投影稳定 node/invocation facts。
- workflow snapshots/descriptors/events 作为 workflow facts 持久化到当前 Eidolon session/workspace runtime root。
- Run code 通过 embedded effect provider 调用 Eidolon native tool、actor 和 material adapters，并把 effect evidence 接入现有 runtime-control lifecycle。
- `WorkflowRun/Status/Events/Result/Resume` 对真实 ctrl runs 工作；保留对既有 detached records 的只读兼容。

## 非目标

- 不在本 track 实现 AIDataWorkflow RunGraph。
- 不改变 WorkCtrlFlow grammar，不创建角色专属节点。
- 不把 actor/conversation/tool facts复制到 workflow snapshot。
