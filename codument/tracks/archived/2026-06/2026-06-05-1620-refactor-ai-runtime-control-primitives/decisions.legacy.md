# Decisions

## Usage
- 用于记录需要用户确认的决策问题、选项、最终结论与理由
- 问题标题不用字母前缀；字母只用于选项
- 后续执行过程中出现的新决策，也继续追加到本文件，不新建分散的决策记录

### 1. 【P0】Vendor 原语包位置和名称
- 背景：用户已在项目根目录创建 `vendor/`，并明确 `depa-actor-control` 应放到该目录下。
- 需要决定：底层 actor control 原语包位置和名称。
- 选项：
  - A) `vendor/depa-actor-control`
  - B) `cell/packages/depa-actor-control`
  - C) 在既有 `depa-actor` 中新增子模块
- 当前建议：A
- 用户答复：用户明确要求放到项目根目录 `vendor/` 下。
- 最终决策：A
- 决策理由：A 符合 vendor 原语优先，并避免把业务领域包与底层原语混在 cell package 下。
- 状态：accepted

### 2. 【P0】AI 领域控制面包名
- 背景：用户倾向于使用 `cell/packages/ai-runtime-control-contract` 与 `cell/packages/ai-runtime-control-logic`。
- 需要决定：AI 领域原语层包名。
- 选项：
  - A) `cell/packages/ai-runtime-control-contract` 与 `cell/packages/ai-runtime-control-logic`
  - B) `cell/packages/ai-control-contract` 与 `cell/packages/ai-control-logic`
  - C) 继续留在 `ai-organ-logic`
- 当前建议：A
- 用户答复：用户明确表达倾向。
- 最终决策：A
- 决策理由：A 清楚表达 runtime 控制面语义，且符合 contract/logic 分离。
- 状态：accepted

### 3. 【P0】第一批迁移范围
- 背景：控制面问题覆盖 safepoint、heartbeat、questionnaire、actor surface 和 TUI actor 操作；一次性迁移全部风险较高。
- 需要决定：本 track 的第一批代码迁移范围。
- 选项：
  - A) 建立包与原语模型，并只迁移 snapshot safepoint 热路径
  - B) 同时迁移 heartbeat、questionnaire、actor surface 和 TUI actor 操作
  - C) 只写设计，不做代码迁移
- 当前建议：A
- 用户答复：
- 最终决策：A
- 决策理由：A 让新原语通过真实热路径验证，同时避免把架构整理扩大成多系统重写。
- 状态：accepted

### 4. 【P1】兼容导出策略
- 背景：当前测试和调用方可能通过 `ai-organ-logic` 或 `RuntimeSnapshots` 深路径导入 safepoint API。
- 需要决定：迁移后是否保留兼容导出。
- 选项：
  - A) 保留薄 re-export/adapter，后续 track 再删除
  - B) 本 track 一次性更新所有调用方并删除旧路径
  - C) 只保留旧路径，新包不直接对外导出 safepoint API
- 当前建议：B
- 用户答复：本 track 不保留旧 safepoint shim、兼容 re-export 或 adapter。
- 最终决策：B
- 决策理由：B 避免形成第二个 API surface，符合 proposal、design、plan 与 spec delta 对 package name import 和单一事实来源的约束。
- 状态：accepted
