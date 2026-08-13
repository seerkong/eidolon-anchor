# L3 · EagerDataFlow 事实与域

> EagerDataFlow definition 是 topology、node config 和 contract 的唯一 authoring 真源。编译 plan、invocation state 与 editor layout 都不能反向覆盖它。

## Authoring Facts

| owner | file / projection | root | entries / scheme | 语义 |
|---|---|---|---|---|
| flow definition | 单文件或 `manifest.xnl` | `EagerDataFlow` | 根 `[]` 中五种 DAG node | 唯一 topology 与 node config 真源 |
| flow contract | 根 `()` 内联或 `flow.contract.xnl` | `FlowContract` | 无 entry scheme | 公开 input/output type 与 ports |
| `config` | `config.xnl` | `Config` | `ConfigEntry` / `config://` | 可选静态配置事实 |
| `config.def` | `config.def.xnl` | `ConfigDef` | `ConfigEntryDef` / `config-def://` | 可选 config shape facet |
| `flow.authoring` | 根 `()` 内联或 `flow.authoring.xnl` | `FlowAuthoring` | `NodeLayout` / `flow-authoring://` | layout/viewport；不得复制 topology |

`FlowContract` 在一个 definition 中恰好一个；`FlowAuthoring` 至多一个。它们是根 `()` 的不同唯一子域，不进入 DAG node `[]`。根 metadata、`{}` 配置、`()` 唯一子域与 `[]` 节点列表不得混写。

## Derived Plan

loader/compiler 可以从 definition 派生纯 serializable plan：

```text
EagerDataFlowAuthoringPlan
  contract
  nodes / nodeById
  dataEdges
  waitForEdges
  subflowEdges
  diagnostics
```

`dataEdges` 来自 inputs 的 `flow-port://`；`waitForEdges` 来自 `flow-node://`；`subflowEdges` 来自 SubFlowNode.flow。三者不能被写入额外 authoring 文件，也不能把 dataEdges 与 waitForEdges 合并成丢失来源的单一列表。

## Runtime Facts

| fact | owner | 生命周期 |
|---|---|---|
| invocation input/output | EagerDataFlow caller/runner | 单次调用 |
| node status、ready set、published ports | invocation scheduler | 单次调用，不回写 XNL |
| completion facts、faults、cancellation | invocation scheduler/runtime | 单次调用 |
| child invocation state | target EagerDataFlow runner | SubFlowNode 调用期间隔离 |
| effect state | runtime/effect owner | 由 effect 契约决定，flow 不复制 |

EagerDataFlow 没有持久 snapshot、resume message、signal store 或 seed。若进程中断，是否由调用者重新发起取决于外部幂等策略；definition 本身不承诺 WorkCtrlFlow 式恢复。

## 与 lazy DataGraph 的边界

| EagerDataFlow | lazy signal DataGraph |
|---|---|
| 公开可执行 root，显式调用 | 由 Scope materialize/mount 的长生命周期 graph |
| 固定 invocation input，节点最多运行一次 | Signal/state 变化可 invalidation 并重算 |
| flow-port data edge + flow-node completion edge | module local slot deps 与 reactive subscription |
| Entry/Transform/Sink/SubFlow/Return | Signal/Computed/Processor/Async/Consumer |
| 全 DAG 收敛后终止 | graph object 持续存活 |

两者不共享 root、节点 tag、引用或 runtime state。DataGraph 不能作为 EagerDataFlow 的隐式 input source；需要交互时，由 caller/runtime 显式读取 graph 后形成 flow invocation input，或把 flow output 显式写回 graph。

## Rejected Authoring Facts

`DataFlow` 旧根、DataGraph module/seed/bindings、BehaviorTreePlan、运行期 ready/status/port value 都不是 EagerDataFlow authoring domain。`DataFlow` 只能出现在 removed/rejected 说明中，loader 不提供 alias 或兼容解析。
