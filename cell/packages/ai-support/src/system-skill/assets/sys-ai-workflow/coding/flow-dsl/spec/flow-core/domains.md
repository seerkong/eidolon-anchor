# L3 · flow-core 事实与域

> CtrlFlow statements 直接属于产品 definition，不是一个独立文件域。domain/file/root tag 与 entry scheme 按 M-N2 分投影，所有 scheme 必须在本页或 profile 规范中显式登记。

## Authoring Facts

| owner | file / projection | root | entries | entry scheme | 语义 |
|---|---|---|---|---|---|
| flow definition | 单文件或 `manifest.xnl` | `InstantCtrlFlow` / `WorkCtrlFlow` / `BPCtrlFlow` | 根 `[]` 中的 statements | 无 | 唯一 topology 与 node config 真源 |
| flow contract | 根 `()` 内联或 `flow.contract.xnl` | `FlowContract` | 无 | 产品 flow scheme | 静态 input/output 类型与可调用边界 |
| `config` | `config.xnl` | `Config` | `ConfigEntry` | `config://` | 静态开关、枚举、常量预设 |
| `config.def` | `config.def.xnl` | `ConfigDef` | `ConfigEntryDef` | `config-def://` | config shape facet |
| `flow.authoring` | `flow.authoring.xnl` | `FlowAuthoring` | `NodeLayout` | `flow-authoring://` | layout/viewport；不得复制语义定义 |

CtrlFlow 只命名共享 statement grammar、canonical AST 和 editor adapter，不形成可独立加载的 definition unit。

## Derived And Runtime Facts

| fact | owner | persistence rule |
|---|---|---|
| canonical FlowSpec / CtrlFlow AST | parser/compiler | 可从 XNL definition 重建；不是第二份 authoring 文件 |
| BehaviorTreePlan | compiler | 内部派生执行计划；不得被 loader 当作公开 definition |
| WorkCtrlFlow snapshot | WorkCtrlFlow/BPCtrlFlow runtime | 运行实例状态；不得回写 definition |
| TaskSpace facts | BPCtrlFlow task store | 人工任务事实源；结果以 data 进入 flow |
| runtime overlay | editor/runtime adapter | 只读投影；不得覆盖 definition 或 FlowAuthoring |

## Loader Validation

1. definition 根 tag 必须是公开产品根，`#id` 必须是 FQN；`apiVersion` / `version` 必须位于 metadata 段。
2. 根 `[]` 直接包含 profile 允许的 statements；根包装或第二份 topology 是错误。
3. 每个 definition 恰有一个 `FlowContract`，且其 `#id` 等于根 FQN。
4. statement `#id` 在 definition 内唯一；`If` 恰有一个 `Branches` 子域，`Otherwise` 最多一个且必须末尾。
5. 所有 code ref 必须是带 export fragment 的 `vfs://...#Export`；XNL 中的函数或表达式字符串是错误。
6. `config://` 与 `config-def://` 只在当前 bundle 内解析，目标 entry 必须存在。
7. profile capability 由[编排原语与产品能力](orchestration.md)收窄；grammar 合法不代表当前 runtime 已实现。

## Rejected Public Domains

旧结构根、公开行为树控制节点和动作类型目录不属于 authoring domain。实现若需要行为树节点种类，只能在编译出的内部 BehaviorTreePlan 中表达。
