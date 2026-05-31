## ADDED Requirements

### Requirement: Shell Runtime Must Prefer Narrow Domain Facade Ports
系统应当让 shell/runtime entry 优先消费更窄的 domain runtime facade port，而不是继续直接拼接过多 AI orchestration internals。

#### Scenario: Terminal runtime consumes narrowed domain facade
- **GIVEN** `TerminalRuntime` 需要执行 turn bridge、projection bridge 与 runtime lifecycle glue
- **WHEN** 完成本能力
- **THEN** 它应优先通过更窄的 domain facade port 获得能力
- **AND** 不应继续直接持有过多 orchestrator/coordinator/organization 真相

### Requirement: Shell Facade Cutover Must Preserve Adoption Behavior
系统应当在 shell facade 收紧后继续保持 terminal/tui/headless adoption 主路径不回归。

#### Scenario: Shell adoption still works after facade narrowing
- **GIVEN** terminal/tui/headless 当前已消费 assembly result 与 runtime bridge
- **WHEN** 完成本能力
- **THEN** focused tests 应继续通过
- **AND** shell 不得回退到本地默认 AI 语义

### Requirement: Shell Runtime Facade Exposes Runtime Context Control Views
系统应当让 shell/runtime facade 暴露正式的 work context、continuation baseline 与 prompt/context 相关 runtime-first 视图，而不是要求 terminal 侧散读底层状态。

#### Scenario: Terminal-facing shell facade can read runtime context control state
- **GIVEN** terminal、headless 或 shell bridge 需要读取当前 session 的 work context、continuation baseline 或相关 prompt state
- **WHEN** 它们通过 shell runtime facade 获取这些信息
- **THEN** facade SHALL 提供稳定的 runtime-first 读取入口
- **AND** 调用方不应继续直接拼接底层 actor/runtime 真相
