# Decisions

## Usage
- 用于记录需要用户确认的决策问题、选项、最终结论与理由
- 问题标题不用字母前缀；字母只用于选项
- 后续执行过程中出现的新决策，也继续追加到本文件，不新建分散的决策记录

### 1. 【P0】迁移范围
- 背景：用户明确要求不仅迁移 apply patch 本体，也迁移和 apply patch 之外相关的机制；前置问卷中用户未逐项选择 migration_scope，只回复“同意”。
- 需要决定：哪些机制纳入本 Track。
- 选项：
  - A) 全量迁移：真实 anchors、匹配回退、失败诊断、staged writes、防覆盖/重复路径/目录防护、read freshness/context refresh、prompt contract、路径权限对齐、结构化输出。
  - B) 核心迁移：只迁移 parser/matcher/staged writes/prompt，不做 read freshness/context refresh。
  - C) 最小迁移：只替换 parser/matcher，其他机制保持现状。
- 当前建议：A。
- 用户答复：同意。
- 最终决策：A，全量迁移；若实现阶段发现本项目缺少 read cache 基础设施，则做最小可行适配并在设计/实现记录边界。
- 决策理由：用户明确要求迁移 apply patch 之外的其他机制，且 apply_patch 的安全性依赖完整编辑生命周期。
- 状态：accepted

### 2. 【P0】成功输出兼容策略
- 背景：本项目旧 ApplyPatch 成功输出包含 unified diff
- 需要决定：替换后如何兼容旧调用方。
- 选项：
  - A) 保留现有 unified diff，同时新增结构化字段。
  - B) 改为风格结构化输出为主，不保证保留 diff。
  - C) 新字段为主，但提供兼容 wrapper/字段。
- 当前建议：A。
- 用户答复：A. 保留现有 unified diff，同时新增结构化字段。
- 最终决策：A。
- 决策理由：兼容风险最低，同时让 agent/runtime 获取 touched files、counts、match modes、refresh hint 等新信息。
- 状态：accepted

### 3. 【P0】提交与校验模式
- 背景：Track plan 需要记录 commit_mode 与 validation_mode。
- 需要决定：自动提交还是手动提交，以及 human-confirm 还是 gap-loop。
- 选项：
  - A) manual + yield-human-confirm。
  - B) manual + yield-gap-loop（仅最后 phase）。
  - C) auto + yield-gap-loop（仅最后 phase）。
  - D) auto + yield-human-confirm。
- 当前建议：B。
- 用户答复：B. manual + yield-gap-loop（仅最后 phase）。
- 最终决策：B，`commit_mode=manual`，`validation_mode=yield-gap-loop`，`validation_granularity=final_phase`。
- 决策理由：本仓库提交策略不明确，manual 更安全；最后 phase gap-loop 可在完成后做目标对比和缺口检查。
- 状态：accepted
