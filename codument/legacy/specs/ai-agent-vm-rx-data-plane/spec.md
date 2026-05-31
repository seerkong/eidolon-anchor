## ADDED Requirements

### Requirement: VM 必须提供 public/private RxData 字段
系统必须在 `AiAgentVm` 中提供内部可写和外部只读的响应式数据面字段。

#### Scenario: 初始化 VM rx data
- **GIVEN** `createVM` 创建了 `AiAgentVm`
- **WHEN** runtime rx data 被初始化
- **THEN** 系统必须创建 private rx data
- **AND** 系统必须创建从 private 派生的 public rx data
- **AND** 两者必须挂载在 VM 标准字段下

#### Scenario: 替换 contract 占位类型
- **GIVEN** `ai-core-contract/src/runtime/AiAgentVm.ts` 中存在 rx data seam
- **WHEN** 本 Track 实现 RxData 契约
- **THEN** `AiAgentVmPrivateRxData` 不得继续是 `null`
- **AND** `AiAgentVmPublicRxData` 不得继续是 `null`
- **AND** contract 类型不得 import `@depa-data-graph/core` 实现类

### Requirement: Contract 与 Logic 必须保持分层
RxData 的 shape 必须在 `ai-core-contract` 中定义，depa-data-graph backed 实现与 lifecycle ops 必须在 `ai-core-logic` 中定义。

#### Scenario: contract 只暴露协议面
- **GIVEN** 下游包 import `@cell/ai-core-contract/runtime/AiAgentVm`
- **WHEN** 读取 `AiAgentVmPublicRxData` 或 `AiAgentVmPrivateRxData`
- **THEN** 只能看到 stream/signal 的读写协议类型
- **AND** 不需要依赖 depa-data-graph 的具体 class

#### Scenario: logic 创建具体 runtime rx data
- **GIVEN** `createVM` 已创建 VM 且 rx seam 初始为空
- **WHEN** `ensureVmRxData` 或等价 logic op 被调用
- **THEN** `ai-core-logic` 必须创建 depa-data-graph backed private/public RxData
- **AND** 必须写回 `vm.privateRxData`、`vm.publicRxData`、`vm.privateRxBinding`、`vm.publicRxBinding`

### Requirement: stream 与 signal 必须分离
事件序列必须用 stream/timeline/log 表达，当前状态必须用 signal/projection 表达。

#### Scenario: semantic events 是 stream
- **GIVEN** actor runtime 发出 semantic event
- **WHEN** public rx data 消费该事件
- **THEN** 事件必须通过 semantic event stream 暴露
- **AND** 不得把它写入 usage/busy 等 signal 字段

#### Scenario: usage 是 signal
- **GIVEN** LLM driver 或 runtime 更新 token usage
- **WHEN** public rx data 暴露 usage
- **THEN** usage 必须作为 readonly signal 或 signal projection 暴露
- **AND** 不得通过伪造 semantic event 注入 usage 状态

### Requirement: Core 层不得强依赖 organ conversation domain runtime
conversation domain streams 属于外层 AI/organ 领域 runtime，core RxData 初始化不得直接 import `ai-organ-logic`。

#### Scenario: 初始化 core rx data 时没有 conversation domain runtime
- **GIVEN** VM 只由 `ai-core-logic` 创建
- **WHEN** 初始化 RxData
- **THEN** semantic event stream 和 core signals 必须可用
- **AND** history/prompt/session domain streams 可以为空或等待外层 binding 注入
- **AND** `ai-core-logic` 不得 import `ai-organ-logic`

#### Scenario: organ 层绑定 conversation domain streams
- **GIVEN** organ 层已创建 conversation domain runtime
- **WHEN** 外层调用 conversation domain rx binding
- **THEN** history/prompt/session domain events 可以接入 VM private rx data
- **AND** 该 binding 必须可释放且幂等

### Requirement: lifecycle binding 必须可释放且幂等
所有把 eventBus、conversation domain runtime 或 signals 接入 RxData 的订阅必须由 binding 管理。

#### Scenario: request/runtime 释放
- **GIVEN** VM rx data 已经绑定来源 stream
- **WHEN** runtime 或请求生命周期结束
- **THEN** binding 必须释放 subscriptions
- **AND** 重复释放不得抛错或产生重复副作用
