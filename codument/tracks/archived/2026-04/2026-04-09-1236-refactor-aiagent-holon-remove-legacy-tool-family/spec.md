## MODIFIED Requirements

### Requirement: Builtin Tool Registry Shall Expose Holon-First Organization Tools Only
系统应当（SHALL）让 builtin registry 只暴露 `Holon*` 作为组织工具族，而不再注册 legacy `Collective* / Formation*`。

#### Scenario: includeInternalOnly 不再恢复 legacy collective/formation tools
- **GIVEN** runtime 仍允许通过 `includeInternalOnly` 打开其他 internal-only 工具
- **WHEN** 本 track 完成后
- **THEN** `CollectiveCreate / Add / Status / Assign` 与 `FormationCreate / Add / Appoint / Status / Assign` 不应继续被注册
- **AND** `includeInternalOnly: true` 也不应重新暴露它们

#### Scenario: legacy tool directories and prompt assets are removed
- **GIVEN** 当前仓库已完成 holon-first formal surface 迁移
- **WHEN** 本 track 完成后
- **THEN** `Collective* / Formation*` 对应工具目录与 prompt asset 入口应被移除
