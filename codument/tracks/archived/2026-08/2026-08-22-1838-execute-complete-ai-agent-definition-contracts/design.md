# Design：complete AIAgentDefinition execution

## 1. Authority pipeline

```text
Halfcode admitted effective registry
  -> depa AIWorkflowAgentResourceProjection
  -> depa AIWorkflowRunResourceFreezeReceipt
  -> EidolonResourceAgentExecutionPlan
  -> generic AgentExecutionContract
  -> existing delegate actor / Conversation Domain / ToolFuncRegistry
  -> validated child result
  -> ordinary Ctrl/Data workflow node output
```

Halfcode owns source identity/content/layer/dependency proof；depa owns Agent/schema/policy/Material domain projection；Eidolon owns host validation、tool admission、actor execution and durable recovery。后两层不得形成第二 registry。

## 2. Generic execution contract

`AgentConfig` additive 增加可选、纯数据、可持久化 `executionContract`：

```ts
type AgentExecutionContract = {
  schemaVersion: "eidolon.agent-execution-contract/v1"
  input: {
    schemaVersion: "eidolon.agent-execution-input/v1"
    payload: unknown
    materials: readonly MaterialPortInput[]
  }
  messageSchemas: readonly { messageId: string; schema: JsonSchemaValue }[]
  inputSchema?: JsonSchemaValue
  outputSchema?: JsonSchemaValue
  effectPolicy: { toolMode: "declared-only" | "none" }
}
```

它不是 workflow 类型：任意 generic Agent config 均可携带。actor创建时把完整contract复制到actor state；serialize/hydrate与file snapshot repository round-trip，旧snapshot缺字段按undefined兼容。

所有值先经过 closed plain-data normalization：plain/null-prototype objects、dense arrays、finite numbers、strings/booleans/null；拒绝accessor、symbol、extra array key、cycle、non-plain prototype。canonical object key使用显式UTF-16 code-unit order。

## 3. Input and Material delivery

Resource `ai.agent` invocation使用closed payload：exact `agentDefinitionRef`加显式`payload`。运行host从depa receipt的ordered binding ids与projection组装：

```ts
type MaterialPortInput = {
  portResourceId: string
  materialKind: string
  required: boolean
  cardinality: "one" | "many"
  values: readonly {
    bindingResourceId: string
    materialResourceId: string
    value: JsonValue
  }[]
}
```

port顺序来自Agent `MaterialPortRefs[]`；many values顺序来自depa freeze receipt。host不按名称merge object，也不把Material读成文件。每个`MaterialPort.schema`验证对应value；Agent `InputSchemaRef`验证invocation `payload`。资源Message的schema验证resolved Prompt Content string。

验证成功后，generic delegate bootstrap把`{payload, materials}`作为canonical JSON user input注入Conversation Domain。资源Agent不接受自由prompt覆盖；system/developer/user/assistant seed messages只来自definition的ordered Messages。

## 4. Effect policy and tools

- absent policy：保持0.1.x compatibility，等价`declared-only`；
- `declared-only`：`AgentConfig.tools`只能是投影中exact Tool resource ids，`requireExactTools=true`；
- `none`：tools必须为空；definition同时声明ToolRefs时稳定拒绝；
- unknown mode已由depa projector拒绝，host仍验证frozen plan closed shape。

Tool registry membership仍由`validateExactAgentTools`校验。host不创建suffix alias、短名或fallback key。

## 5. Schema validation and output

Eidolon直接精确依赖一个JSON Schema validator package；dialect与选项在generic validator module固定，禁止调用方注入code/function。compile diagnostics做bounded projection，不记录prompt、Material正文或provider output。

provider最终文本的typed result selection是确定性的：先验证raw string；若不通过且文本可做一次JSON parse，再验证parsed value；两者都不通过则失败。只有一个候选通过才产生validated result。结果验证必须位于generic child completion/result-delivery seam，在父actor tool result、workflow effect completed event或success fact写入前执行；immediate与orchestrated execution复用同一函数。

## 6. Frozen recovery

`WorkflowAgentExecutionFact`继续是effect-bound owner fact，升级后完整保存execution plan/contract + depa receipt。首次dispatch在actor创建前写fact；同run/generation/effect恢复只读取该fact，不重投影live registry。plan、receipt、execution contract、payload/material values或task tuple任一不一致均稳定拒绝；相同请求不产生第二fact或第二provider child。

actor snapshot同时持久化generic execution contract，使provider等待、tool等待与进程恢复不丢schema/policy。不得用child conversation history重建这些事实。

## 7. Ctrl/Data integration

- `AICtrlWorkflow`：普通`Run` code显式调用`runtime.ai.effects.invoke({ operation: "ai.agent", input: { agentDefinitionRef, payload } })`。
- `AIDataWorkflow`：普通`TransformNode` code使用同一invocation。
- provider/runtime identity仍来自既有`runtime.ai.metadata.run` + `runtime.ai.effects.invoke` capability。
- 两个profile共享adapter、effect provider、execution fact、generic actor与result validator；仅workflow substrate lifecycle不同。

## 8. Skills and verification

Authoring/DevOps references更新depa Flow DSL `0.1.1`内容并只增长1.0.x patch；Run operation说明exact resource Agent execution/input/result receipts。generated four-Skill plan仍是唯一安装authority，`eidolon global init` readback必须一致。

先以fake provider/registered exact tool执行真实Halfcode ResourcePackage：Ctrl与Data各一条成功E2E，并覆盖input/message/material/output schema失败、policy none/declared-only、missing tool、restart/retry/frozen package drift。再运行workflow suites、actor snapshot repository、generator check、server/TUI build、compiled local global init与static boundary scans。terminal phase运行fresh coding AttractorCheck。
