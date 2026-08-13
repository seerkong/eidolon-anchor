# L3 · EagerDataFlow nodes 与执行语义

> 本页定义 EagerDataFlow 的公开根、FlowContract、五种节点和 ready scheduling。引用与跨 unit 规则见[引用协议](refs.md)，事实 owner 见[域与运行事实](domains.md)。

## 完整 definition

```xnl
<EagerDataFlow #depa.flows.demo.CustomerExport apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #depa.flows.demo.CustomerExport {
    input = "vfs://./flow-code/export.types.ts#CustomerExportInput"
    output = "vfs://./flow-code/export.types.ts#CustomerExportOutput"
    inputPorts = ["customers"]
    outputPorts = ["archive"]
  }>
) [
  <EntryNode #entry>
  <TransformNode #normalize {
    inputs = { customers = "flow-port://#entry/customers" }
    outputs = ["customers"]
    type = "vfs://./flow-code/export.types.ts#NormalizeCustomers"
    src = "vfs://./flow-code/export.ts#normalizeCustomers"
    config = { trimNames = true }
  }>
  <SinkNode #audit {
    inputs = { customers = "flow-port://#normalize/customers" }
    src = "vfs://./flow-code/export.ts#auditCustomers"
  }>
  <TransformNode #archive {
    inputs = { customers = "flow-port://#normalize/customers" }
    outputs = ["archive"]
    waitFor = ["flow-node://#audit"]
    src = "vfs://./flow-code/export.ts#createArchive"
  }>
  <ReturnNode #return {
    inputs = { archive = "flow-port://#archive/archive" }
  }>
]>
```

`()` 中的 FlowContract 是按 tag 唯一的子域；DAG nodes 直接进入根 `[]`，没有 `Nodes` wrapper。节点 `#id` 在当前 definition 内唯一，数组顺序不创建依赖。

## `<FlowContract>`

| 字段 | 必填 | 约束 |
|---|---:|---|
| `#id` | 是 | 必须等于 EagerDataFlow 根 FQN |
| `inputPorts` | 是 | 唯一非空 port name 列表；调用 input record 必须恰好匹配 |
| `outputPorts` | 是 | 唯一非空 port name 列表；公开 output record 必须恰好匹配 |
| `input` | 否 | `vfs://...#Export`，描述完整 input record type |
| `output` | 否 | `vfs://...#Export`，描述完整 output record type |

port name 是节点局部 key，必须匹配 `[A-Za-z_][A-Za-z0-9_-]*`。input/output type 是静态契约，不是 runtime validator 或实现函数；runtime 可以用其派生 validator，但不能把派生物写回 definition。

## 五种节点

| node | inputs | outputs | code / target | 完成语义 |
|---|---|---|---|---|
| `EntryNode` | 禁止 | 由 contract inputPorts 派生 | 禁止 | invocation input 校验并发布后完成 |
| `TransformNode` | 必填 map | 必填且唯一的列表 | `type` 可选；实现 binding 必须可解析 | 实现成功返回完整 output record 后完成 |
| `SinkNode` | 必填 map | 禁止 | `type` 可选；实现 binding 必须可解析 | 实现成功返回 `void` 后只发布 completion fact |
| `SubFlowNode` | 必须恰好匹配目标 inputPorts | 由目标 outputPorts 派生 | `flow` 必填；禁止 node code | 子 flow 整体成功后发布 outputs 与 completion fact |
| `ReturnNode` | 必须恰好匹配当前 outputPorts | 禁止 | 禁止 | 捕获公开 output；flow 仍等待本 invocation 的其他节点收敛 |

除 EntryNode 外，节点都可声明 `waitFor = ["flow-node://#..."]`。`inputs` 的 key 是本节点形参名，value 必须是当前 flow 内的 `flow-port://`。一个 input key 只能绑定一个上游 port；多个下游可以读取同一 output port。

## TransformNode / SinkNode 代码协议

```ts
type EagerNodeCode<Runtime, Input, Config, Output> = (
  runtime: Runtime,
  input: Readonly<Input>,
  config: Readonly<Config>,
) => Output | Promise<Output>;
```

```ts
export async function normalizeCustomers(runtime, input, config) {
  const customers = input.customers.map((customer) => ({
    ...customer,
    name: config.trimNames ? customer.name.trim() : customer.name,
  }));
  return { customers };
}

export async function auditCustomers(runtime, input, config) {
  await runtime.callEffect('audit.customers', input.customers, config);
}
```

