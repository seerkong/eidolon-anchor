# 规范：DataGraph 流式阶段模型重构

## 概述

本 track 旨在基于本项目现有 `DataGraph` 执行模型，建立与参考项目完全对齐的 lexical / syntactic / semantic 三层事件体系、stage-based DataGraph、TUI/Textual/card/text 消费图和完整测试闭环，并将正式主链路收敛到 semantic-first 新实现。

详细背景与约束见：

- `./data-graph-overview.md`
- `./data-graph-context.md`
- `./data-graph-architecture.md`
- `./data-graph-migration.md`

## ADDED Requirements

### Requirement: 新链路事件契约必须完全对齐参考项目

系统应当（SHALL）先在本项目中完整新建与参考项目完全对齐的 lexical、syntactic、semantic 三层事件契约。

#### Scenario: lexical/syntactic/semantic 定义完全对齐
- **GIVEN** 参考项目中已有 lexical、syntactic、semantic 三层事件定义
- **WHEN** 在本项目中创建新事件契约
- **THEN** 事件名称、字段名称、构造语义必须与参考项目完全对齐
- **AND** 不得以保留当前压缩版旧事件面作为正式主契约替代

### Requirement: P1 必须先冻结契约与 guardrails

系统应当（SHALL）在 P1 先冻结契约、命名和 guardrail 测试，再在后续阶段直接切换正式主链路。

#### Scenario: 契约先冻结，主链路后切换
- **GIVEN** 当前项目已有历史压缩主链路
- **WHEN** 开始落地新方案
- **THEN** 必须先完成新的 stage-based DataGraph 契约、消费图和测试 gate
- **AND** 在 gate 通过后应直接切换正式主链路，而不是保留长期双轨

### Requirement: 新链路必须继续基于 DataGraph

系统应当（SHALL）保留本项目 `DataGraph` 作为执行和投影内核，而非回退到参考项目的 Rx / stream object 模型。

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

### Requirement: runtime 与 terminal 必须共享单一 semantic canonical source

系统应当（SHALL）让 runtime bus、terminal bridge 与上层消费共同使用同一条 semantic canonical event 链路，而不是并行从 ingress 重建多份 semantic 事件。

#### Scenario: terminal 只消费 canonical semantic source
- **GIVEN** runtime 已经从 ingress 构建出 semantic canonical events
- **WHEN** terminal、notification bridge 或其他上层消费入口订阅流式事件
- **THEN** 它们必须消费同一条 canonical semantic event 链路
- **AND** 不得再为 direct terminal output 额外并行重跑一套独立 semantic 生成路径

#### Scenario: direct slash 可见输出也进入 canonical semantic/history 链路
- **GIVEN** terminal runtime 支持 `/actor`、`/member`、`/collective`、`/formation` 等 direct slash 命令
- **WHEN** 这些命令产生命令执行结果并向用户显示
- **THEN** 结果必须经由 runtime semantic bus 发出并再由 terminal projection 消费
- **AND** 不得只在 terminal bridge 内部直接构造可见内容而绕过 event bus / history

### Requirement: 新链路必须先完成全链路测试闭环

系统应当（SHALL）在任何迁移发生之前，先完成新链路的完整测试闭环。

#### Scenario: 新链路先通过全部 fixtures 和测试
- **GIVEN** 新链路已经完成事件契约、DataGraph 和消费图实现
- **WHEN** 准备开始迁移旧调用方
- **THEN** lexical、syntactic、semantic、TUI projection、Textual projection、TuiCard/TuiText projection 测试必须全部通过
- **AND** `default`、`chunked-markers`、`quote-chunked`、`content-unquote`、`toolcall-delta`、`toolcall-multiple`、`toolcall-alt-format`、`tui-turn-events`、`questionnaire`、`plan-approval`、`shutdown`、`background-result` 等场景必须形成稳定 fixtures

### Requirement: 新链路必须包含 TUI 和 Textual 两种消费图

系统应当（SHALL）同时为 TUI 与 Textual 新建消费图和独立测试面。

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

1. track 交付物必须自包含，不依赖 track 外部文档解释
2. P1 之后应优先删除旧链路正式入口，而不是继续保留兼容双轨
3. 阶段事件产生时机必须可通过 transcript fixtures 验证
4. track 文档中的影响范围应覆盖当前正式实现真实涉及的模块边界

## 验收标准

1. 已存在自包含的 track 内背景、架构和迁移文档
2. 已存在完整的 lexical / syntactic / semantic 契约规划
3. `plan.xml` 已把“P1 先冻结、随后 semantic-first cutover”写成显式阶段门控
4. 提交模式已确定

## 范围外事项

1. 不将参考项目的 Rx / Python runtime 容器原样迁入
2. 不为旧压缩链路保留长期兼容层
3. 不处理参考项目的 Python UI 实现细节迁入
