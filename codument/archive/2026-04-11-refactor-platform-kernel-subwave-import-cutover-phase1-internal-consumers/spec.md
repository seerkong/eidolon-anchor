## ADDED Requirements

### Requirement: Internal Consumers Must Prefer New Support Hosts
系统 SHALL 将仓内内部消费者优先切到新的 support 宿主包，而不是继续直接依赖兼容 shim。

#### Scenario: Internal tests switch from legacy support package to domain-ai-support
- **GIVEN** 仓内测试或内部实现直接依赖 `@cell/organ-support`
- **WHEN** 执行 import cutover phase1
- **THEN** 这些消费者应改为依赖 `@cell/domain-ai-support`
- **AND** 不得再把 `@cell/organ-support` 当作内部真实依赖入口

### Requirement: Legacy Support Package Must Stay Compatibility-Only
系统 SHALL 将旧 support 包保持为兼容层，而不是继续成为普通源码的默认入口。

#### Scenario: Legacy support imports are blocked outside compatibility package
- **GIVEN** `@cell/organ-support` 已是 compatibility shim
- **WHEN** 新增或修改仓内源码/测试
- **THEN** 普通消费者不得再直接 import 这个旧包
- **AND** 允许 `cell/packages/organ-support/**/*` 自身作为 shim 存在
