## ADDED Requirements

### Requirement: Shell Consumes Formal Runtime Catalog Descriptor
系统 SHALL 让 shell/runtime entry 通过 runtime assembly 暴露的正式 descriptor 读取 local-runtime catalog 所需的配置，而不是直接 import domain support 默认实现。

#### Scenario: TUI local-runtime config comes from formal descriptor
- **GIVEN** local-runtime 模式需要 provider/preset/default model 信息
- **WHEN** `TuiRuntimeCatalog` 构建本地 catalog
- **THEN** 它应通过 runtime assembly 暴露的 catalog/config descriptor 读取这些信息
- **AND** 不得直接读取 module-local domain support truth source

#### Scenario: Local-runtime agents come from formal assembly baseline
- **GIVEN** runtime assembly 提供 agent baseline
- **WHEN** TUI 初始化本地 runtime catalog
- **THEN** catalog 的默认 agents 应来自 formal assembly result
- **AND** 不得偷偷回退为 shell 模块内的静态默认 agent 列表

### Requirement: Explicit Fallback Instead Of Hidden Truth
系统 SHALL 将非 formal capability 的路径显式标记为 fallback，而不是伪装成正式 contract 消费。

#### Scenario: Formal runtime catalog descriptor missing
- **GIVEN** local-runtime assembly 没有提供 formal runtime catalog descriptor
- **WHEN** shell 仍需要构建本地 catalog
- **THEN** 系统可以退化到显式 fallback
- **AND** 该 fallback 不得再依赖隐藏的 domain support import truth

### Requirement: Runtime Adoption Must Stay Continuous
系统 SHALL 在 Wave 3 结束时保持 terminal/tui/headless 主路径连续可运行。

#### Scenario: Main runtime entries remain runnable
- **GIVEN** Wave 3 完成 shell adoption cutover
- **WHEN** 执行 terminal/tui/headless focused tests
- **THEN** 主路径应继续通过
- **AND** slash/help/prompt expansion 的正式消费边界不得回流到 shell 本地静态真相源
