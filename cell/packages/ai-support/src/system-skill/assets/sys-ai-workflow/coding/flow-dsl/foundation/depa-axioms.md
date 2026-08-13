# L1 元公理 · DEPA 封装

> 与领域无关的封装范式，源自 DEPA 理论。任何 DSL 描述"一段被封装的逻辑"时都遵守。编号 `M-D*`（Meta-DEPA）。
> **L1 只定原则**；四边界具体绑定到哪些节点、type 词汇如何落地，由领域层（L2）定映射。

## M-D1 · 封装必有四边界

只要是封装模式，在 core logic 之外**必有 input / output / config / runtime 四个概念**；缺少任一个，职责就会混杂、软件逐步失控。核心公式：

```text
output = fn(runtime, input, config)
```

- `runtime` — 长生命周期依赖、共享/跨步骤状态、副作用契约；**显式注入**，不靠隐式全局。
- `input` — 单次调用的请求载荷。
- `config` — 单次调用的静态配置（枚举标识 + 静态策略），不放函数对象、不重复 runtime。
- `fn` — 纯逻辑，依赖全部来自三个参数。

DSL 在描述任何封装单元时，都应能把这四个概念**分别指认出来**，而不是糊成一个大对象。

## M-D2 · Adapter 是边界间的纯函数转换

一段封装从外层边界进、到 core、再回外层，是一条处理器链：

```text
outer{runtime·input·config} → derived → inner{runtime·input·config} → core_logic → inner output → outer output
```

链上每个处理器是一个 **Adapter**——一个 `run(runtime, input, config) -> output` 的纯函数转换。Adapter 的 `type` 取自这条链的**封闭词汇表**：`derived | runtime | input | config | core | output`。不允许自由命名的"阶段/插槽"——那会让四边界退化成任意管线。

Adapter 无独立身份：它的身份 = **挂载点 + 边界 type**。复用的单位是脚本文件（M-D3），不是一个被注册的"adapter 对象"。不需要转换的边界用显式 identity，不压扁阶段概念。

## M-D3 · 可执行逻辑经引用挂接，声明层禁函数

canonical DSL 是纯声明式：**禁止函数、闭包、回调、构造器**出现在 XNL 里。一切可执行逻辑（Adapter 脚本、处理器实现）以**外部脚本文件**存在，经 `src="vfs://…"` 引用挂接（M-N4 物理寻址）。加载器只解析、校验引用，**不执行**脚本；执行属于 runtime 层。

推论：DSL 里出现的永远是"契约描述 + 对实现的引用"，从不是实现本身。这保证制品可序列化、可 diff、可静态校验。

## M-D4 · seed 是启动快照，不是活状态

初始数据（`X.seed`，见 M-N3）只作为**启动 checkpoint**，只读。运行期的活状态由 runtime owner 持有、经事件/命令更新——绝不把 live state 写回 seed。这条把"初值声明"与"运行时状态"两个事实源彻底分开。
