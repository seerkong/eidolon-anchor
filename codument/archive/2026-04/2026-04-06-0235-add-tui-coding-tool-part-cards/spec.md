## ADDED Requirements

### Requirement: Structured Coding Tool Part Cards In Prototype TUI

系统应当（SHALL）将 coding 主链中的工具调用投影为专用消息卡片，而不是继续使用摘要型 tool message。

#### Scenario: Render dedicated cards for coding tool parts

- **GIVEN** runtime 发出 `bash`、`edit`、`write`、`read`、`grep`、`glob`、`list`、`patch` 等 coding 工具 part
- **WHEN** TUI 渲染对应 assistant turn
- **THEN** 系统使用专用工具卡片展示这些工具调用
- **AND** 不再退化为仅包含 `tool + summary` 的简化卡片

#### Scenario: Preserve live tool state updates in structured cards

- **GIVEN** runtime 先后发出同一个 tool call 的 pending、completed 或 error 更新
- **WHEN** prototype graph 持续接收 `message.part.updated`
- **THEN** TUI 保留该 tool part 的稳定身份并更新对应专用卡片状态
- **AND** 卡片可继续读取 `input`、`output`、`metadata` 等结构化字段

#### Scenario: Keep fallback for unsupported tools

- **GIVEN** runtime 发出当前未被专用卡片覆盖的工具调用
- **WHEN** TUI 渲染该工具 part
- **THEN** 系统继续保留 generic fallback card
- **AND** 不因新卡片接入而丢失未知工具的可见性
