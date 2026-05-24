# 规范：将 AIAgent 契约与逻辑拆分迁移到 cell 包层

## 概述

本 Track 目标是将当前位于 `backend/packages/core/src/modules/AIAgent` 与 `backend/packages/organ/src/AIAgent` 下的 AIAgent 领域代码，按新的 `cell/packages/*` 分层进行重构迁移。迁移后的包边界必须由依赖方向决定，而不是按原始目录简单平移。

本次重构为一次性切换：
- `cell` 成为新的唯一源头
- 仓库内所有引用同步切换到 `@cell/*`
- 不保留 `@backend/core/modules/AIAgent` 或 `@backend/organ/AIAgent` 的兼容层、re-export 层或过渡转发层

## 功能需求

### Requirement: 按依赖层次拆分 AIAgent 代码到 cell 包
系统应当将 AIAgent 相关代码按依赖层次拆分到 `cell/packages/core-contract`、`cell/packages/core-logic`、`cell/packages/organ-contract-low`、`cell/packages/organ-contract-high`、`cell/packages/organ-logic`。

#### Scenario: core 下的契约与逻辑被拆分
- **GIVEN** `backend/packages/core/src/modules/AIAgent` 同时包含类型定义、接口、协议、运行时逻辑与流处理实现
- **WHEN** 执行本次重构
- **THEN** 类型定义、接口与契约类应被迁移到 `cell/packages/core-contract`
- **AND** 运行时逻辑、加载器、注册器、算法与行为实现应被迁移到 `cell/packages/core-logic`

#### Scenario: organ 下的代码被拆分为低层契约、高层契约与逻辑
- **GIVEN** `backend/packages/organ/src/AIAgent` 同时包含底层引擎契约、AIAgent 领域契约与组织逻辑实现
- **WHEN** 执行本次重构
- **THEN** 底层不依赖未来 `core-contract` 的契约类应迁移到 `cell/packages/organ-contract-low`
- **AND** 依赖 `organ-contract-low` 之外的 organ 契约类应迁移到 `cell/packages/organ-contract-high`
- **AND** 拆分后剩余的行为实现、组织逻辑与适配逻辑应迁移到 `cell/packages/organ-logic`

### Requirement: 新包依赖边界必须符合领域分层
系统应当保证新包之间的依赖关系符合约定的领域分层，不得引入反向依赖或循环依赖。

#### Scenario: core-contract 依赖 organ-contract-low
- **GIVEN** `organ-contract-low` 定义引擎级底层契约
- **AND** `core-contract` 定义 AIAgent 领域核心底层契约
- **WHEN** 建立新包依赖关系
- **THEN** `core-contract` 可以依赖 `organ-contract-low`
- **AND** `organ-contract-low` 不得依赖 `core-contract`

#### Scenario: stream 底层契约下沉到 organ-contract-low
- **GIVEN** 当前 AIAgent stream 相关代码同时包含契约与逻辑
- **WHEN** 识别其中的底层流契约、流事件接口或与引擎层直接相关的基础定义
- **THEN** 这些底层契约可以迁移到 `organ-contract-low`
- **AND** 其余依赖更高层 AIAgent 语义的内容应留在 `core-contract`、`organ-contract-high` 或对应 logic 包

#### Scenario: 逻辑包只依赖所需契约层
- **GIVEN** `core-logic` 与 `organ-logic` 承载行为实现
- **WHEN** 迁移逻辑文件
- **THEN** `core-logic` 只能依赖其所需的底层契约层
- **AND** `organ-logic` 只能依赖其所需的契约层与实现层
- **AND** 不得通过保留旧路径来绕过新的分层约束

### Requirement: 仓库内引用必须一次性切换到 @cell/*
系统应当将仓库内对旧 AIAgent 路径的直接引用统一切换到新的 `@cell/*` 包路径。

#### Scenario: 业务代码引用切换
- **GIVEN** `backend`、`terminal`、`frontend`、`desktop`、`shared` 或测试代码中存在对旧 AIAgent 路径的引用
- **WHEN** 完成本次重构
- **THEN** 这些引用应被改写为新的 `@cell/*` 路径
- **AND** 不再依赖 `@backend/core/modules/AIAgent` 或 `@backend/organ/AIAgent` 作为正式来源

#### Scenario: 不保留兼容层
- **GIVEN** 本次重构要求一次性切换
- **WHEN** 完成迁移
- **THEN** 不应新增旧路径到新路径的兼容转发层
- **AND** 不应在旧目录保留仅用于过渡的 re-export 文件

### Requirement: 新包导出面必须覆盖迁移后的使用场景
系统应当为新的 `@cell/*` 包建立清晰、可消费的导出面，以支撑现有调用方与测试迁移后的使用场景。

#### Scenario: 现有调用方可通过新包导出访问能力
- **GIVEN** 调用方当前依赖 AIAgent 的类型、协议、运行时、流处理、组织能力、MCP、LLM 与持久化等能力
- **WHEN** 完成迁移
- **THEN** 新包的 `package.json`、`exports` 与 TS 路径应提供等价或更清晰的导出入口
- **AND** 调用方不需要回退到旧路径访问迁移后的实现

## 非功能需求

### Requirement: 重构后结构必须可维护
系统应当让新包命名、目录边界和导出面能够反映真实领域分层，避免把旧目录结构原样复制到 `cell` 中。

#### Scenario: 包职责可从名称直接理解
- **GIVEN** 新包名称已经预先确定
- **WHEN** 完成迁移
- **THEN** `organ-contract-low` 应体现引擎级底层契约
- **AND** `core-contract` 应体现 AIAgent 领域核心底层契约
- **AND** `organ-contract-high`、`core-logic`、`organ-logic` 应体现各自职责

### Requirement: 重构后仓库必须保持可验证
系统应当确保重构后的代码可通过现有自动化验证流程进行验证。

#### Scenario: 测试与类型检查可覆盖本次迁移
- **GIVEN** 本次重构会影响多个 workspace 与测试文件
- **WHEN** 完成实现
- **THEN** 相关测试、类型检查与构建入口应被更新到新路径
- **AND** 应能验证迁移后行为未因错误导入或错误导出而失效

## 验收标准

- 已将 `backend/packages/core/src/modules/AIAgent` 的契约类迁移到 `cell/packages/core-contract`
- 已将 `backend/packages/core/src/modules/AIAgent` 的逻辑迁移到 `cell/packages/core-logic`
- 已将 `backend/packages/organ/src/AIAgent` 中不依赖 `core-contract` 的底层契约迁移到 `cell/packages/organ-contract-low`
- 已将 `backend/packages/organ/src/AIAgent` 中除 `organ-contract-low` 外的契约部分迁移到 `cell/packages/organ-contract-high`
- 已将 `backend/packages/organ/src/AIAgent` 中剩余逻辑迁移到 `cell/packages/organ-logic`
- `core-contract -> organ-contract-low` 的依赖方向成立，且未引入反向依赖
- 仓库内旧 AIAgent 引用已切换到 `@cell/*`
- 未新增兼容层或旧路径 re-export 过渡层
- 新包导出面足以支撑现有调用方与测试迁移

## 范围外事项

- 不在本 Track 中引入新的 shell 包
- 不在本 Track 中保留双轨运行或长期兼容策略
- 不在本 Track 中对 AIAgent 行为做产品语义层新增功能设计
