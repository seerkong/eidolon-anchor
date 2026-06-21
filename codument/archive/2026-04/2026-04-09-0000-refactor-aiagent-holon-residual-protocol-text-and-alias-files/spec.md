## MODIFIED Requirements

### Requirement: Holon Runtime Protocol Residual Naming
系统应当（SHALL）在 autonomous holon 的 envelope protocol、formal assign error wording 与内部模块命名上继续收口，避免 `collective` 作为当前正式真相残留。

#### Scenario: autonomous holon envelope 使用 holon-first protocol tag
- **GIVEN** runtime 正在为 autonomous holon 构造或解析 assign/member_task/result envelope
- **WHEN** runtime 写入或读取 envelope protocol text
- **THEN** protocol tag 应使用 holon-first 命名
- **AND** 不应再使用 `<collective_task>` 作为正式 tag

#### Scenario: formal HolonAssign 返回 holon-first error wording
- **GIVEN** 调用正式 `HolonAssign`
- **WHEN** autonomous holon 因无成员、actor 不可用、task 超限或 final 未 settle 而失败
- **THEN** formal 返回中的 error / target_type 应使用 holon-first 命名
- **AND** 不应继续把 `collective_*` 暴露为正式错误真相

#### Scenario: legacy CollectiveAssign 仍保留旧错误兼容边界
- **GIVEN** internal-only `CollectiveAssign` alias 通过 holon-first 实现路径执行
- **WHEN** autonomous holon assign 失败
- **THEN** alias 层仍可向兼容调用方返回 `collective_*` error 与 `target_type = collective`
- **AND** 该兼容行为不改变正式 `HolonAssign` 的 holon-first 真相

#### Scenario: 旧 alias 文件名不再作为当前内部实现路径
- **GIVEN** 仓库当前内部实现已经全部切到 holon-first 文件
- **WHEN** 清理已无内部引用的 alias 文件
- **THEN** `collectiveEnvelope.ts`、`formationEnvelope.ts`、`RuntimeCollectiveController.ts`、`CollectiveTaskRunner.ts` 应被移除
- **AND** 仓库内部不应再依赖这些旧文件名
