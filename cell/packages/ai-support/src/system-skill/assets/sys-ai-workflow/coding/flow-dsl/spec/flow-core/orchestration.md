# L3 · CtrlFlow 编排原语与产品能力

> loader 的 grammar acceptance 只证明定义合法；节点是否可执行由对应版本的 profile runtime capability 决定。

## 公共语义边界

所有动态节点都遵守同一调用协议：

```text
output = fn(runtime, input, config)
```

- `Run` 是调用 `vfs://...#Export` 脚本的基本叶节点。
- 组合节点只组织子节点；XNL 不承载 TypeScript 表达式、HTTP 请求、状态写入或具体 effect 实现。
- `data`、`fault`、`suspension` 始终三分：业务拒绝是 data，技术错误是 fault，等待是 suspension。
- `Retry`、`Race`、`Timeout` 不能暗中补偿已经完成的 effect；补偿必须由显式流程或 effect/runtime 契约定义。
- predicate、集合选择、转换和实现引用都指向代码 export，DSL 不引入表达式语言。

## 公共原语

| tag | 子域 / 关键字段 | 语义 |
|---|---|---|
| `Run` | `src`, `config` | 调用一个脚本，output 成为下一条 statement 的 input。 |
| `If` | 唯一 `Branches` | 按有序 `Branch.when` 做业务 data 路由；没有匹配时使用 `Otherwise`。 |
| `Require` | `when`, `config` | 技术前置条件为 false 时产生结构化 fault。 |
| `Fallback` | 一个或多个 `Strategy[]` | 只消费技术 fault，按顺序尝试替代策略。 |
| `Retry` | body `[]`, retry policy | 只因可重试 fault 重试子流程；成功后输出子流程 output。 |
| `Timeout` | body `[]`, deadline | 限制子流程时长，取消仍在运行的子操作并产生 timeout fault。 |
| `Until` | `when`, `maxIterations`, body `[]` | 有界循环，predicate 为 true 时退出。 |
| `ForEach` | `when`, iteration policy, body `[]` | 对代码选择的集合逐项编排，支持 sequential 或 bounded-parallel。 |
| `Parallel` | 唯一 `Lanes` / `Lane[]` | 并发分叉并汇合；每个 lane 收到同一份 immutable input，output 按 lane id 聚合。 |
| `Race` | 唯一 `Candidates` / `Candidate[]` | 多候选并发竞争，明确 `first-success` 或 `first-completed`，结束后取消未完成候选。 |
| `CallFlow` | `flow` | 经 FlowContract/registry 解析并调用另一 Flow，得到目标 flow 的 output。 |
| `Return` | `src`、`value` 或当前 input | 结束当前 flow 并产生公开 output。 |

`Require` 比泛化的 `Guard` 更准确：它表达“条件不满足即技术上不能继续”。业务条件不满足时继续使用 `If + Otherwise`，不要把业务拒绝伪装成 fault。

`Parallel` 的 XNL 形态如下；`()` 表示唯一的 `Lanes` 子域：

```xnl
<Parallel #load-context {
  join = "all"
} (
  <Lanes [
    <Lane #profile [
      <Run #load-profile {
        src = "vfs://./scripts/profile.ts#loadProfile"
      }>
    ]>
    <Lane #permissions [
      <Run #load-permissions {
        src = "vfs://./scripts/permission.ts#loadPermissions"
      }>
    ]>
  ]>
)>
```

其 output 是类似 `{ profile: ..., permissions: ... }` 的聚合 data；后续 `Run` 决定怎样组合业务对象。`Race` 使用 `Candidates/Candidate`，不借用 `If` 的 `Branches`。

## 产品能力矩阵

| 能力 | InstantCtrlFlow | WorkCtrlFlow | BPCtrlFlow |
|---|---|---|---|
| `Run` / `If` / `Require` / `Fallback` / `Until` / `Return` | 是 | 是 | 是 |
| `Retry` | 当前 invocation 内的内存期 attempt | 持久 attempt/backoff | 持久 attempt/backoff |
| `Timeout` | 当前调用内 deadline | 持久 deadline，可恢复 | 持久 deadline，可恢复 |
| `Parallel` / `Race` / `ForEach` | 当前调用内并发与取消 | 保存 branch/lane/candidate 状态与结果 | 与 WorkCtrlFlow 相同，用于技术工作 |
| `CallFlow` | 仅同步、不可持久挂起目标 | 可调用 InstantCtrlFlow/EagerDataFlow；持久子 WorkCtrlFlow 需独立生命周期协议 | 与 WorkCtrlFlow 相同，可再扩展子 BPCtrlFlow |
| `Delay` | 可以有，仅当前调用内等待 | 不使用，持久等待使用 `Timer` | 不使用，持久等待使用 `Timer` |
| `ExternalJob` / `Timer` | 否 | 是 | 是 |
| `TaskStep` / `TaskSpace` | 否 | 否 | 是 |
| 人工任务并行/汇合 | 否 | 否 | 归 `TaskGroup.executionMode`，不是 `Parallel` |

关键区别是：`Parallel` 在 InstantCtrlFlow 中只是一次 invocation 内的并发调度；在 WorkCtrlFlow/BPCtrlFlow 中是持久化并发实例模型，必须保存每个 lane 的启动、完成、fault、winner、取消和 deadline 事实。因此三种产品可以共享 DSL tag，但不能共享一套忽略生命周期差异的运行时实现。

## InstantCtrlFlow：一次调用内完成的脚本编排器

