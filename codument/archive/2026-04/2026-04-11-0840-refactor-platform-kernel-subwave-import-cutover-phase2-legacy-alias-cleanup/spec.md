## ADDED Requirements

### Requirement: Development Path Aliases Must Prefer New Package Hosts
系统 SHALL 从工作区开发路径解析层中移除旧 support/mod package alias，只保留新的宿主命名。

#### Scenario: Workspace tsconfig stops advertising legacy package aliases
- **GIVEN** 仓内源码已经完成 phase1 内部 import cutover
- **WHEN** 执行 phase2 legacy alias cleanup
- **THEN** `tsconfig.json` 中不应再声明 `@cell/organ-support` / `@cell/mod-sys-kernel` / `@cell/mod-sys-coding` path alias
- **AND** 新宿主 alias 应继续可用

### Requirement: Legacy Package Names Must Not Re-enter Normal Development Paths
系统 SHALL 阻止旧 package 名称重新回流到普通开发路径与源码消费面。

#### Scenario: Migration guard rejects legacy aliases in workspace tsconfig
- **GIVEN** 旧 package 仍作为 compatibility shim 保留
- **WHEN** 修改工作区 path alias 或普通源码 import
- **THEN** 不得再次把旧 package 名称加入开发主路径
- **AND** focused guard 应能检测这类回流
