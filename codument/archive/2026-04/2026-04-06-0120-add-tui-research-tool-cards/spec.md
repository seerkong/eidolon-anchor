## ADDED Requirements

### Requirement: Research Tool Cards

系统应当（SHALL）为 research 类工具调用提供专用卡片，包括 webfetch、codesearch 和 websearch。

#### Scenario: Render structured research tool cards

- **GIVEN** assistant 调用 `webfetch`、`codesearch` 或 `websearch`
- **WHEN** TUI 渲染对应工具调用
- **THEN** 系统展示专用 research tool card
- **AND** 用户可直接看到 URL、query 或结果数量等关键信息

#### Scenario: Research tools no longer fall back to generic cards

- **GIVEN** runtime 发出 `webfetch`、`codesearch` 或 `websearch` 的 `ToolPart`
- **WHEN** prototype message renderer 解析对应工具
- **THEN** 系统不再将这些 research 工具退化为 `GenericTool`
- **AND** 它们继续复用与 coding tools 相同的 structured tool part 主链

#### Scenario: Keep research cards secondary to coding flow

- **GIVEN** 当前会话以 coding 为主
- **WHEN** 系统接入 research tool cards
- **THEN** 不影响 coding 主链卡片的优先级与表现
- **AND** research 类卡片作为补充能力存在

#### Scenario: Keep generic fallback for unsupported tools

- **GIVEN** runtime 发出不属于 coding 或 research allowlist 的工具调用
- **WHEN** TUI 渲染该工具 part
- **THEN** 系统继续使用 generic fallback
- **AND** 不因 research cards 接入而丢失未知工具的可见性
