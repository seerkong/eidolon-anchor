# 变更：替换并升级 ApplyPatch Tool

## 背景和动机 (Context And Why)

本项目已有 `ApplyPatch` tool，但当前实现更接近基础 patch applicator：`@@` 只作为 hunk 起始标记而非真实 anchor，匹配策略主要依赖 exact block，文件写入缺少 staged validation 与防覆盖/重复路径等保护，也没有完整的 agent 上下文刷新机制。

其他项目中的 `apply_patch` 已实现更完整的 coding-agent 文件编辑生命周期：真实 anchors、分层匹配、失败诊断、staged writes、权限/路径治理、read freshness 和结构化输出。为了让本项目 coding agent 的文本编辑更安全、更稳定，需要用该机制替换本项目旧版 ApplyPatch，并迁移相关配套机制。

## “要做”和“不做” (Goals / Non-Goals)

**目标:**
- 替换/升级本项目现有 `ApplyPatch` 实现，使其具备 apply_patch 能力。
- 迁移真实 `@@` named anchors 与连续 anchors 定位语义。
- 迁移 exact / anchored_exact / normalized / fuzzy 的安全匹配阶梯，歧义时 fail-closed。
- 迁移 staged writes/deletes、防覆盖、防重复路径、目录防护等文件落地保护。
- 对齐本项目现有路径解析与权限 gate，避免绕开本地权限治理。
- 保留旧版 unified diff 输出兼容，同时新增 touched files、counts、match modes、refresh hint 等结构化元数据。
- 迁移或适配 read freshness / 写后 context refresh 机制；若本项目缺少完整 read cache，则实现最小可行适配并记录边界。
- 更新 ApplyPatch tool detail 和相关 coding prompt，使 agent 默认 patch-first 编辑。
- 增加针对 parser、matcher、guard、output、权限/上下文集成的测试。

**非目标:**
- 不重写所有文件编辑工具；`Read/Edit/Write/Bash` 只做 ApplyPatch 所需的最小集成。
- 不改变整个 actor orchestration 或权限模型。
- 不引入不必要的新外部依赖。
- 不移除本项目用户已确认需要保留的 unified diff 兼容能力。

## 变更内容（What Changes）

- 替换 `cell/packages/ai-organ-logic/src/composer/AIAgent/tools/ApplyPatch/Logic.ts` 的核心 patch parser/matcher/apply 流程。
- 更新 `ApplyPatch` 的输入/输出兼容策略：继续接受当前 tool contract，同时在输出 payload 中加入metadata。
- 新增或迁移数据结构：patch operations、patch hunks、anchors、match modes、staged write/delete plan。
- 增强失败输出：hunk label、expected snippet、nearest current line、retry hint、结构化 error/detail/suggestions。
- 增强文件安全：existing target guard、directory guard、duplicate resolved path guard、move destination guard。
- 集成本项目路径解析和 `authorizeLocalToolCall` 权限检查。
- 迁移或适配 read freshness/context refresh 相关机制，并确保写后提示 stale context。
- 更新 `Tool.detail.xnl` / `Tool.brief.xnl` 或相关 prompt 资产，明确 patch-first 使用方式。
- 增加测试覆盖，确保旧行为兼容与新机制生效。

## 影响范围（Impact）

- 受影响的功能规范：coding agent 文件编辑、ApplyPatch tool、文件修改权限与输出契约。
- 关键代码区域：
  - `cell/packages/ai-organ-logic/src/composer/AIAgent/tools/ApplyPatch/`
  - `cell/packages/ai-organ-logic/src/composer/AIAgent/tools/_file-editing.ts`
  - 可能涉及本项目 read/cache/context refresh 相关 runtime 文件
  - ApplyPatch 相关 tests / prompt asset 生成或 bundling 机制
