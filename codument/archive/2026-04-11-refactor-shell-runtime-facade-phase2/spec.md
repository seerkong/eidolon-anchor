## ADDED Requirements

### Requirement: Shell Runtime Must Prefer Narrow Domain Facade Ports
系统应当让 shell/runtime entry 优先消费更窄的 domain runtime facade port，而不是继续直接拼接过多 AI orchestration internals。

#### Scenario: Terminal runtime consumes narrowed domain facade
- **GIVEN** `TerminalRuntime` 需要执行 turn bridge、projection bridge 与 runtime lifecycle glue
- **WHEN** 完成本 track
- **THEN** 它应优先通过更窄的 domain facade port 获得能力
- **AND** 不应继续直接持有过多 orchestrator/coordinator/organization 真相

### Requirement: Shell Facade Cutover Must Preserve Adoption Behavior
系统应当在 shell facade 收紧后继续保持 terminal/tui/headless adoption 主路径不回归。

#### Scenario: Shell adoption still works after facade narrowing
- **GIVEN** terminal/tui/headless 当前已消费 assembly result 与 runtime bridge
- **WHEN** 完成本 track
- **THEN** focused tests 应继续通过
- **AND** shell 不得回退到本地默认 AI 语义
