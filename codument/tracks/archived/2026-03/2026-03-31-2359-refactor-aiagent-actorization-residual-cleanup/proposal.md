# 变更：收口 AIAgent actorization 残余兼容层与术语漂移

## 背景和动机 (Context And Why)

前一轮 actorization 已完成 `detached`、`collective`、`formation`、`coordination` 的主路径收口，主功能与 focused tests 已通过。但当前实现仍保留几条 residual fallback：`coordination` 的 VM 级 legacy store 仍可在 owner 缺失时提供 store-only 可见状态，organization query/status 仍保留 synthetic projection fallback，vendor 文档与 runtime prompt 还有少量正式术语漂移。

这些残余不再是主路径缺口，但它们会继续弱化 actor-owned truth 作为唯一真相源的边界，也会给后续实现者留下模糊的兼容后路。本 track 的目标是把这些残余进一步收口，使 actorization 的边界更清晰、更可维护。

## “要做”和“不做” (Goals / Non-Goals)

**目标:**
- 收口 `coordination` 的 store-only fallback，使其不再伪装成 live actor-owned state
- 收口 organization query/status 的 synthetic projection fallback，优先暴露真实 `collective` / `formation` actor
- 同步 vendor 文档、runtime prompt 与帮助文案到当前正式术语，其中保留 `assign:r` 作为正式 `assign` surface 的显式 final 写法
- 补齐 focused tests，锁定上述 cleanup 不会回退

**非目标:**
- 不重新设计新的 actor 对象模型
- 不重做 `detached` / `collective` / `formation` 的主执行路径
- 不删除测试专用的 legacy helper，只要求它们不再污染正式生产语义
- 不引入新的一级命令面或新的 coordination actor 类型

## 变更内容（What Changes）

- 将 `CoordinationEngine` 的 legacy store 进一步降级为诊断/兼容缓存
- 调整 `CoordinationStatus` / recovery 语义，避免 store-only record 被默认为 live truth
- 调整 organization actor 解析与状态查询路径，优先返回真实 actor
- 清理 vendor 文档、runtime prompt 与帮助文案中与当前正式 surface 不一致的术语，并明确保留 `assign:r`
- 为上述 cleanup 补 focused tests 与回归验证

## 影响范围（Impact）

- 受影响的功能规范：
  - `aiagent-member-collective-formation-model`
  - `aiagent-persistence-recovery`
  - `aiagent-fiber-orchestration`

- 受影响的代码与资产：
  - `cell/packages/organ-logic/src/coordination/*`
  - `cell/packages/organ-logic/src/composer/AIAgent/tools/*`
  - `cell/packages/organ-logic/src/organization/*`
  - `cell/packages/organ-logic/src/persistence/*`
  - `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts`
  - `vendor/depa-actor/ACTOR-FOR-AI-AGENTS.md`
  - 相关 focused tests
