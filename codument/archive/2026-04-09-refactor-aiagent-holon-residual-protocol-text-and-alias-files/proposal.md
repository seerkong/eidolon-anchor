# 变更：继续收口 holon residual protocol text 与 legacy alias 文件名

## 背景

当前 `member / holon / governance / primary` 的正式对象模型已经落地，runtime protocol 的 lane/workload/scope marker 也已经切到 holon-first。

但仓库里还保留两类明显旧名：

- autonomous holon envelope 仍使用 `<collective_task>` tag，且其内部协议字段与 formal error code 仍带 `collective_*`
- `collectiveEnvelope.ts`、`formationEnvelope.ts`、`RuntimeCollectiveController.ts`、`CollectiveTaskRunner.ts` 这批 alias 文件名仍然存在

这些残留已经不再承载正式模型，但会继续干扰后续 `collective / formation -> holon + governance` 的剩余重命名工作。

## 变更内容

- 将 autonomous holon envelope tag 从 `<collective_task>` 收口为 holon-first 协议文本
- 将 autonomous holon formal assign path 中残留的 `collective_*` formal error code / target type 收口为 holon-first 命名
- 保留 legacy `CollectiveAssign` 兼容边界，但由 alias 层负责把 formal holon 错误翻译回旧名
- 删除已无内部引用的旧 alias 文件：
  - `collectiveEnvelope.ts`
  - `formationEnvelope.ts`
  - `RuntimeCollectiveController.ts`
  - `CollectiveTaskRunner.ts`

## 非目标

- 不继续处理 `OrganizationManager` / actor state 中仍保留的 `collectiveId` / `formationId` 内部状态字段
- 不修改 internal-only `Collective* / Formation*` 工具族对旧输出字段的兼容承诺
- 不处理 vendor/depa-actor 的历史测试与说明文档

## 影响范围

- `cell/packages/organ-logic/src/organization/autonomousHolonEnvelope.ts`
- `cell/packages/organ-logic/src/composer/AIAgent/tools/_autonomousHolonAssignCore.ts`
- `cell/packages/organ-logic/src/composer/AIAgent/tools/CollectiveAssign/Logic.ts`
- `cell/packages/organ-logic/src/exec/AiAgentExecutor.ts`
- `cell/packages/organ-logic/tests/AIAgent/*`
- `.theater/actor/2026-04-09-collective-formation-rename-readiness-report.md`
