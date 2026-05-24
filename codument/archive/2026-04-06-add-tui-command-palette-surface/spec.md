## ADDED Requirements

### Requirement: Command Palette Surface

系统应当（SHALL）为 prototype TUI 提供统一的命令面板界面，以集中承载可触发动作。

#### Scenario: Show registered commands in a unified palette

- **GIVEN** 系统中存在多类可触发动作和快捷键
- **WHEN** 用户打开命令面板
- **THEN** 系统集中展示这些动作
- **AND** 支持按名称筛选和触发

#### Scenario: Palette exposes system surfaces through one shared entrypoint

- **GIVEN** prototype 已具备 session、provider/model、agent、MCP、status、help 等可触发能力
- **WHEN** 用户打开命令面板
- **THEN** 系统将这些能力作为统一 action surface 暴露出来
- **AND** 用户无需记忆每个 dialog 的独立入口

#### Scenario: Preserve keybind-based direct triggering

- **GIVEN** 某些动作已绑定快捷键
- **WHEN** 用户直接按下快捷键或从命令面板触发
- **THEN** 系统两种触发路径保持一致
- **AND** 不出现重复定义或行为分叉

#### Scenario: Palette remains the secondary entrypoint rather than replacing direct shortcuts

- **GIVEN** 某些高频动作已有直接快捷键或 slash command
- **WHEN** 系统接入命令面板
- **THEN** 这些快捷路径继续保留
- **AND** 命令面板作为统一发现和补充入口存在
