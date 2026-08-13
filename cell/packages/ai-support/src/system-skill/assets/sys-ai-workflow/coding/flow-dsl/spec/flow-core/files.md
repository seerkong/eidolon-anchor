# L3 · flow-core 文件组织

## 单文件 bundle

小型 flow 可以由一个 XNL 文件承载完整 definition；文件名只参与布局，根 tag 与 `#id` 才决定产品类别和身份。

```text
flows/
  price-quote.xnl       # <InstantCtrlFlow #depa.flows.demo.PriceQuote [...]>
  flow-code/
    quote.ts
```

产品根的 `[]` 直接保存 CtrlFlow statements。唯一子域才进入 `()`；不得用额外根节点包装 statements。

## 目录 bundle

复杂 flow 使用目录 unit：

```text
flows/order-routing/
  manifest.xnl          # <WorkCtrlFlow #depa.flows.demo.OrderRouting [...]>
  flow.contract.xnl     # 可选外提；逻辑上仍是必需且唯一的 FlowContract
  config.xnl            # 可选静态 config 域
  config.def.xnl        # 可选 config shape facet
  flow.authoring.xnl    # 可选布局事实，不复制 statements
  flow-code/
    order.types.ts
    order.ts
```

profile 可以增加自己的状态或任务文件，见对应 `spec/<profile>/domains.md`。公共语言不通过独立结构文件或类型目录定义 statements；节点 tag、字段和就地 code ref 已经构成完整 authoring 事实。

## 单/多文件边界

- `manifest.xnl` 是目录 bundle 的唯一入口；根 tag ∈ {`InstantCtrlFlow`, `WorkCtrlFlow`, `BPCtrlFlow`}。
- 根 `[]` 的 statement topology 始终由入口 definition 持有。
- 每个 definition 必须恰有一个 `FlowContract`；可内联，也可外提为 `flow.contract.xnl`，不能两处同时声明。
- 根 `()` 中的唯一子域可以按 M-S4 外提为同型域文件；外提不改变逻辑 URI。
- `vfs://./...` 相对 bundle 根解析，单文件和目录形态保持一致。
- code export 只存在于 `.ts` 等脚本文件；XNL 只保存 `vfs://...#Export` 引用。
- `flow.authoring.xnl` 只保存 layout/viewport，不得复制 statement topology、node config 或运行状态。

## Removed File Shapes

以下旧文件形态是校验错误，不是兼容入口：

- `tree.xnl` 或内联 `Tree` 结构域。
- `action.types.xnl` 或内联 `ActionTypes` 类型目录。
- 以独立可执行 `CtrlFlow` 根保存三种产品共有语句。
