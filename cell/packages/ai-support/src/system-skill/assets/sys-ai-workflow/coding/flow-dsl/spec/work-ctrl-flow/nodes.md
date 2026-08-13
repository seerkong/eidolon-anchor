# L3 · WorkCtrlFlow statements 与恢复

> WorkCtrlFlow 继承[共享 CtrlFlow statements](../flow-core/nodes.md)，仅增加 `ExternalJob` 与 `Timer`。持久事实的 owner 见 [WorkCtrlFlow 事实与域](domains.md)。

## `<WorkCtrlFlow>` definition

根 `[]` 与嵌套 body `[]` 都直接保存同一套有序 statements：

```xnl
<WorkCtrlFlow #depa.flows.demo.OrderFulfillment apiVersion="depa.flows/v1" version="1.0.0" [
  <Run #create-pack-job {
    src = "vfs://./flow-code/order.ts#createPackJob"
  }>
  <ExternalJob #await-pack {
    signalKind = "job.completed"
    signalKey = "pack"
    timeoutMs = 86400000
  }>
  <If #route-pack-result (
    <Branches [
      <Branch #completed {
        when = "vfs://./flow-code/order.ts#isCompleted"
      } [
        <Timer #cool-down { durationMs = 60000 }>
        <Return #done { src = "vfs://./flow-code/order.ts#toResult" }>
      ]>
      <Otherwise [
        <Return #not-completed { value = { outcome = "not-completed" } }>
      ]>
    ]>
  )>
]>
```

```ts
export function isCompleted(runtime, input, config) {
  return input.status === 'completed';
}
```

`createPackJob`、`isCompleted`、`toResult` 都遵守 `output = fn(runtime, input, config)`。恢复不会增加第四个参数；ExternalJob payload 通过正常 output 数据链进入 `isCompleted`。

## `<ExternalJob>`

| 字段 | 必填 | 说明 |
|---|---:|---|
| `#id` | 是 | 构成稳定 statement path；在途实例不可无迁移改名 |
| `signalKind` | 是 | 外部消息类别，例如 `"job.completed"` |
| `signalKey` | 是 | 业务关联键；与 kind、path 一起定位 wait |
| `timeoutMs` | 否 | 到期 policy；超时走独立技术 fault 通道 |
| `config` | 否 | 静态 statement config，缺省 `{}` |

首次进入时引擎登记 WaitHandle、保存 snapshot 并返回 suspension。匹配且有效的 ResumeSignal 被消费后，其 payload 成为 ExternalJob output，执行从下一条 statement 继续。payload 中任何业务状态都是 data；只有 ResumeSignal 明确携带的技术 fault 或 timeout policy 才触发 fault。

## `<Timer>`

| 字段 | 必填 | 说明 |
|---|---:|---|
| `#id` | 是 | 构成稳定 statement path |
| `durationMs` | 是 | 非负持久等待时长 |

Timer 首次进入时保存其 input、deadline 与 WaitHandle 并挂起。到期恢复后 output 等于保存的 input，随后执行下一条 statement；Timer 不制造业务结果，也不依赖原进程存活。

## Branch Decision Record

每次 `If` invocation 的 decision key 必须稳定区分 statement path 与循环/重入 occurrence。记录值至少区分具体 `Branch #id`、`Otherwise`、无匹配三种情况，并在进入 body 前与 snapshot 原子持久化。

恢复时若 decision 已存在，执行器直接进入记录的 body 或 no-op，不再次调用已经发生的 predicate。只有尚未发生的 invocation 才求值 `when`，且 predicate 仍严格返回 `boolean = fn(runtime, input, config)`。

## `<StateDef>` / `<StateSeed>`

```xnl
<StateDef #order-fulfillment-state {
  requestId = "string"
  attempt = "number"
}>

<StateSeed #order-fulfillment-state {
  attempt = 0
}>
```

两者同 `#id` 关联。seed 缺少的可选字段以未设置开始；seed 出现 def 未声明字段是校验错误。实例 state 由 runtime 的显式 state effect 读写，不替代 statement input/output 数据链。

## Validation And Rejections

- `ExternalJob` / `Timer` 只能出现在 WorkCtrlFlow 或 BPCtrlFlow definition。
- 可挂起 statement 必须有稳定唯一 `#id`；已有 snapshot 的 path 变化需要显式迁移。
- authoring 中出现 `Tree`、`Sequence`、`Selector`、`Condition`、`action.types` 或 `assignTo` 数据旁路必须拒绝。
- suspension、业务 data 与技术 fault 必须使用不同 runtime 通道；Fallback 只能消费 fault。
