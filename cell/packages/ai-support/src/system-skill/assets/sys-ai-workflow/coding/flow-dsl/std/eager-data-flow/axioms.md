# L2 · EagerDataFlow 公理

> EagerDataFlow 是一次调用内主动求值的 DAG 产品。它与 CtrlFlow 的有序 statement 语义、前端 DataGraph 的长生命周期 lazy signal 语义彼此独立。

## EDF-1 · 公开根唯一命名为 EagerDataFlow

可执行 definition 的根是 `<EagerDataFlow>`。根 `[]` 直接保存 DAG nodes；`()` 只保存每种 tag 最多一个的唯一子域，例如 `FlowContract` 或 `FlowAuthoring`。`<DataFlow>` 是已移除的旧根，loader 必须拒绝，不能把它当作 alias。

## EDF-2 · FlowContract 封闭调用边界

每个 EagerDataFlow 有且只有一个 `FlowContract`。它声明公开 input/output type 和端口名；唯一 `EntryNode` 从 input ports 暴露调用输入，唯一 `ReturnNode` 用与 output ports 完全相同的 key 组装调用输出。

调用者不能穿透 flow 内部节点。跨 flow 组合只能通过 `SubFlowNode`，其 inputs 和 outputs 分别由目标 `FlowContract` 的 inputPorts 和 outputPorts 派生。

## EDF-3 · 数据边与完成边是两类事实

`inputs` 中的 `flow-port://#node/port` 产生 data edge；`waitFor` 中的 `flow-node://#node` 产生 completion edge。两类边必须分别保存在 authoring plan 中，并共同参加拓扑无环校验。

即使相同两个节点之间已有 data edge，显式 completion edge 仍然保留。它表达作者要求的完成依赖，不能被编译器归一化、去重或改写成隐式顺序。

## EDF-4 · Eager 表示一次调用内主动收敛

每次 flow invocation 都创建独立运行态；每个节点最多执行一次。节点在全部 input port 已有值且全部 waitFor 目标成功完成后 ready。调度器必须尽快启动所有 ready 节点，因此互不依赖的 ready 节点可以并发运行；根 `[]` 的声明顺序只提供稳定 identity 和诊断顺序，不是执行顺序。

一次调用成功要求所有已定义节点成功完成，并由 ReturnNode 产生公开 output。作者若要求两个副作用的先后顺序，必须声明 data edge 或 waitFor edge，不能依赖数组顺序或运行时碰巧的完成顺序。

## EDF-5 · 端口是不可变的单次赋值数据

节点 output port 在本次 invocation 中只写一次。下游通过具名 input key 读取上游 port；读取视图不可变，节点不能回写上游数据。EntryNode 与 SubFlowNode 的 outputs 来自 FlowContract，TransformNode 显式声明 outputs，SinkNode 和 ReturnNode 不暴露内部 output port。

## EDF-6 · 动态代码遵守 DEPA 四边界

TransformNode 和 SinkNode 的实现统一遵守：

```text
output = fn(runtime, input, config)
```

`runtime` 显式提供长生命周期依赖和 effect；`input` 是按节点 inputs key 组装的只读 record；`config` 是节点静态 map；TransformNode 的 `output` 是与声明 outputs 完全匹配的 record，SinkNode 的 `output` 是 `void`。代码可以异步，调度器必须 await 后才发布 ports 或 completion fact。

## EDF-7 · 技术失败沿 DAG 失败通道传播

节点 throw、fault、缺失 output port、subflow fault 或协议不匹配都会使整个 invocation 技术失败。失败节点不发布 output port，也不发布成功 completion fact；其下游不会 ready。调度器停止启动尚未开始的节点，并向已运行节点传播取消信号；已发生的外部副作用不承诺自动回滚。

业务值始终是普通 port data，不会因为字段名或枚举值自动变成失败。并发节点产生多个 fault 时，runtime 可以保留全部 cause，但对外必须给出稳定的 primary fault 和失败节点 identity。

## EDF-8 · SubFlow 是封闭的嵌套 invocation

SubFlowNode 用 `eager-data-flow://<FQN>` 调用另一个 EagerDataFlow。子流拥有独立节点运行态，只接收映射后的 contract input，只返回 contract output；父流的 `flow-port://`、`flow-node://` 不能穿透边界。

SubFlowNode 只有在子流整体成功时才发布 outputs 和 completion fact。子流技术失败作为该 SubFlowNode 的 fault 向父 DAG 传播。unit 级 subflow 调用图也必须无环；递归不能通过直接或间接 SubFlowNode 表达。

## EDF-9 · EagerDataFlow 不是 lazy signal DataGraph

EagerDataFlow 由显式调用触发，读取固定 invocation input，节点单次执行并终止；它没有 signal state、invalidation、subscription、seed 或因依赖变化而重算的语义。

DataGraph 是被 Scope 装配的长生命周期 reactive runtime，依赖变化可以触发 lazy/增量求值。DataGraph 的 SignalNode、ComputedNode、ProcessorNode、AsyncNode、ConsumerNode 以及 local slot refs 都不属于 EagerDataFlow；EagerDataFlow 的 EntryNode、TransformNode、SinkNode、SubFlowNode、ReturnNode、flow-port 和 waitFor 也不属于 DataGraph。
