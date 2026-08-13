# L3 · EagerDataFlow 文件组织

## 单文件 definition

小型 EagerDataFlow 可以由一个 XNL 文件承载。文件名不决定类别；`EagerDataFlow` 根 tag 和根 FQN 才是 identity。

```text
flows/
  customer-export.xnl
  flow-code/
    export.types.ts
    export.ts
```

```xnl
<EagerDataFlow #depa.flows.demo.CustomerExport apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #depa.flows.demo.CustomerExport {
    inputPorts = ["customers"]
    outputPorts = ["archive"]
  }>
) [
  <EntryNode #entry>
  <TransformNode #archive {
    inputs = { customers = "flow-port://#entry/customers" }
    outputs = ["archive"]
    src = "vfs://./flow-code/export.ts#createArchive"
  }>
  <ReturnNode #return {
    inputs = { archive = "flow-port://#archive/archive" }
  }>
]>
```

## 目录 definition

复杂 flow 使用 folder unit：

```text
flows/customer-export/
  manifest.xnl             # <EagerDataFlow #depa.flows.demo.CustomerExport>
  flow.contract.xnl        # 可选外提的唯一 FlowContract 子域
  config.xnl               # 可选静态 config
  config.def.xnl           # 可选 config shape
  flow.authoring.xnl       # 可选布局事实
  flow-code/
    export.types.ts
    export.ts
```

`manifest.xnl` 是唯一 definition 入口，始终持有根 `[]` 的 node topology。FlowContract 可以内联在根 `()`，也可以按唯一子域外提为 `flow.contract.xnl`；两种形态逻辑等价，不能同时声明。FlowAuthoring 同理可内联或外提，但只保存 layout/viewport。

## 单/多文件边界

- 根 tag 必须是 `EagerDataFlow`，`#id` 必须是 FQN；文件名不能创建第二个 identity。
- 根 `[]` 只直接包含 EntryNode、TransformNode、SinkNode、SubFlowNode、ReturnNode。
- `FlowContract`、`FlowAuthoring` 进入 `()` 唯一子域区，不得用 `Nodes`、`Graph` 或 `Block` 包装 DAG。
- `vfs://./...` 相对当前 flow bundle 根解析；单文件和目录形态不改变逻辑引用。
- code export 保存在 `.ts` 等脚本中，XNL 只保存 `type` / `src` / `impl` 引用。
- loader/compiler 输出的 plan、edge list、topological order 和运行状态都是可重建派生物，不持久化为 definition 文件。

## Removed File Shapes

以下形态必须拒绝，不能作为兼容入口：

- 以 `<DataFlow>` 作为单文件或 manifest 根。
- `nodes.xnl`、`edges.xnl`、`*.graph.json` 或其他第二份 topology。
- DataGraph 的 `data.graph.xnl` / `data.graph.seed.xnl` 被当作 EagerDataFlow definition。
- XNL 中内联函数、表达式或 runtime handler object。
