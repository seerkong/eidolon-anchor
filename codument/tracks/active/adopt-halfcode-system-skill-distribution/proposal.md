# 变更：接入 Halfcode 系统 Skill 分发计划

## 背景和动机 (Context And Why)

`eidolon global init` 当前从 Eidolon 源码中的手写文件表逐个替换 `sys-ai-workflow`，然后单独写 `.system-skills.xnl`。这个流程无法消费 Halfcode 已发布的 SkillCapsule distribution plan，而且逐 Skill 替换会让运行时观察到新旧混合的系统 Skill 集合。

Halfcode 0.2.2 已发布 `sys-halfcode-resource-dsl@1.0.0` 的不可变 distribution plan。Eidolon 应复用该计划的 dependency、目标路径、内容摘要和闭包验证，只拥有全局目录绑定及整棵 `skills` 目录的 host transaction。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**

- 让 `eidolon global init` 安装当前过渡期 `sys-ai-workflow` 与 Halfcode 生成的 `sys-halfcode-resource-dsl`。
- 复用 Halfcode plan/apply 能力，不在 Eidolon 重写 Skill capsule dependency、拓扑、冲突或内容编译逻辑。
- 在候选树完整生成和验证后，一次替换整个 `<global>/skills`，保留普通用户 Skill 与其他非托管资产。
- 让 `.system-skills.xnl` 成为已安装托管 Skill 集合的结构化 readback，支持按 identity 和文件摘要读取系统 Skill 资源。
- 保持重复执行幂等，并在受控中断点发生异常时保留先前完整树。

**非目标:**

- 本 track 不拆分 `sys-ai-workflow` 内容，也不移除该过渡期 identity。
- 本 track 不创建 `sys-eidolon-anchor-devops`、`sys-eidolon-anchor-authoring` 或 `sys-eidolon-anchor-run`；它们属于后续迁移 track。
- 本 track 不改变 AI Workflow 的 stage 内容、`operations/` 目录或 sibling delegation。
- Halfcode 不拥有 `~/.eidolon` 路径、用户 Skill 保留策略或 host transaction。

## 变更内容（What Changes）

- 为 `@cell/ai-support` 精确增加 `halfcode-compiler.xnl@0.2.2`。
- 从 Halfcode 公开入口加载并在隔离目录应用 Resource DSL 系统 Skill plan。
- 建立统一 managed-skill projection 和带文件摘要的 `.system-skills.xnl`。
- 将逐 Skill 替换改为同父目录候选树、完整 readback、一次 live-root swap 和可恢复回滚。
- 增加通用、manifest-bound 的系统 Skill 资源读取/context loading seam，并保留 AI Workflow stage wrapper。
- 扩展 `eidolon global init` 结果，报告所有托管 identity、version、digest 与来源。

## 影响范围（Impact）

- 受影响的能力（behaviors）：`eidolon-system-skill-distribution`
- 受影响的代码：`@cell/ai-support` system-skill installer/catalog、global CLI、system Skill tests、package dependency resolution
- 兼容面：现有普通用户 Skill 保留；`sys-ai-workflow@1.0.7` 在本 track 中继续存在；workspace `sys-*` 仍不能覆盖 global authority
