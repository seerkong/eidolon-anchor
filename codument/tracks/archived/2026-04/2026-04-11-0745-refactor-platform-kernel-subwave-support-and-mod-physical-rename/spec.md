## ADDED Requirements

### Requirement: Support Packages Must Match Platform vs AI Ownership
系统 SHALL 将 support 实现物理归位到与 ownership 一致的包结构。

#### Scenario: Platform-only support is separated from AI support
- **GIVEN** 某个 support 实现只承载平台环境能力
- **WHEN** 执行物理包迁移
- **THEN** 它应归入 `platform-support`
- **AND** 不得继续与 AI runtime assets/state/config loader 混放在同一 support 包中

#### Scenario: AI-specific support stays in domain-ai-support
- **GIVEN** 某个 support 实现依赖 AI runtime 语义
- **WHEN** 执行物理包迁移
- **THEN** 它应归入 `domain-ai-support`
- **AND** 不得错误上收到平台 support

### Requirement: Mod Packages Must Match Formal Profile Naming
系统 SHALL 将 `mod-sys-kernel` / `mod-sys-coding` 物理归位到与正式 profile naming 一致的 AI 命名结构。

#### Scenario: Kernel and coding mods are physically renamed
- **GIVEN** 正式 profile 已命名为 `ai-kernel` / `ai-coding`
- **WHEN** 执行后续物理迁移
- **THEN** mod 包命名应与正式 profile 方向一致
- **AND** 迁移过程应保留可验证的增量兼容路径

### Requirement: Physical Rename Must Stay Incremental
系统 SHALL 通过增量 cutover 完成物理 rename，不得以一次性全仓改名破坏主路径连续性。

#### Scenario: Runtime entry remains runnable during package rename
- **GIVEN** support 与 mod 正在执行物理 rename
- **WHEN** 每一轮迁移完成
- **THEN** terminal/tui/headless 主路径仍可运行
- **AND** focused tests 不得退化为源码 grep
