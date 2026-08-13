# L3 · flow-core 引用与代码协议

> URI 总规则见 M-N4；本页只登记公共 CtrlFlow grammar 使用的 scheme 和 code ref 字段。

## 引用一览

| scheme | target | public fields | example |
|---|---|---|---|
| `vfs://` | bundle 内/工作区文件与 export | `Run.src`, `Branch.when`, `Until.when`, `Return.src` | `"vfs://./flow-code/quote.ts#isAccepted"` |
| `config://` | 当前 bundle 的 `ConfigEntry` 或其 sub-path | profile/node config binding | `"config://#pricing/currency"` |
| `config-def://` | 当前 bundle 的 `ConfigEntryDef` | schema/tooling 引用 | `"config-def://#pricing"` |
| `flow-authoring://` | 当前 bundle 的 layout entry | editor projection | `"flow-authoring://#route-quote"` |
| `instant-ctrl-flow://` | InstantCtrlFlow definition / contract | `CallFlow.flow` | `"instant-ctrl-flow://depa.flows.CustomerLookup"` |
| `work-ctrl-flow://` | WorkCtrlFlow definition / contract | `CallFlow.flow` | `"work-ctrl-flow://depa.flows.OrderFulfillment"` |
| `bp-ctrl-flow://` | BPCtrlFlow definition / contract | `CallFlow.flow` | `"bp-ctrl-flow://depa.flows.ExpenseApproval"` |

profile 可登记额外 scheme，例如 BPCtrlFlow 的 task entry；未在 flow-core 或 profile 表中登记的 scheme 不得凭名称推导。

## Code Ref

动态逻辑统一使用：

```text
vfs://<file-path>#<export-name>
```

- `./` 相对当前 bundle 根，`@/` 相对工作区根。
- export fragment 必填；只指向文件而没有 `#Export` 是无效 code ref。
- code ref 属于引用它的 statement，直接写在该节点字段上；不经过类型目录或第二次注册。
- loader 只解析并校验引用；module load、执行和 fault 归一化属于 runtime effect。

```xnl
<Run #load {
  src = "vfs://./flow-code/order.ts#loadOrder"
  config = { includeHistory = true }
}>

<Branch #approved {
  when = "vfs://./flow-code/order.ts#isApproved"
} [
  <Return #result {
    src = "vfs://./flow-code/order.ts#approvedResult"
  }>
]>
```

## Function Contract

每个 code ref 的 export 都遵守同一协议：

```ts
type FlowCode<Runtime, Input, Config, Output> = (
  runtime: Runtime,
  input: Readonly<Input>,
  config: Readonly<Config>,
) => Output | Promise<Output>;
```

等价关系是：

```text
output = fn(runtime, input, config)
```

- `runtime` 由 profile engine 显式注入，承载长生命周期依赖和 effect 契约。
- `input` 是不可变的当前值：根从 flow 调用输入开始，之后由上一条 statement 的 output 传入。
- `config` 来自 statement 的静态 `config` map，缺省 `{}`。
- 普通代码 output 是 data；predicate code output 必须是 boolean。
- 技术失败通过 throw/fault 通道表达，不能用业务 data 值伪装。

XNL 中禁止函数体、闭包、handler object 和 JavaScript `expr` 字符串。实现不能依赖隐式全局、单例或 `this` 来补充函数签名之外的依赖。

## 解析边界

- 逻辑 scheme 只在当前 bundle 内解析，不跨 definition 搜索同名 entry。
- 跨 bundle 代码复用通过显式 `vfs://` 引用；跨 flow 调用须由对应产品节点和注册 scheme 定义，不能把另一个 manifest 当脚本执行。
- 所有 URI 都必须写在引号字符串中。
- `flow-authoring://` 只能解析布局事实，不能用于读取 statement config 或 runtime state。
