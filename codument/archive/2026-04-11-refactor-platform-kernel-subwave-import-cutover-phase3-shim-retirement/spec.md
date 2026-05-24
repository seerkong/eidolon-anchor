## ADDED Requirements

### Requirement: Legacy Support and Mod Shim Packages Must Retire After Cutover
系统 SHALL 在 direct import 与 workspace alias 均完成 cutover 后，退休旧 support/mod shim package。

#### Scenario: Legacy shim packages are removed from the workspace
- **GIVEN** 仓内源码不再直接 import 旧 support/mod package 名称
- **AND** workspace `tsconfig` 已不再暴露旧 alias
- **WHEN** 执行 phase3 shim retirement
- **THEN** `cell/packages/organ-support` / `cell/packages/mod-sys-kernel` / `cell/packages/mod-sys-coding` 应从工作区移除
- **AND** focused tests 应验证这些 legacy shim package 已不存在

### Requirement: Legacy Package Names Must Stay Out of Normal Code Paths After Shim Retirement
系统 SHALL 在 shim 退休后继续阻止旧 package 名称回流到普通源码与开发路径。

#### Scenario: Migration guard rejects legacy package names in normal code paths
- **GIVEN** legacy shim package 已退休
- **WHEN** 新增或修改普通源码、测试或 workspace alias
- **THEN** 不得重新引入 `@cell/organ-support` / `@cell/mod-sys-*`
- **AND** focused guard 应能检测这类回流
