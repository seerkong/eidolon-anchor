# 变更：移除 legacy `Collective* / Formation*` tool family

## 背景

经过前几轮收口后，`collective / formation` 在当前版本里已经不再出现在 formal slash surface、runtime truth、protocol truth、manager helper 或 runtime event API 中。

剩下最显著的一块旧名，是 internal-only `Collective* / Formation*` tool family：

- `composeToolRegistry({ includeInternalOnly: true })` 仍能注册它们
- `ToolFuncBuiltin.ts`、`PromptAssets.generated.ts` 仍为它们保留接入
- 测试里仍保留一整套兼容调用断言

这批工具已不再承担正式兼容承诺，继续保留只会让 `collective / formation` 看起来仍像当前可用的组织命令面。

## 变更内容

- 从 builtin registry 中移除 `Collective* / Formation*` tool defs
- 删除对应工具目录与 prompt 资产入口
- 更新 tests，使 `includeInternalOnly: true` 也不再暴露这批 legacy tool family
- 同步 theater 报告与 track 文档

## 非目标

- 不处理历史文档中作为迁移前基线保留的 `/collective` `/formation` 描述
- 不修改 `includeInternalOnly` 对 detached/shutdown/coordination 等其他 internal-only 工具的作用
- 不继续改动 formal `Holon*` / `Member*` / `Actor*` 工具族

## 影响范围

- `cell/packages/organ-logic/src/composer/AIAgent/ToolFuncBuiltin.ts`
- `cell/packages/organ-logic/src/composer/AIAgent/tools/PromptAssets.generated.ts`
- `cell/packages/organ-logic/src/composer/AIAgent/tools/Collective*`
- `cell/packages/organ-logic/src/composer/AIAgent/tools/Formation*`
- `cell/packages/organ-logic/tests/AIAgent/organization_tools.test.ts`
- `terminal/packages/organ/tests/AIAgent/runtime/tool_registry_builtin_behavior.test.ts`
- `.theater/actor/2026-04-09-collective-formation-rename-readiness-report.md`
