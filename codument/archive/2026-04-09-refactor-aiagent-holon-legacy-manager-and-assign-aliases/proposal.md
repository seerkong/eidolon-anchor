# 变更：清理 holon legacy manager helper 与 assign alias module

## 背景

当前 formal surface、runtime protocol、residual protocol text 已经收口到 `holon + governance`。但内部实现仍保留两类 legacy 边界：

- `OrganizationManager` 里仍公开 `createCollective/createFormation/getCollective/getFormation/resolveCollective/resolveFormation` 等旧 helper
- `_collectiveAssignCore.ts` / `_formationAssignCore.ts` 仍作为 alias module 存在

这两类旧名虽然已经不再是正式真相，但仍会误导后续实现继续沿用 `collective / formation` 作为内部主语义。

## 变更内容

- 将 `OrganizationManager` 的主实现路径收口为 governance-first helper：
  - autonomous
  - leader_led
- 更新内部调用方，改用新的 governance-first helper
- 删除已无实际价值的 `_collectiveAssignCore.ts` / `_formationAssignCore.ts`
- 将 theater 报告与 track 文档同步到新的剩余面

## 非目标

- 不处理 `AgentEventGraph.emitCollective*` / `Collective.ts` 这类 runtime event alias
- 不修改 internal-only `Collective* / Formation*` tool family 的兼容承诺
- 不继续下钻 runtime record 类型中的 `VmCollectiveRecord` / `VmFormationRecord`

## 影响范围

- `cell/packages/organ-logic/src/organization/OrganizationManager.ts`
- `cell/packages/organ-logic/src/organization/AutonomousHolonTaskRunner.ts`
- `cell/packages/organ-logic/src/composer/AIAgent/tools/_autonomousHolonAssignCore.ts`
- `cell/packages/organ-logic/src/composer/AIAgent/tools/_leaderLedHolonAssignCore.ts`
- `cell/packages/organ-logic/src/composer/AIAgent/tools/_holonTooling.ts`
- `cell/packages/organ-logic/src/composer/AIAgent/tools/_collectiveAssignCore.ts`
- `cell/packages/organ-logic/src/composer/AIAgent/tools/_formationAssignCore.ts`
- `.theater/actor/2026-04-09-collective-formation-rename-readiness-report.md`
