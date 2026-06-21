# 变更规范：AIAgent TaskTree 工具链对齐与规范化

## 概述

本 Track 用于将已经完成的 TaskTree 相关代码改动补建为规范化变更追踪，范围聚焦于：
- `TaskTreeWrite`/`TaskTreeRead` 工具能力与命名稳定化
- `RunSubTask` 到 `RunSubAgent` 的命名迁移
- `ToolDefinitions` 中工具 schema 来源去重（以工具目录定义为准）
- terminal minimal 的最小可用对齐

本 Track 不新增超出当前实现状态的业务能力。

## ADDED Requirements

### Requirement: TaskTreeWrite 作为唯一任务树写入工具
系统 MUST 使用 `TaskTreeWrite` 作为任务树状态更新入口，支持 `replace_root`、`expand`、`update_status` 三类操作。

#### Scenario: 使用 replace_root 初始化任务树
- **GIVEN** 当前会话存在 AIAgent actor
- **WHEN** 调用 `TaskTreeWrite` 且 `op=replace_root`
- **THEN** 任务树根节点子任务被替换为输入任务集合
- **AND** 返回可读的任务树渲染结果

#### Scenario: 仅允许 in_progress 任务执行 expand
- **GIVEN** 某任务状态不是 `in_progress`
- **WHEN** 调用 `TaskTreeWrite` 且 `op=expand`
- **THEN** 系统拒绝扩展并返回可识别错误

### Requirement: TaskTreeRead 返回完整任务树 JSON
系统 MUST 提供 `TaskTreeRead` 工具，并返回完整 `TaskTree` JSON（包含 `root` 与 `nextId`）。

#### Scenario: 读取完整结构
- **GIVEN** 会话内已存在任务树状态
- **WHEN** 调用 `TaskTreeRead`
- **THEN** 返回值包含完整 JSON 结构
- **AND** 返回内容包含 `root` 字段与 `nextId` 字段

### Requirement: 子代理工具命名统一为 RunSubAgent
系统 MUST 以 `RunSubAgent` 作为子代理调用工具名，旧名 `RunSubTask` 不再作为标准入口。

#### Scenario: 使用新工具名调用子代理
- **GIVEN** 已注册可用 agent_type
- **WHEN** 调用 `RunSubAgent`
- **THEN** 系统按输入参数创建子代理任务
- **AND** 工具调用链路不依赖 `RunSubTask` 名称

### Requirement: ToolDefinitions 以工具目录 schema 为单一来源
系统 MUST 在 `ToolDefinitions` 中基于 builtin tool defs 组装 schema，避免重复手写 schema 定义导致漂移。

#### Scenario: 组装工具清单时不依赖重复硬编码
- **GIVEN** 已存在工具目录下的 ToolDef schema
- **WHEN** 构建 base tools 与动态工具描述
- **THEN** 使用工具目录 schema 作为来源
- **AND** 不再维护重复的同名手写 schema

## 非功能需求

### Requirement: 终端侧最小对齐
terminal 侧 SHALL 只完成 minimal 运行与基础映射对齐，不要求完整 TUI 深度体验优化。

#### Scenario: minimal 提示词与工具名一致
- **GIVEN** 启动 terminal minimal
- **WHEN** 查看系统提示词与工具映射
- **THEN** 使用 `TaskTreeWrite`、`TaskTreeRead`、`RunSubAgent` 新命名

### Requirement: 变更追踪以已实现状态为准
本 Track SHALL 仅追踪本轮已完成改动，不额外扩展新特性。

#### Scenario: 计划任务收敛为文档化与验证
- **GIVEN** 代码已存在改动
- **WHEN** 执行本 Track
- **THEN** 任务聚焦于规范、校验与收口
- **AND** 不新增与目标无关功能

## 验收标准

- `TaskTreeWrite`/`TaskTreeRead`/`RunSubAgent` 在工具注册与调用路径中可用。
- `TaskTreeRead` 输出为完整任务树 JSON（含 `root`、`nextId`）。
- `ToolDefinitions` 不再维护与工具目录重复的手写 schema。
- terminal minimal 使用新工具命名完成最小对齐。
- 目标测试通过，且 `codument validate update-aiagent-tasktree-tools --strict` 通过。

## 范围外事项

- 不包含 vfs 示例与模板文件改造。
- 不包含完整 TUI 体验重构或额外视觉交互优化。
- 不新增 TaskTree 以外的全新业务能力。
