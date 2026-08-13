# Canonical AI Workflow generation kernel

## `WorkflowCreateBundle` 双文件投影

fresh create 的原子工具只写 `manifest.xnl` 与 `flow-code/index.ts`。此时 `manifest_content` 必须直接以所选 profile 根元素 `<AIDataWorkflow ...>` 或 `<AICtrlWorkflow ...>` 开头；不要在该参数中再包 `AIWorkflowAppBundle`，也不要引用工具没有创建的 `workflows/*.xnl`。下方 `AIWorkflowAppBundle`/`ResourceCatalog` 骨架保留为扩展多资源目录的 L1→substrate→profile 规范，不是双文件工具参数的外层包装。

## 生成次序

1. 声明可寻址 resources。
2. 选择 substrate：纯数据传播用 `EagerDataFlow`；需要状态、等待、恢复或控制转移用 `WorkCtrlFlow`。
3. 用 `AIWorkflowAppBundle` 连接资源与 workflow profile。
4. 数据式 AI 编排使用 `AIDataWorkflow`；控制式 AI 编排使用 `AICtrlWorkflow`。
5. 函数节点只引用显式 function resource；副作用必须位于 Effect/Actor 边界。

## Canonical resource tree

所有新资源只用 XNL，`manifest.xnl` 通过显式 `ResourceCatalog` 组成 bundle，目录递归不产生资源组合。入口骨架：

```xnl
<AIWorkflowAppBundle #depa.examples.App apiVersion="depa.flows/v1" version="0.1.0" (
  <ResourceCatalog #main [
    <ResourceEntry #workflow {
      kind = "AIDataWorkflow"
      fqn = "depa.examples.App.Workflow"
      ref = "resource://depa.examples.App.Workflow"
      source = "vfs://./workflows/main.workflow.xnl"
    }>
  ]>
)>
```

`AIDataWorkflow` 使用 EagerDataFlow 的 `EntryNode`、`TransformNode`、`SinkNode`、`SubFlowNode`、`ReturnNode`；数据依赖使用 `flow-port://#node/port`。最小形状：

```xnl
<AIDataWorkflow #depa.examples.App.Workflow apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #depa.examples.App.Workflow { inputPorts = ["input"] outputPorts = ["result"] }>
) [
  <EntryNode #entry>
  <TransformNode #process {
    inputs = { input = "flow-port://#entry/input" }
    outputs = ["result"]
    src = "vfs://./flow-code/process.ts#process"
  }>
  <ReturnNode #return { inputs = { result = "flow-port://#process/result" } }>
]>
```

`AICtrlWorkflow` 使用 WorkCtrlFlow 的 `Run`、`If`、`Fallback`、`Retry`、`Timeout`、`Until`、`ForEach`、`Parallel`、`Race`、`CallFlow`、`Return`，以及 `ExternalJob`、`Timer`。等待外部信号的最小形状：

```xnl
<AICtrlWorkflow #depa.examples.App.Review apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #depa.examples.App.Review {
    input = "vfs://./flow-code/review.ts#ReviewInput"
    output = "vfs://./flow-code/review.ts#ReviewResult"
  }>
) [
  <Run #draft { src = "vfs://./flow-code/review.ts#draft" }>
  <ExternalJob #review { signalKind = "review.completed" signalKey = "review" }>
  <Return #done { src = "vfs://./flow-code/review.ts#toResult" }>
]>
```

## Dynamic function contract

AIDataWorkflow 的 `TransformNode`/`SinkNode` export ABI 是 `(runtime, inputs, config)`；`inputs` 属性已经是上游 port 的解包值，函数返回值必须是节点声明的精确 output map。AICtrlWorkflow dynamic code 通过 runtime 调用显式 effect。函数不能通过隐藏全局状态改变 definition；effect evidence 写入运行域。

output map 以 port identity 为键，不是把业务对象直接返回。例如 `outputs=["hn"]` 时必须 `return { hn: sourceResult }`，不能 `return sourceResult` 或 `return {status, source, items}`；`outputs=["items" "status"]` 时返回对象也必须且只能包含 `items`、`status`。共享 helper 可以返回业务对象，但每个 manifest 引用的 export 必须在边界包装成 exact output map。prepare-publication 的 deterministic build 会在真实 effect 之前拒绝可静态证明的不一致。

## Runtime effect capability contract

每个 effect request 的 `run` 是运行域的必需 capability，唯一来源是 `runtime.ai.metadata.run`。不得猜测、硬编码或探测 run identity，也不得把 run 放在 `invoke` 的第二参数。所有 effect export 必须复用下面的精确 helper 骨架：

```ts
async function invokeEffect(runtime: any, input: unknown, config: Record<string, unknown> = {}) {
  const run = runtime?.ai?.metadata?.run
  if (!run?.runId) throw new Error("AI workflow runtime run identity is required")
  const nodeId = String(config.nodeId ?? "effect")
  return runtime.ai.effects.invoke({
    effectId: String(config.effectId ?? `${run.runId}:${run.generation ?? 0}:${nodeId}`),
    operation: String(config.operation ?? "tool.call"),
    input,
    config,
    run,
    nodeId,
  })
}
```

禁止生成 runtime probe、capability introspection 或试探性 `effects.invoke` 调用。coding 阶段直接生成满足业务需求的 definition 与 flow-code；如果缺少精确契约，只能读取本 stage 的 canonical 文档，不能发布探针让真实运行替 authoring 探路。

Eidolon runtime 只支持以下五个精确 operation；它们是 capability identity，不是可扩展的自然语言标签：

- `identity`
- `tool.call`
- `ai.agent`
- `material.read`
- `material.write`

不得臆造 `http.get`、`github.searchRepositories`、`hn.topStories`、`dev.articles` 等 operation。调用已注册工具统一使用 `tool.call`，输入形状必须是 `{ toolName, args }`。例如公共 HTTP/HTTPS 读取通过已注册的 `webfetch` 工具完成：

```ts
const response = await invokeEffect(runtime, {
  toolName: "webfetch",
  args: { url: "https://example.com/api/items", format: "text" },
}, {
  operation: "tool.call",
  nodeId: "fetch-items",
  effectId: "fetch-items:request",
})
```

`webfetch` 返回字符串。调用方必须识别以 `Error:` 开头的失败结果，并在需要 JSON 时显式 `JSON.parse`。模型依据业务需求选择工具、URL、解析和降级策略；host 只校验精确 capability identity，不按自然语言关键词猜测 operation。

外部多源采集必须显式定义 failure contract：允许部分源降级时保留可观测的 source error；所有必需源均失败时必须抛出错误，使 workflow 进入 `Failed`，不得继续渲染空白、伪成功或无证据报告。

## 拒绝的语法

- XML、新 JSON/YAML authoring surface，或缺少 `#identity`、`apiVersion`、`version` 的 XNL 根元素。
- `Source/Processor/Start/Task/End` 等看似合理但不属于所选 canonical profile 的节点别名。
- `if user text matches ...` 形式的 host route。
- 在 definition 中写 publication、instance、run id 或运行输出。
- host 绝对路径、裸相对路径、`..` escape、反斜杠路径和未登记 URI scheme。
- 跨 substrate 随意拼接节点，或在 AICtrlWorkflow 中使用 BPCtrlFlow-only `TaskStep`。
