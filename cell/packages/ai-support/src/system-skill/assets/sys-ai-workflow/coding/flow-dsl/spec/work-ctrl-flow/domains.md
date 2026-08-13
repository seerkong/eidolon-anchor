# L3 · WorkCtrlFlow 事实与域

> 公共 definition/config/layout 见 [flow-core 事实与域](../flow-core/domains.md)。WorkCtrlFlow 只增加持久实例 state facet；snapshot 和 WaitHandle 是 runtime facts，不是 authoring topology。

## Authoring Facts

| fact / domain | file | root / scheme | 说明 |
|---|---|---|---|
| `<WorkCtrlFlow>` definition | 单文件或 `manifest.xnl` | 根 `[]` | 共享 CtrlFlow statements，可使用 `ExternalJob` / `Timer` |
| `state.def` | `state.def.xnl` | `<StateDef>` / `state-def://` | 可选；声明受版本契约保护的实例 state shape |
| `state.seed` | `state.seed.xnl` | `<StateSeed>` / `state-seed://` | 可选；新实例的只读初始 state |
| `task.space` | - | - | 禁用；人工任务事实只属于 BPCtrlFlow |

`StateDef` 与 `StateSeed` 通过相同 `#id` 关联。seed 只用于创建新实例，运行期 state 只写 snapshot/store，绝不回写 definition 或 seed。动态代码若访问实例 state，必须经 `runtime` 显式提供的 state effect，函数签名仍是 `output = fn(runtime, input, config)`。

## Runtime Facts

| fact | owner | 持久化约束 |
|---|---|---|
| snapshot | WorkCtrlFlow instance store | 保存恢复位置、当前 data、state、decisions、等待与幂等事实 |
| WaitHandle | snapshot/instance store | 以 statement path + token 定位 open/closed wait |
| ResumeSignal | runtime ingress | 消费后只记录标识与 payload/fault 结果，不进入 definition |
| branch decision | snapshot | 在进入 Branch body 前记录，恢复时复用 |

实例物化可以冻结 definition bundle 以保证 code 与 topology 版本稳定，但冻结副本仍不是新的 authoring 入口。运行状态可以投影到 editor/runtime overlay；不得向 XNL definition 注入 `status`、执行游标或 decision 作为语义事实。

## Rejected Authoring Facts

`tree.xnl`、`action.types.xnl`、`Tree` 根、独立 `CtrlFlow` 根以及公开 `Sequence` / `Selector` / `Condition` 都必须拒绝。snapshot schema、WaitHandle 列表和 branch decision 也不能被伪装成 definition 子域。
