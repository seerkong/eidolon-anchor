## 上下文

当前 runtime 的 actorization 主路径已经完成，但 residual cleanup 仍有三类：

1. `coordination` 仍保留 VM 级 legacy store，并在 recovery 后回灌为 store-only fallback
2. organization query/status 仍保留 synthetic projection fallback
3. vendor 文档与 runtime prompt 尚未完全同步到当前正式术语

这些残余不会立即破坏主功能，但它们会继续削弱 actor-owned truth 的边界，尤其是在恢复、诊断与后续维护阶段。

## 方案概览

1. 收口 `coordination` store-only fallback
  - 重新定义 legacy store 的语义，只允许其作为诊断/兼容缓存
  - `CoordinationStatus` 与相关工具对 store-only record 必须显式标记 degraded/unowned
  - recovery 继续允许读取 derived index，但不再把其默认解释为 live truth

2. 收口 organization query 的 synthetic projection fallback
  - `resolveActorSubject()` 在 manager 已确保 actor 存在后，优先返回真实 actor
  - synthetic projection 仅保留给显式 degraded / 兼容路径
  - `ActorStatus` / typed wrapper 优先基于 actor-owned state 计算 task summary、watch state 与 identity

3. 同步文档与 prompt
  - 更新 `vendor/depa-actor/ACTOR-FOR-AI-AGENTS.md`，补齐 `coordination` mailbox 与当前正式 assign surface
  - 更新 `TerminalRuntime` prompt 与帮助文案，使其与正式 assign surface 对齐，并保留 `assign:r` 作为显式 final 写法

## 影响范围与修改点

### Coordination Truth Cleanup
- `cell/packages/organ-logic/src/coordination/CoordinationEngine.ts`
- `cell/packages/organ-logic/src/composer/AIAgent/tools/CoordinationStatus/Logic.ts`
- `cell/packages/organ-logic/src/composer/AIAgent/tools/ShutdownStatus/Logic.ts`
- `cell/packages/organ-logic/src/persistence/RuntimeSnapshots.ts`

### Organization Query Cleanup
- `cell/packages/organ-logic/src/composer/AIAgent/tools/_resolveActorTarget.ts`
- `cell/packages/organ-logic/src/composer/AIAgent/tools/ActorStatus/Logic.ts`
- `cell/packages/organ-logic/src/composer/AIAgent/tools/CollectiveStatus/Logic.ts`
- `cell/packages/organ-logic/src/composer/AIAgent/tools/FormationStatus/Logic.ts`

### Docs / Prompt Alignment
- `vendor/depa-actor/ACTOR-FOR-AI-AGENTS.md`
- `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts`
- 必要的 slash help / test fixtures

## 决策

- 决策：保留 `CoordinationEngine` legacy store，但不再把它当作默认 live truth
  - 理由：恢复与诊断仍可能需要兼容缓存，但其语义必须显式降级

- 决策：organization synthetic projection 只保留为 degraded fallback
  - 理由：既然 `collective` / `formation` 已经正式 actor 化，就应让真实 actor 成为默认公开身份

- 决策：vendor 文档与 runtime prompt 同步在同一 track 内完成
  - 理由：这两处术语漂移会继续误导后续实现，不应单独留待未来处理

- 决策：保留 `assign:r` 作为与其他 `assign:*` 同等级的正式命令面
  - 理由：当前 slash command、用户帮助文案与补充设计文档都依赖该显式 final 写法；本 track 的目标是术语对齐，而不是收窄正式 surface

## 风险 / 权衡

- 风险：过早删除 legacy store 可能影响恢复诊断能力
  - 缓解：保留 store，但显式区分 live truth 与 degraded cache

- 风险：organization fallback 收紧后，某些恢复退化场景可能从“模糊成功”变成“显式 degraded”
  - 缓解：补 focused tests，并在输出 schema 中明确 degraded 语义

- 风险：prompt 术语改动可能影响少量已有 fixtures
  - 缓解：同步更新 focused tests 与帮助文案

## 兼容性设计

- 本 track 不新增新的 actor 类型或命令面
- 保留必要的兼容缓存与 degraded fallback，但不再把它们视为正式真相源
- 测试专用 legacy helper 可以保留，但不得继续污染正式生产 surface

## 迁移计划

1. 先冻结 `coordination` / organization query / 文档术语的目标边界
2. 再收口 `CoordinationEngine` 与 status/recovery 的 fallback 语义
3. 再收口 organization actor 解析与 query 返回路径
4. 最后同步 vendor 文档、runtime prompt 与 focused tests

## 待解决问题

- `CoordinationStatus` 暴露 degraded cache 时，是新增 `truth_source` 字段，还是直接 fail-fast
- organization degraded fallback 是否需要显式 `degraded: true` 字段
- runtime help 文案是否需要同步展示 `assign` / `assign:r` 与 `mode=final|none|stream` 的精确映射
