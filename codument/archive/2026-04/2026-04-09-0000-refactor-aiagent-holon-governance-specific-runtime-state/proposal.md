# 变更：收口 holon governance-specific runtime/state/payload 命名

## 背景

经过前几轮收口后，`collective / formation` 已从 formal slash surface、builtin tool family、manager helper、runtime event API、protocol lane/workload/scope 中退出。

当前真正还残留在代码真相层的，主要只剩这类 governance-specific 命名：

- `VmCollectiveRecord` / `VmFormationRecord`
- actor/runtime state 中的 `collectiveId` / `formationId`
- leader-led envelope 中的 `formationId` 与 `<formation_route>`

这批名字仍然进入 runtime state、snapshot、executor、organization manager 与 envelope protocol，是最后一层需要改穿的内部真相面。

## 变更内容

- 将 runtime record type 从 `VmCollectiveRecord / VmFormationRecord` 收口为 governance-first 命名
- 将 actor identity / holon state / organization manager / executor 中的 `collectiveId` / `formationId` 收口为 `holonId`
- 将 leader-led holon envelope 的 `formationId` 与 `<formation_route>` 收口为 holon-first 协议字段与 tag
- 同步 snapshot/recovery/tests/report

## 非目标

- 不修改已经完成的 formal `Holon*` / `Member*` / `Actor*` 命令面
- 不恢复任何已删除的 legacy tool family 或 runtime alias
- 不处理历史文档中作为迁移前基线保留的旧名

## 影响范围

- `cell/packages/core-logic/src/runtime/runtime.ts`
- `cell/packages/core-logic/src/runtime/actor.ts`
- `cell/packages/organ-logic/src/organization/*`
- `cell/packages/organ-logic/src/exec/AiAgentExecutor.ts`
- `cell/packages/organ-logic/tests/AIAgent/runtime/*`
- `cell/packages/organ-logic/tests/AIAgent/*`
- `.theater/actor/2026-04-09-collective-formation-rename-readiness-report.md`
