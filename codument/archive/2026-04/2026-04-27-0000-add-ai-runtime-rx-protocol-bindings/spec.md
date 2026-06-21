# 规范：add-ai-runtime-rx-protocol-bindings

## 概述

本 Track 从 `AiAgentVmPublicRxData` 派生协议场景专属 RxData，使不同入口协议共享同一 runtime facts，同时保留各自输出语义。该设计对应参考项目多协议 adapter 的关键思想，但适配本项目 TypeScript 与双层微内核结构。

本 Track 基于已归档的 VM runtime shape 与 VM RxData 数据面：`AiAgentVmPublicRxData` 已提供 `semanticEvents`、`historyDomainStream`、`promptDomainStream`、`sessionDomainStream`、`usage` 和 `traceSummary`；协议绑定不得再重新定义 VM RxData shape，也不得绕过 `ensureVmRxData(vm)` 直接访问 eventBus 或 private writers。

## ADDED Requirements

### Requirement: 协议 RxData 必须从 public RxData 派生
系统必须通过 `AiAgentVmPublicRxData` 创建协议专属数据面，不得直接消费 private rx data。

#### Scenario: 创建协议绑定
- **GIVEN** VM 可以通过 `ensureVmRxData(vm)` 初始化 public rx data
- **WHEN** TUI、web、terminal 或 OpenAI-compatible adapter 创建输出管线
- **THEN** adapter 或 binding factory 必须先取得 `ensureVmRxData(vm).publicRxData`
- **AND** 必须从 public rx data 派生协议专属 RxData 或 protocol frames
- **AND** 不得直接订阅 VM private rx data
- **AND** 不得直接订阅 `vm.eventBus` 作为协议输出主来源

#### Scenario: 协议层不能写 private 数据
- **GIVEN** 协议 binding 正在运行
- **WHEN** 它需要输出 content、tool、domain 或 usage 信息
- **THEN** 它只能读取 public stream/signal
- **AND** 不得调用 private stream 的 `append`
- **AND** 不得调用 private signal 的 `set`

### Requirement: 协议绑定必须早于请求执行
协议 stream 绑定必须发生在 actor submit/execute 之前。

#### Scenario: 不丢失首个 semantic event
- **GIVEN** 请求即将触发 actor runtime
- **WHEN** 协议 adapter 初始化
- **THEN** adapter 必须先完成 rx binding
- **AND** 随后产生的 turn start、content delta、tool call 等事件都能被协议输出消费

### Requirement: 首个协议绑定必须覆盖 semantic protocol frame
系统必须先落地一个不绑定具体 UI 路由的 semantic protocol frame binding，作为 terminal、web/composer 与 OpenAI-compatible adapter 的共同输入层。

#### Scenario: semantic event 转换为协议 frame
- **GIVEN** public rx data 收到 turn、content、tool、error 或 questionnaire 语义事件
- **WHEN** semantic protocol binding 已订阅 public stream
- **THEN** 它必须输出稳定的 protocol frame
- **AND** frame 必须保留 trace、actor、team 与 event type 等可路由字段
- **AND** 具体 TUI/web/OpenAI adapter 可以在后续从该 frame 做协议格式化

#### Scenario: domain stream 作为可选 frame 来源
- **GIVEN** conversation domain streams 已通过 `bindVmDomainRxStreams` 接入 VM public rx data
- **WHEN** semantic protocol binding 启用 domain frame 输出
- **THEN** history、prompt、session domain event 必须以只读方式投影为协议 frame
- **AND** 未接入 domain runtime 时 binding 仍必须可用

### Requirement: 协议输出不得混淆 stream 与 signal
协议 adapter 可以读取 signal 生成最终响应字段，但不得把 signal 状态伪造成 semantic stream event。

#### Scenario: usage 输出来自 signal
- **GIVEN** OpenAI-compatible 或其他最终响应需要 usage
- **WHEN** 生成响应尾部或 summary
- **THEN** usage 必须来自 public/protocol rx data 的 readonly signal
- **AND** 不得向 semantic event stream 注入 usage 事件

#### Scenario: trace summary 输出来自 signal
- **GIVEN** 协议输出需要展示事件计数或最后事件时间
- **WHEN** 生成 runtime summary
- **THEN** trace summary 必须来自 public/protocol rx data 的 readonly signal
- **AND** 不得通过扫描 private log 或写入 synthetic semantic event 生成 summary

## 验收标准
- 至少新增一个 semantic protocol frame 类型和一个 binding 实现。
- binding factory 调用 `ensureVmRxData(vm)`，并且测试覆盖绑定先于执行。
- 测试覆盖协议层只能读取 public rx data，不能写 private stream/signal。
- usage 与 traceSummary signal 的协议投影有测试覆盖，且不进入 semantic stream。
- domain streams 已接入时可以被投影；未接入时首个 binding 仍可工作。

## 范围外事项
- 不实现 observability log/Phoenix sinks。
- 不要求一次性迁移所有历史 OutputStream 调用点。
