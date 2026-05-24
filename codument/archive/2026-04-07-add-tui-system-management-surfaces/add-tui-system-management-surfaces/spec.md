## ADDED Requirements

### Requirement: Session Switcher Surface

系统应当（SHALL）为 prototype TUI 提供会话切换界面，以便浏览、切换和管理历史会话。

#### Scenario: Browse and switch sessions from a dedicated surface

- **GIVEN** 用户已有多个历史会话
- **WHEN** 用户打开会话切换界面
- **THEN** 系统展示可浏览的 session list
- **AND** 用户可以切换到目标会话

#### Scenario: Preserve session management actions

- **GIVEN** 用户正在浏览会话列表
- **WHEN** 用户触发重命名或删除等管理动作
- **THEN** 系统继续支持这些动作
- **AND** 不要求恢复旧 dialog 栈整体结构

### Requirement: Provider And Model Surface

系统应当（SHALL）为 prototype TUI 提供 provider 与 model 的管理和切换界面。

#### Scenario: Browse providers and select models

- **GIVEN** runtime 提供多个 provider 和 model
- **WHEN** 用户打开 provider/model 管理界面
- **THEN** 系统展示可选 provider 和 model
- **AND** 用户可以切换当前使用的模型

#### Scenario: Support provider connection flows

- **GIVEN** 某个 provider 需要认证或 API key
- **WHEN** 用户尝试启用该 provider
- **THEN** 系统继续支持相应的认证或输入流程
- **AND** 完成后更新当前可用 provider / model 状态

### Requirement: Agent And MCP System Surface

系统应当（SHALL）为 prototype TUI 提供 agent 选择与 MCP 管理界面。

#### Scenario: Switch current agent from a dedicated surface

- **GIVEN** 用户需要切换当前 agent
- **WHEN** 用户打开 agent 管理界面
- **THEN** 系统展示可选 agent
- **AND** 用户可切换当前 agent

#### Scenario: Manage MCP status from a system surface

- **GIVEN** runtime 提供 MCP server 状态
- **WHEN** 用户打开 MCP 管理界面
- **THEN** 系统展示当前 MCP 状态与开关动作
- **AND** 用户可执行启用、禁用或重连等操作
