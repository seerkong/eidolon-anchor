# AIAgent 参考对齐阶段化流式能力规范

## 概述

本能力规范定义 AIAgent 当前正式的阶段化流式真相：系统基于 `DataGraph` 建立与参考项目对齐的 lexical / syntactic / semantic 三层事件体系，并以 semantic-first 方式统一 runtime、terminal bridge、message history 与终端投影消费面。

## ADDED Requirements

### Requirement: 新链路事件契约必须完全对齐参考项目

系统应当（SHALL）在本项目中完整新建与参考项目完全对齐的 lexical、syntactic、semantic 三层事件契约。

#### Scenario: lexical/syntactic/semantic 定义完全对齐
- **GIVEN** 参考项目中已有 lexical、syntactic、semantic 三层事件定义
- **WHEN** 在本项目中创建新事件契约
- **THEN** 事件名称、字段名称、构造语义必须与参考项目完全对齐
- **AND** 不得以保留当前压缩版旧事件面作为正式主契约替代

### Requirement: 阶段流水线继续基于 DataGraph

系统应当（SHALL）保留本项目 `DataGraph` 作为阶段执行和投影内核，而非回退到参考项目的 Rx / stream object 模型。

#### Scenario: 新阶段流水线使用 DataGraph 建模
- **GIVEN** 参考项目的阶段模型更成熟，但执行承载方式不同
- **WHEN** 在本项目中实现 lexical -> syntactic -> semantic 流水线
- **THEN** 各阶段应以 `DataGraph` 的 signal、consumer、batch、projection 机制建模
- **AND** 不得将主执行模型退回为 Rx/stream object 驱动

#### Scenario: live runtime 与 canonical replay 共享同一套 stage kernel
- **GIVEN** runtime 主链路从 provider ingress 增量接收流式输入
- **WHEN** live/runtime 路径把输入接入阶段流水线
- **THEN** 它必须先适配为 lexical events
- **AND** 再喂给与 canonical replay 共享的 stage-based `DataGraph` 内核
- **AND** 不得在 `LiveLLMStagePipeline` 内长期保留独立的 syntactic / semantic parser 实现

### Requirement: runtime 与 terminal 共享单一 semantic canonical source

系统应当（SHALL）让 runtime bus、terminal bridge 与上层消费共同使用同一条 semantic canonical event 链路，而不是并行从 ingress 重建多份 semantic 事件。

#### Scenario: terminal 只消费 canonical semantic source
- **GIVEN** runtime 已经从 ingress 构建出 semantic canonical events
- **WHEN** terminal、notification bridge 或其他上层消费入口订阅流式事件
- **THEN** 它们必须消费同一条 canonical semantic event 链路
- **AND** 不得再为 direct terminal output 额外并行重跑一套独立 semantic 生成路径

#### Scenario: direct slash 可见输出也进入 canonical semantic/history 链路
- **GIVEN** terminal runtime 支持 `/actor`、`/member`、`/holon` 等 direct slash 命令
- **WHEN** 这些命令产生命令执行结果并向用户显示
- **THEN** 结果必须经由 runtime semantic bus 发出并再由 terminal projection 消费
- **AND** 不得只在 terminal bridge 内部直接构造可见内容而绕过 event bus / history

### Requirement: 新链路必须具备完整测试闭环

系统应当（SHALL）在迁移完成后的正式真相中，保持 lexical、syntactic、semantic、TUI projection、Textual projection、TuiCard/TuiText projection 的完整测试闭环。

#### Scenario: 新链路通过完整 fixtures 和测试
- **GIVEN** 新链路已经完成事件契约、DataGraph 和消费图实现
- **WHEN** 执行正式验证
- **THEN** lexical、syntactic、semantic、TUI projection、Textual projection、TuiCard/TuiText projection 测试必须全部通过
- **AND** `default`、`chunked-markers`、`quote-chunked`、`content-unquote`、`toolcall-delta`、`toolcall-multiple`、`toolcall-alt-format`、`tui-turn-events`、`questionnaire`、`plan-approval`、`shutdown`、`background-result` 等场景必须形成稳定 fixtures

### Requirement: 新链路包含 TUI 和 Textual 两种正式消费图

系统应当（SHALL）同时为 TUI 与 Textual 提供正式消费图和独立测试面。

#### Scenario: 两种终端消费图都可独立重放
- **GIVEN** 新 semantic / projection graph 已经生成规范事件
- **WHEN** TUI 和 Textual 两种终端消费图处理这些事件
- **THEN** 两者都必须具备独立 projector、fixtures 和测试
- **AND** 两者都必须能稳定重放 actor 切换、streaming、tool result、questionnaire、plan approval、shutdown 等关键场景

#### Scenario: TUI 与 Textual 都具备正式运行时入口
- **GIVEN** terminal runtime 已切到 semantic-first 新链路
- **WHEN** 不同终端入口选择 TUI 或 Textual 投影
- **THEN** 两者都必须通过正式 runtime bridge 接到对应 projection
- **AND** 不得只有测试内部 graph 能消费 Textual，而正式 runtime 入口无法选择

## 非功能需求

1. 阶段事件产生时机必须可通过 transcript fixtures 验证
2. 正式主链路应优先保持 semantic-first 单源语义，不恢复旧压缩链路或长期兼容双轨
3. 影响范围与公开消费面应能在规范与实现中被清晰复核
