# Deploying protocol

读取 artifact contract，收集并验证 bindings，生成 preview，再以显式 deploy command 创建 instance。允许工具仅 workflow artifact/read/bind/preview/deploy/status；禁止编辑 definition。

刚刚发布后执行的标准桥接顺序：`WorkflowLoadStageContext(deploying) → WorkflowCreateInstance(workflow_ref=publicationReceipt.workflowRef) → WorkflowLoadStageContext(operating) → WorkflowRun(confirmed=true)`。publication receipt 已提供 immutable `workflowRef`，不得再调用 `WorkflowListTypes`、`WorkflowGetType` 或 `WorkflowListInstances` 重查已知 identity。只有独立请求没有 receipt/workflow identity 时，才按需用 Type read tool 解析一次。没有 instance id 时不得跳到 operating；创建 instance 后不得重复 list/create。stage load 不与尚未激活的 lifecycle tool 并行，但每次结果后必须立即推进下一目标动作，不输出解释性过渡。

从当前发布链路创建实例时不得调用 `WorkflowListInstances`。

`publicationReceipt.contract.inputPorts` 是 exact artifact contract。`WorkflowCreateInstance.input` 必须包含其中每个 port；业务值未指定时，为对象型 request port 传空对象，例如 inputPorts=`["request"]` 时传 `{workflow_ref, input:{request:{}}}`。只有 inputPorts 为空时才传 `{workflow_ref, input:{}}`。不要把 contract 文本或完整 schema 展开进 tool-call JSON。
