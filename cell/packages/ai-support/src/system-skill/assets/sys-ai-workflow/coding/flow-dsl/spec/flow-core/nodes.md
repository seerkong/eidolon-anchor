# L3 · flow-core statements

> 本页定义 InstantCtrlFlow、WorkCtrlFlow、BPCtrlFlow 共享的公开 CtrlFlow authoring grammar。产品扩展 statement 见各 `spec/<profile>/nodes.md`。

## 根与有序语句

三个产品根都是可执行 definition。它们的 `[]` 直接保存 statements，按声明顺序执行；嵌套 body 的 `[]` 遵守同一规则。

```xnl
<WorkCtrlFlow #depa.flows.demo.OrderRouting apiVersion="depa.flows/v1" version="1.0.0" [
  <Run #load-order {
    src = "vfs://./flow-code/order.ts#loadOrder"
  }>
  <Return #result {
    src = "vfs://./flow-code/order.ts#toResult"
  }>
]>
```

根 `#id` 必须是 FQN；`apiVersion`、`version` 位于 metadata 段；标题等业务描述位于 `{}`。根 `[]` 不允许额外的结构包装。

## 值传递

CtrlFlow statement 组成一条显式数据链：flow 调用输入是根 `[]` 第一条 statement 的 `input`；普通 statement 的 `output` 是下一条 statement 的 `input`。嵌套 body 也遵守同一规则。

- `Run` output 替换当前值。
- `If` predicate 读取当前值；被选 Branch body 的最终 output 成为 `If` output；无匹配且无 Otherwise 时原值原样通过。
- `Fallback` 的每个 Strategy 从同一份进入 Fallback 的 input 开始；首个成功 strategy 的最终 output 成为 Fallback output。
- `Until` 每轮 body 的最终 output 成为下一次 predicate 的 input。
- 动态代码不得修改 `input`；新数据必须通过函数 output 返回。
- 节点的 `config` 属性是传给代码的静态配置，缺省为 `{}`；`src`、`when` 等结构字段不混入 config。

## `Run`

`Run` 调用一个代码入口。`src` 必填；函数 output 直接成为下一条 statement 的 input。

```xnl
<Run #load-quote {
  src = "vfs://./flow-code/quote.ts#loadQuote"
  config = { currency = "TRY" includeTax = true }
}>
```

```ts
export async function loadQuote(runtime, input, config) {
  return runtime.callEffect('pricing.quote', input, config);
}
```

函数正常返回表示 statement 技术成功，返回值可以是任意 data；抛出或返回 runtime 定义的 fault 表示技术失败。业务值如 `refused`、`notFound`、`declined` 仍是正常 output，不得自动转成技术失败。

## `If` / `Branches` / `Branch` / `Otherwise`

`If` 在唯一的 `()` 子域中拥有一个 `Branches`；`Branches[]` 包含一个或多个有序 `Branch`，以及最多一个 `Otherwise`。`Otherwise` 若存在必须是最后一项。

```xnl
<If #route-quote (
  <Branches [
    <Branch #manual-review {
      when = "vfs://./flow-code/quote.ts#needsManualReview"
      config = { threshold = 5000 }
    } [
      <Run #create-review {
        src = "vfs://./flow-code/quote.ts#createReview"
      }>
      <Return #review-result {
        src = "vfs://./flow-code/quote.ts#reviewResult"
      }>
    ]>
    <Branch #accepted {
      when = "vfs://./flow-code/quote.ts#isAccepted"
    } [
      <Return #accepted-result {
        src = "vfs://./flow-code/quote.ts#acceptedResult"
      }>
    ]>
    <Otherwise [
      <Return #rejected-result {
        src = "vfs://./flow-code/quote.ts#rejectedResult"
      }>
    ]>
  ]>
)>
```

```ts
export function needsManualReview(runtime, input, config) {
  return input.total >= config.threshold;
}

export function isAccepted(runtime, input, config) {
  return input.decision === 'accepted';
}
```

执行规则：

