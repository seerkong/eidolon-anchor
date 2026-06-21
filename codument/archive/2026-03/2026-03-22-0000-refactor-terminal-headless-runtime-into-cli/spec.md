## ADDED Requirements

### Requirement: Headless Terminal Command Entry

系统应当（SHALL）在 `terminal/packages/cli` 中提供无头命令入口，用于执行单轮或脚本式 terminal 调用，而不启动 OpenTUI。

#### Scenario: Run headless terminal turn without TUI

- **GIVEN** 用户在项目根或其子目录调用 terminal 命令
- **WHEN** 用户执行无头命令并提供 prompt
- **THEN** 系统直接输出模型返回内容
- **AND** 不进入 OpenTUI 界面

### Requirement: Shared Runtime For TUI And Headless Commands

系统应当（SHALL）将 TUI 与无头 terminal 共用的 runtime 初始化和 turn 执行能力沉淀到非 TUI 包中。

#### Scenario: TUI and cli reuse the same runtime initialization

- **GIVEN** 交互式 TUI 和无头 cli 都需要创建 session runtime
- **WHEN** 两者初始化 runtime
- **THEN** 它们复用同一套公共运行时逻辑
- **AND** 该逻辑不要求依赖 OpenTUI 页面层

### Requirement: Project Root Resolution For Headless And TUI Entry

系统应当（SHALL）在未显式传入项目路径时，自动向上查找最近的 `.eidolon` 目录作为项目根。

#### Scenario: Resolve project root from nested package directory

- **GIVEN** 命令从 `terminal/packages/tui` 之类的嵌套目录启动
- **WHEN** 用户没有显式传入项目路径
- **THEN** 系统向上查找最近的 `.eidolon` 所在目录
- **AND** 使用该目录作为 terminal runtime 的工作目录
