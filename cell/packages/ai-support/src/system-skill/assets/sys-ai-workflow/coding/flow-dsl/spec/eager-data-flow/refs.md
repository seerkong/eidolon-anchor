# L3 · EagerDataFlow 引用协议

> EagerDataFlow 同时使用 unit 引用、当前 flow 私有 node/port 引用和代码引用。scheme 决定 target 类别，不能仅凭字符串形状猜测。

## 引用一览

| scheme | target | public fields | example |
|---|---|---|---|
| `eager-data-flow://` | 已注册的 EagerDataFlow FQN | `SubFlowNode.flow` | `"eager-data-flow://depa.flows.demo.Normalize"` |
| `flow-port://` | 当前 flow 某节点已声明的 output port | node `inputs` values | `"flow-port://#normalize/customers"` |
| `flow-node://` | 当前 flow 某节点的成功 completion fact | node `waitFor` items | `"flow-node://#audit"` |
| `vfs://` | type 或 implementation export | FlowContract `input`/`output`; node `type`/`src`/`impl` | `"vfs://./flow-code/export.ts#createArchive"` |
| `config://` | 当前 bundle ConfigEntry 或 sub-path | node config binding | `"config://#export/archiveFormat"` |
| `config-def://` | 当前 bundle ConfigEntryDef | config tooling | `"config-def://#export"` |
| `flow-authoring://` | 当前 bundle layout entry | editor projection | `"flow-authoring://#normalize"` |

`eager-data-flow://` 只解析公开根为 `EagerDataFlow` 的 unit；目标使用其他 root tag 时链接失败。

## Data edge

格式严格为：

```text
flow-port://#<node-id>/<output-port>
```

它只能出现在 `inputs` map 的 value。`node-id` 和 `output-port` 都在当前 EagerDataFlow 内解析；目标节点必须存在并声明该 port。EntryNode ports 来自当前 FlowContract，TransformNode ports 来自 outputs，SubFlowNode ports 来自目标 FlowContract。

```xnl
<TransformNode #flatten {
  inputs = {
    records = "flow-port://#subflow/records"
    schema = "flow-port://#load-schema/schema"
  }
  outputs = ["archive"]
  src = "vfs://./flow-code/export.ts#flatten"
}>
```

## Completion edge

格式严格为：

```text
flow-node://#<node-id>
```

它只能出现在 `waitFor` list。引用表示目标节点必须成功完成，不携带数据，也不能包含 `/port` sub-path。SinkNode 虽无 output port，仍可通过 completion fact 建立副作用顺序。

```xnl
<SinkNode #publish {
  inputs = { archive = "flow-port://#archive/archive" }
  waitFor = ["flow-node://#audit"]
  src = "vfs://./flow-code/export.ts#publish"
}>
```

data edge 与 completion edge 即使 endpoint 相同也都保留。ready 条件要求两者分别满足；联合拓扑校验必须覆盖两者。

## Subflow reference

```xnl
<SubFlowNode #normalize {
  flow = "eager-data-flow://depa.flows.demo.NormalizeCustomers"
  inputs = { customers = "flow-port://#entry/customers" }
}>
```

`eager-data-flow://<FQN>` 跨 unit 解析，但不能穿透目标内部。链接器读取目标 FlowContract 来校验 inputs 并派生 outputs；父 flow 后续只能引用 `flow-port://#normalize/<target-output-port>` 或 `flow-node://#normalize`。

Subflow unit 调用图必须无环。直接自调用或 A -> B -> A 都是链接错误，而不是 runtime recursion。

## Code ref

`type`、`src`、`impl` 以及 FlowContract type 都使用带 export fragment 的 `vfs://<path>#<Export>`。只指向文件、使用非 vfs scheme、或在 XNL 中内嵌函数均无效。

- `./` 相对当前 flow bundle 根，`@/` 相对工作区根。
- `type` 指向函数/record type export，不执行。
- `src` / `impl` 指向动态实现 export；canonical node 至多声明其中一个。
- loader/compiler 只校验和投影引用，runtime materialization 才解析 module。

动态实现统一遵守 `output = fn(runtime, input, config)`，详细 output 约束见[nodes](nodes.md#transformnode--sinknode-代码协议)。

## 解析拒绝

- `flow-port://` / `flow-node://` 跨 unit、缺少 `#id` 或使用错误 sub-path。
- `waitFor` 使用 port ref，或 `inputs` 使用 node completion ref。
- SubFlowNode 指向旧 DataFlow 根、CtrlFlow profile 或未注册 FQN。
- 任何 URI 指向不存在的 node、port、entry、file 或 export。
- 使用 DataGraph 的 slot refs、`data-graph://` 或 `scope-data-graph://` 代替 flow dependency。
