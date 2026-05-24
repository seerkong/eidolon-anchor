# 变更：基于 DataGraph 重建与参考项目对齐的流式阶段模型

## 背景和动机 (Context And Why)

当前项目历史上的流式处理链路曾将解析、语义生成和终端消费压缩在少量节点中，缺少 lexical / syntactic 两层显式契约。参考项目在 lexical、syntactic、semantic 三层事件定义和产生时机上更成熟，但其执行承载方式不如本项目的 `DataGraph` 高级。本变更旨在保留本项目的 `DataGraph` 优势，同时完全吸收参考项目更成熟的阶段事件模型，并以 semantic-first 方式收敛正式主链路。

## “要做”和“不做” (Goals / Non-Goals)
**目标:**
- 在本项目内完整新建与参考项目完全对齐的 lexical / syntactic / semantic 事件契约
- 建立 stage-based DataGraph、新的 TUI/Textual/card/text 消费图和完整测试闭环
- 将“P1 先冻结契约与测试、随后直接切换主链路”固化为正式计划约束
- 使正式主链路收敛到稳定、可回放、可验证的阶段化流水线之上

**非目标:**
- 将参考项目的 Rx / stream object 执行模型照搬到本项目

## 变更内容（What Changes）
- 新建一套 track 内自包含的背景、架构和迁移策略文档
- 在 `cell/packages/core-contract`、`core-logic`、`organ-logic`、`terminal/packages/organ` 中收敛新的正式实现
- 将 terminal runtime 的 direct slash 可见输出也收口到 canonical semantic/history 链路，不再保留只进 terminal bridge 的旁路
- 规划 lexical / syntactic / semantic / projection 六层测试闭环
- 规划 TUI、Textual、TuiCardGraph、TuiTextGraph 的独立 projector 与 fixtures
- **BREAKING** 将旧压缩式主路径和兼容层从正式运行面中彻底删除

## 影响范围（Impact）
- 受影响的功能规范：AI agent 流式事件分层、DataGraph 流水线、终端事件投影、transcript fixtures
- 受影响的代码：[cell/packages/core-contract](cell/packages/core-contract), [cell/packages/core-logic](cell/packages/core-logic), [cell/packages/organ-logic](cell/packages/organ-logic), [terminal/packages/organ](terminal/packages/organ), [terminal/packages/tui](terminal/packages/tui), [terminal/packages/support](terminal/packages/support), [terminal/packages/cli](terminal/packages/cli), [backend/packages/composer](backend/packages/composer), [backend/packages/core](backend/packages/core), [backend/packages/organ](backend/packages/organ)
- 详细说明文档：`./data-graph-overview.md`、`./data-graph-context.md`、`./data-graph-architecture.md`、`./data-graph-migration.md`