InstantCtrlFlow 用于协调多个 `vfs://...#Export` 的读取、校验、转换、聚合和有限并发脚本。它可以编排：

- 并行查询、并行调用 effect、竞争不同数据源。
- 有界重试、请求级超时、批量和集合处理。
- 调用同样无持久化的子 InstantCtrlFlow，或同步调用 EagerDataFlow。
- 从显式 runtime 取得 effect 依赖；脚本不直接绑定 HTTP、数据库或 UI 实现。

InstantCtrlFlow 不承担：

- 重启后仍需恢复的等待、重试或并发任务。
- 人工审批、外部回调和长期计时。
- 隐式共享状态或脚本内偷偷改变流程上下文。
- 自动 Saga 补偿。

InstantCtrlFlow 不拥有 snapshot、WaitHandle、人工任务、外部恢复消息或跨调用实例事实。它只有正常 output 或技术 fault 两种公开完成结果，业务 `refused`、`declined`、`notFound` 等仍是 data。

## WorkCtrlFlow：可恢复的技术编排 actor

WorkCtrlFlow 是长生命周期、可恢复的技术编排器，协调跨进程技术工作：外部消息、Timer、持久重试、deadline，以及可恢复的并发分支。

WorkCtrlFlow runtime snapshot 拥有：

- execution snapshot、当前 statement path 和已发生 branch decision。
- attempt、deadline、lane/candidate outcome、取消请求。
- 已调度唤醒、resume token、已应用恢复消息和 child-flow 生命周期事实。

WorkCtrlFlow 适合订单履约、轮询/对账、文档生成、多系统交接和具备韧性的服务编排。它不建模人工工作语义；可以等待通用外部结果，但任务域属于 BPCtrlFlow。

WorkCtrlFlow 必须把 snapshot、WaitHandle 和恢复消息视为 runtime control facts，绝不回填 definition 或 authoring layout。已记录的 branch decision 在恢复时直接复用，不能因时间、配置或外部数据变化而重新改道。

## BPCtrlFlow：带人工任务事实的业务编排 actor

BPCtrlFlow 在 WorkCtrlFlow 上扩展，面向人、角色、任务组和可审计任务结果均为一等事实的长业务过程。它围绕人工工作编排技术步骤，但不把行为树 failure 滥用为业务决策。

- `TaskSpace`、`TaskGroup` 和 `Task` 拥有分配、聚合、状态和人工工作生命周期。
- `TaskStep` 只把任务域结果桥接回公共 data 链。
- 后续 `If` 路由 `approved`、`refused`、`forwarded`、`abandoned` 等业务 data。
- 人工并行和汇合只属于 `TaskGroup.executionMode`，不与通用 `Parallel` 竞争事实源。

BPCtrlFlow 适合审批、异常处置、运营交接、case management 和需要持久业务审计的过程。非法任务状态迁移、任务存储不可用和恢复协议损坏是技术 fault；等待人工操作是 suspension；人工操作结果是 data。

## FlowContract 与调用

每一种可调用产品都拥有唯一的 `FlowContract` 子域。InstantCtrlFlow、WorkCtrlFlow 和 BPCtrlFlow 的 CtrlFlow contract 声明静态 `input`、`output` 类型引用；WorkCtrlFlow/BPCtrlFlow 额外受 lifecycle capability 约束。FlowContract 不是 runtime validator，也不声明代码实现。

```xnl
<InstantCtrlFlow #depa.demo.CustomerLookup apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #depa.demo.CustomerLookup {
    input = "vfs://./flow-code/customer.types.ts#CustomerLookupInput"
    output = "vfs://./flow-code/customer.types.ts#CustomerLookupOutput"
  }>
) [
  <Run #lookup {
    src = "vfs://./flow-code/customer.ts#lookupCustomer"
  }>
  <Return #result>
]
```

`FlowContract #id` 必须等于产品根 FQN。`CallFlow` 先解析 definition，再解析目标 product form、contract 和允许的 invocation mode；因此 InstantCtrlFlow 不能同步调用一个可能 suspend 的 WorkCtrlFlow。EagerDataFlow 使用端口化 FlowContract，并额外声明 input/output ports。

## Runtime 与 DEPA 边界

```text
canonical XNL definition
  -> loader / validator / profile capability processor
  -> CtrlFlow AST
  -> derived execution plan
  -> profile runtime actor
```

- definition XNL 拥有静态 topology、FlowContract 和 config。
- derived execution plan 是可重建投影，不是新的 authoring 真源。
- InstantCtrlFlow invocation 只拥有临时调度、取消和当前调用事实。
- WorkCtrlFlow/BPCtrlFlow runtime actor 拥有持久 snapshot、deadline、attempt、branch decision、lane/candidate state 和 resume message。
- TaskSpace 拥有人工任务事实；业务结果作为 data 进入后续 predicate。
- 动态代码通过显式 runtime 取得依赖，不成为 topology 或持久状态的第二 owner。

`Retry`、`Timeout`、`Parallel` 和 `Race` 负责 control、fault、cancellation facts。只要 runtime actor 需要跨边界等待、取消确认或恢复，就通过显式 message/port；同步 `Run` 不伪装成 actor。

## 规范约束

该矩阵和边界由 loader、compiler、runtime、examples 与 tests 共同验证。合法 definition 仍可能因为当前 runtime capability 不可用而得到 `runtime-capability-unavailable`；实现不得静默降级成其他 profile 或节点语义。
