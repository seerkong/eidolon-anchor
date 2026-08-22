# 设计：Halfcode-backed system Skill distribution

## 上下文

现有 installer 把源码中的 `BUNDLED_SYSTEM_SKILLS` 逐个写入 `<global>/skills/<name>`，每个目录独立 swap，最后才写 `.system-skills.xnl`。这个顺序不是集合级 transaction：任一中间异常都可能留下部分新 Skill 与旧 manifest。

Halfcode 0.2.2 公开 `loadHalfcodeResourceDslSystemSkillPlan()` 和 `applySkillCapsuleDistributionPlan()`。当前 plan 的根 capsule 为 `Halfcode.ResourceDsl.Skill.System`，安装 identity 为 `sys-halfcode-resource-dsl@1.0.0`。计划自身拥有文件集合、closure digest、目标冲突与内容验证；Eidolon 只负责把经过验证的结果并入全局 Skill 树。

## Authority 边界

- Halfcode 拥有 SkillCapsule dependency closure、topology、target collision、planned bytes、content digest 和 isolated apply receipt。
- Eidolon 拥有 global root 解析、当前过渡期内建 Skill、普通用户资产保留、统一 manifest 以及整个 `skills` 根的 transaction。
- `.system-skills.xnl` 是已安装托管 Skill 集合的 readback，不是第二 compiler。每个 entry 来自内建 descriptor 或 Halfcode receipt，并绑定版本、来源、集合摘要和文件摘要。
- Runtime 只通过 exact manifest identity 和 exact relative file path 读取系统资源；不按名称片段、自然语言或目录发现决定 Skill 语义。

## 方案概览

### 1. 统一 managed-skill projection

定义内部 `ManagedSystemSkillProjection`：

- `name`、`version`、`source`；
- `skillDigest` 与稳定排序的 `files[{path,digest}]`；
- 可选 `capsuleFqn`、`apiVersion`、`closureDigest`，仅用于 Halfcode-generated Skill；
- materialization 已发生的候选目录，不携带 `~/.eidolon` 策略进入 Halfcode。

`sys-ai-workflow@1.0.7` 继续由当前 catalog 物化，但被投影到同一 read model。`sys-halfcode-resource-dsl` 的 identity 和版本只从 Halfcode plan/receipt 取得，不在 Eidolon 复制常量。

### 2. 隔离应用 Halfcode plan

Installer 在 global root 下创建同父临时工作目录，在其隔离 output root 调用 Halfcode applier。应用完成后必须核对：

- receipt closure digest 与 plan 一致；
- installed Skill identity、版本和文件集合与 plan projection 一致；
- 每个文件 readback digest 与 planned canonical bytes 一致；
- output 只包含 plan 声明的 targets。

Eidolon 不读取 Halfcode 源码、不复制 Resource DSL 文件、不自行排序 dependency graph。

### 3. 整棵 skills root transaction

候选目录是 `<global>/.skills.candidate-*`，与 live `<global>/skills` 同父：

1. 复制 live tree 中所有非托管资产，且不跟随符号链接；排除当前 manifest、已知托管 identities 与 installer 自己的临时/备份名。
2. 写入过渡期内建 Skill，并把验证后的 Halfcode output 合并到候选树。
3. 生成统一 `.system-skills.xnl`，其中每个 entry 绑定 exact identity、version、source、skill digest 与所有文件摘要。
4. 从候选树重新读取所有 manifest entries 和文件，验证 identity、path containment、文件数与摘要。
5. 先把 live root rename 到 backup，再把完整候选 root rename 为 live。若第二步未完成，恢复 backup；恢复本身异常时保留 backup 并报告两个状态，不能静默删除恢复证据。
6. live readback 成功后才删除 backup 和临时目录。

候选创建、Halfcode apply、候选 readback、live swap 和最终 readback 都设置可测试的受控中断点。任一中断发生在 commit 前，原 live tree 必须逐文件保持不变；commit 后 readback 异常则必须恢复原树或保留可诊断的 backup。

### 4. 通用 manifest-bound loader

新增通用系统 Skill resource/context seam：

- 读取 `.system-skills.xnl` 并按 exact name 找到 entry；
- 拒绝未登记 Skill、重复 identity、重复文件、unsafe path、版本或 digest 漂移；
- 只读取 entry 中登记的 exact relative paths，并验证内容摘要；
- 支持调用方显式传入 ordered resource paths，返回带来源 marker 的组合 context。

`loadAiWorkflowStageContext` 保留为兼容 wrapper：它仍选择 `sys-ai-workflow` 的结构化 stage 文件，并将实际读取委托给通用 loader。它不会替 Resource DSL Skill 发明 DevOps stage。

### 5. CLI 与重复执行

`eidolon global init --json` 返回稳定的 managed entries，包括 name/version/source/digest；文本输出列出所有 installed identities。对内容相同的现存树重复执行，最终树和 manifest bytes 必须相同，且不会改变用户 Skill。

## 影响范围与修改点（Impact）

- `cell/packages/ai-support/package.json`
- `cell/packages/ai-support/src/system-skill/SystemSkillInstaller.ts`
- `cell/packages/ai-support/src/system-skill/BundledSystemSkillCatalog.ts`
- `cell/packages/ai-support/tests/system_skill_installer.test.ts`
- `terminal/packages/cli/src/commands/global.ts`
- `terminal/packages/cli/tests/global-command.test.ts` 或等价现有入口测试

## 决策摘要

- Whole-root transaction 是 host 原子性边界；逐 Skill swap 不再是 production install path。
- Halfcode plan 先应用到隔离 output root，Eidolon 只消费验证后的结果。
- 现有 `sys-ai-workflow` 在本 track 作为过渡期内建来源保留，后续拆分 track 才移除。
- Generic loader 受统一 manifest 与文件摘要约束，不以硬编码 generated Skill inventory 作为读取 authority。

## 风险 / 权衡

- 整树复制会增加一次 global init 的 IO；该命令低频，换取集合级一致性更重要。
- 用户资产可能包含符号链接；候选复制保留链接本身且不跟随，避免读写 authority 逃逸。
- Host transaction 无法跨文件系统原子 rename；候选和 backup 必须与 live root 同父，启动前验证 device/rename 前提。
- 过渡期仍保留手写 `sys-ai-workflow`；后续内容迁移必须在另一 track 中以四 Skill 最终集合替换。

## 迁移计划

1. 加入依赖和边界基线用例。
2. 接入 Halfcode plan 并生成统一 managed projection。
3. 替换为 whole-root transaction，验证重复执行与恢复。
4. 接入 generic loader 与 CLI readback。
5. 后续 split track 生成 `sys-eidolon-anchor-*` 三个 Skill，并在一次 transaction 中退出 `sys-ai-workflow`。

## 待解决问题

无用户决策阻塞项；所有规划选择使用 mission 的 `QuestionSeverity=auto` 保守默认并记录在 `decisions.xnl`。
