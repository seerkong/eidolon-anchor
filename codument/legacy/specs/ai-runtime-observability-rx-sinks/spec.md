# 规范：AI runtime 响应式可观测 sinks 与扩展事实

## 概述

AI runtime 提供响应式可观测能力。系统在 VM private/public RxData 中提供专属 observability stream：所有可观测事实写入 private rx data，所有 sinks/consumers 通过 public rx data 只读消费。可观测失败不得影响用户协议输出。

`AiAgentVm`、runtime ctx、snapshot、registry data 与 rx seam 位于 `ai-core-contract`，具体逻辑位于 `ai-core-logic` / organ 层。`ensureVmRxData(vm)` 提供 public readonly 面：`semanticEvents`、domain streams、`usage`、`traceSummary` 与 observability stream。`createSemanticProtocolBinding(vm)` 从 public RxData 派生 shared `SemanticProtocolFrame`，属于用户协议投影层，不是可观测事实写入主路径。

Observability 使用专属标准 stream：semantic events 可以被桥接为 observability records，但 provider capture、extension facts、runtime lifecycle 等非 semantic 来源也必须能够通过受控 helper 写入同一标准 observability stream。usage、traceSummary 等 signals 继续留在常规 public/private RxData 中，不作为 observability 专属 signal 重复建模。

## Requirements

### Requirement: Runtime 必须提供专属 observability Rx stream
系统必须在 VM private/public RxData 中提供标准化 observability stream。

#### Scenario: 创建 ObservabilityRxData
- **GIVEN** VM 已通过 `ensureVmRxData(vm)` 初始化 rx data
- **WHEN** 请求入口初始化可观测绑定
- **THEN** `vm.privateRxData` 必须提供可写 observability stream
- **AND** `vm.publicRxData` 必须提供对应只读 observability stream
- **AND** ObservabilityRxData/sinks 必须从 public observability stream 消费 records/errors
- **AND** usage、traceSummary 等 signals 继续从常规 public rx data 字段读取，不迁入 observability 专属 signal

#### Scenario: 写入统一走 private observability stream
- **GIVEN** semantic bridge、provider capture、extension helper 或 runtime lifecycle 需要产生可观测事实
- **WHEN** 它们写入可观测数据面
- **THEN** 必须写入 `vm.privateRxData` 的 observability stream
- **AND** 写入 payload 必须符合标准 ObservabilityRecord/Fact envelope
- **AND** 不得让 sink 持有 private writer

#### Scenario: 多来源可观测事实标准化
- **GIVEN** 可观测事实可能来自 semantic events、domain events、provider scene capture、extension facts 或 runtime lifecycle
- **WHEN** 任意来源投递到 observability stream
- **THEN** 必须转换为统一 observability 标准 record
- **AND** sink 不需要知道原始来源的私有结构

### Requirement: Sink 失败必须隔离
可观测 sink 的失败不得中断用户协议输出或 actor 执行。

#### Scenario: 一个 sink 绑定失败
- **GIVEN** log sink、trace artifact sink 与一个失败 sink 同时绑定
- **WHEN** 失败 sink 抛出异常
- **THEN** 其他 sink 仍可继续绑定或消费
- **AND** 用户协议 pipeline 继续创建

#### Scenario: sink 消费失败
- **GIVEN** ObservabilityRxData 已创建且用户协议 binding 也已创建
- **WHEN** 某个 sink 在 record handler 中抛出异常
- **THEN** sink binding 必须捕获并隔离该异常
- **AND** 其他 sink 与 semantic protocol binding 仍继续消费后续 frames

### Requirement: 扩展事实必须受控写入
系统必须提供 extension fact envelope 和 helper，使扩展能写入事实但不能拿到任意 private writer。

#### Scenario: 工具扩展发出自定义 API 调用事实
- **GIVEN** 扩展工具执行自定义 API 调用
- **WHEN** 调用 start/end/error 发生
- **THEN** 扩展必须能通过受控 helper 发出 extension fact
- **AND** 该 fact 可被 observability sink 消费
- **AND** 首期不要求该 fact 进入 `SemanticEvent` union
- **AND** 后续如需用户协议展示，应通过单独协议扩展把 observability fact 转为 protocol frame

#### Scenario: 扩展事实不污染 semantic stream
- **GIVEN** 扩展通过 helper 发出 extension fact
- **WHEN** semantic protocol binding 正在消费 public semantic stream
- **THEN** 不得为了该 fact 伪造普通 semantic event
- **AND** 必须写入 private observability stream 并经 public observability stream 暴露给 sinks
- **AND** semantic stream/signal 边界保持不变

### Requirement: Provider scene capture 必须保持层间隔离
provider runtime 可以调用 contract hook，但不得 import organ/composer 的副作用实现。

#### Scenario: Provider 请求完成
- **GIVEN** provider runtime 完成一次请求
- **WHEN** 存在 scene capture hook
- **THEN** core logic 只调用 contract hook
- **AND** 实际文件/日志/外部上报实现由外层注入

#### Scenario: provider hook 产出 observability fact
- **GIVEN** provider runtime 调用 contract hook 记录 request/response/error
- **WHEN** 外层注入 hook 实现
- **THEN** hook 实现可以把 provider scene 作为 observability-only fact 写入 ObservabilityRxData
- **AND** core contract 不得依赖 Phoenix、文件系统或 organ implementation