- `config` 来自节点 `{ config = { ... } }`，缺省 `{}`；结构字段 `inputs`、`outputs`、`waitFor`、`type`、`src`、`impl` 不进入 config。
- TransformNode 必须返回普通 object，own keys 与 outputs 完全一致。缺 key、多 key、返回非 object 都是协议 fault。
- SinkNode 必须返回 `undefined`/`void`；它没有可引用 port，但成功后可由 `flow-node://` 等待。
- `type` 是可选函数类型 export；`src` 或 `impl` 是 node-local implementation export。canonical node 至多声明一个 `src`/`impl`，Split/Public 装配也必须最终解析到唯一实现。
- code ref 只保存于 XNL；loader/compiler 不 import 或执行代码，materialization/runtime 才解析实现。

EntryNode、ReturnNode 和 SubFlowNode 是结构节点，不接受 `type`、`src` 或 `impl`。SubFlowNode 的代码边界由目标 FlowContract 定义。

## SubFlowNode

```xnl
<SubFlowNode #classify {
  flow = "eager-data-flow://depa.flows.demo.CustomerClassification"
  inputs = { customers = "flow-port://#normalize/customers" }
}>
```

链接期必须解析目标 EagerDataFlow 的 FlowContract。调用节点 inputs key 与目标 inputPorts 做集合相等校验；调用节点 outputs 不在本地声明，而是复制目标 outputPorts。子 flow 使用独立 invocation runtime state，父子之间只传 contract records。

父流只观察 SubFlowNode 整体完成：子流内部 port 和 completion fact 都不可寻址。子流 fault 归一化为带父节点 id、目标 flow FQN 和原始 cause 的 SubFlow fault。

## Ready scheduling

调度器从两类依赖建立同一张联合 DAG，但在 authoring plan 中继续分别保存 dataEdges 和 waitForEdges：

```text
ready(node) = every declared input port is published
           && every waitFor target completed successfully
```

1. invocation input 通过 contract 校验后，EntryNode 发布 input ports。
2. 每次 port 发布或节点完成后，调度器重新计算 ready set。
3. 同一轮所有 ready 节点都可启动；不得按根数组顺序串行化。
4. 节点启动后至多执行一次；output record 完整校验后原子发布全部 ports，再发布成功 completion fact。
5. ReturnNode 捕获 output record；所有 definition nodes 均成功完成后 invocation 才成功返回。

并发节点之间没有隐式 side-effect 顺序。若业务要求 `audit` 完成后才能 `archive`，必须像完整示例一样写 `waitFor`。重复声明相同 data/completion endpoint 可以同时存在，因为两类边保留不同 authoring intent。

## 拓扑与链接校验

加载/链接在执行任何代码前必须拒绝：

- 不是恰好一个 FlowContract、EntryNode 或 ReturnNode；
- 重复 node id、重复 port、未知节点或未知 output port；
- EntryNode 有 incoming dependency，ReturnNode 有 outgoing data edge，或节点依赖自身；
- dataEdges 与 waitForEdges 的并集存在直接或间接环；
- 存在无法从 EntryNode 经联合边到达的节点；
- ReturnNode inputs 与当前 outputPorts 不完全相等；
- SubFlowNode inputs/outputs 与目标 contract 不匹配，目标未注册或不是 EagerDataFlow；
- unit 级 SubFlowNode 调用图存在直接或间接递归。

联合 DAG 校验使用 node identity；同一 endpoint 上同时存在 data edge 和 completion edge 时，拓扑算法可把它们视为一条邻接关系计算入度，但 authoring plan 和诊断必须保留两条原始事实。

## 错误传播

任一节点产生技术 fault 时，invocation 立即进入 failing：不再启动未开始节点，所有依赖该节点的节点保持未执行，已运行节点收到 runtime cancellation。并发中的其他 fault 可作为 causes 聚合；primary fault 必须按稳定拓扑层和根声明顺序选择，避免调度时序改变外部错误。

失败 invocation 不返回 ReturnNode 捕获的部分 output。已经完成的 SinkNode 或其他 effect 不自动补偿；补偿、幂等和事务能力由显式 runtime/effect 契约提供。业务拒绝、空结果等仍是 port data，只有 throw、fault 或协议违反进入失败通道。

## Rejected nodes

`ComputedNode`、`ProcessorNode`、`AsyncNode`、`ConsumerNode` 和 SignalNode 属于 lazy DataGraph。`ComputeNode`、`ConsumeNode` 也不是 EagerDataFlow alias。旧 `<DataFlow>` 根无效，即使内部节点全部符合本页也必须拒绝。