1. 按声明顺序调用 `Branch.when` predicate。
2. predicate 必须按 `boolean = fn(runtime, input, config)` 返回 boolean；非 boolean 是协议错误。
3. 选择第一个返回 `true` 的 Branch，只执行其 `[]` body，后续 Branch 不再求值。
4. 全部为 `false` 时执行可选 `Otherwise[]`；没有 `Otherwise` 时 `If` 是 no-op，继续根或外层 body 的下一条 statement。
5. predicate 的技术失败直接使 `If` 技术失败；它不是 `false`。

WorkCtrlFlow/BPCtrlFlow 在完成选择后必须记录 branch decision；恢复时复用已发生决策，不重新求值改变路径。

## `Fallback`

`Fallback[]` 保存按优先级排列的 strategy。每个 `Strategy[]` 是有序 statements；执行器选择第一个**技术成功**的 strategy。

```xnl
<Fallback #load-customer [
  <Strategy #primary [
    <Run #load-primary {
      src = "vfs://./flow-code/customer.ts#loadPrimary"
    }>
  ]>
  <Strategy #replica [
    <Run #load-replica {
      src = "vfs://./flow-code/customer.ts#loadReplica"
    }>
  ]>
  <Strategy #cached [
    <Run #load-cache {
      src = "vfs://./flow-code/customer.ts#loadCached"
    }>
  ]>
]>
```

- strategy 内全部 statements 技术成功时，Fallback 成功并继续外层下一条 statement。
- strategy 出现技术失败时，丢弃该 strategy 的临时输出，并以进入 Fallback 时的原 input 尝试下一项；外部副作用是否可回滚由 runtime/effect 事务契约决定，Fallback 不承诺补偿。
- 全部 strategy 技术失败时，Fallback 向外传播聚合 fault。
- 任意正常业务 output 都算技术成功，即使值是 `refused` 或 `notFound`；业务路由必须在后续 `If` 中表达。
- strategy 内的 `Return` 仍立即结束整个 flow，不只是结束该 strategy。

## `Until`

`Until.when` 是退出 predicate code ref；`Until[]` 是每轮按序执行的 statements。每轮开始前先求值 predicate，因此初始即为 `true` 时 body 执行零次。

```xnl
<Until #await-ready {
  when = "vfs://./flow-code/job.ts#isReady"
  maxIterations = 20
  config = { expectedStatus = "ready" }
} [
  <Run #poll {
    src = "vfs://./flow-code/job.ts#poll"
  }>
]>
```

```ts
export function isReady(runtime, input, config) {
  return input?.status === config.expectedStatus;
}
```

predicate 返回 `false` 时执行一轮 body 后再次检查；返回 `true` 时继续外层下一条 statement。predicate 或 body 的技术失败向外传播；`maxIterations` 超限产生技术 fault，防止定义导致无界同步循环。

## `Return`

`Return` 立即终止整个 flow 并产生公开 output。它可以使用 `value` 或 `src` 之一；两者都省略时返回当前 input：

```xnl
<Return #literal-result {
  value = { status = "accepted" }
}>
```

```xnl
<Return #computed-result {
  src = "vfs://./flow-code/quote.ts#toResult"
  config = { includeAudit = true }
}>
```

```ts
export function toResult(runtime, input, config) {
  return {
    quote: input,
    includeAudit: config.includeAudit,
  };
}
```

`Return.src` 使用普通动态代码协议；其 output 就是 flow output。`Return.value` 是不调用代码的字面量 output；无 `src`/`value` 时当前 input 就是 flow output。`Return` 之后同一 body 中的 statements 不执行。

## 动态代码协议

所有 `src` / `when` 引用的 export 都遵守：

```text
output = fn(runtime, input, config)
```

| 参数 | owner | 约束 |
|---|---|---|
| `runtime` | profile engine | 显式注入长生命周期依赖、effect 契约和必要的实例能力；代码不得读隐式全局。 |
| `input` | statement runner | 当前不可变数据视图；predicate 与普通代码收到同一份形态。 |
| `config` | definition node | 节点声明的静态 `config` map；不得包含函数或复制 runtime。 |
| `output` | code export | 普通 data；predicate 限定为 boolean；技术失败通过 fault 通道表达。 |

代码可同步或异步返回；runner 必须 await 后再推进下一条 statement。XNL 只保存 `vfs://...#Export`，不内嵌函数、表达式字符串、闭包或 handler object。
