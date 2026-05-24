## ADDED Requirements

### Requirement: Runtime Profiles Use Only Formal Naming
系统 SHALL 只保留正式的 runtime profile naming：`platform-only`、`ai-kernel`、`ai-coding`。

#### Scenario: Ai-coding is the only coding runtime profile export
- **GIVEN** 调用方需要默认 coding runtime profile
- **WHEN** 它消费 `@cell/mod-profiles`
- **THEN** 应使用 `ai-coding` 对应的正式导出
- **AND** 不再依赖 `default-coding` 兼容别名

### Requirement: Cleanup Must Not Break Runtime Continuity
系统 SHALL 在清理旧 profile 路径后，保持 terminal/tui/headless 主路径连续可运行。

#### Scenario: Runtime adoption remains stable after alias cleanup
- **GIVEN** 已删除旧 profile alias
- **WHEN** 执行 focused runtime/profile tests 与 smoke tests
- **THEN** terminal/tui/headless 主路径继续通过
- **AND** profile layering、capability absence、runtime adoption 语义保持不变
