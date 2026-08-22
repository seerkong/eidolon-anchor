# Proposal：拆分 Eidolon Anchor DevOps、Authoring 与 Run 系统 Skill

## 背景

`eidolon global init` 已具备 Halfcode plan 消费、manifest-bound readback 与整棵 `skills` root transaction，但内容仍处于过渡态：源码中的 `BUNDLED_SYSTEM_SKILLS` 逐文件内嵌 `sys-ai-workflow@1.0.7`，其中同时混合 DevOps 路由、authoring、run 与一份手工 Flow DSL 副本；installer 再把这项 builtin 和 Halfcode 单根计划拼成 managed set。

两个外部前置已经发布：

- `halfcode-compiler.xnl@0.2.3` 提供 package-contained Resource DSL authoring module、`sys-halfcode-resource-dsl` SkillCapsule、ApplicationAssembly 与完整 Skill distribution API；
- `ai-workflow-flow-dsl-reference@0.1.0` 提供由 depa canonical `docs/flow-dsl` 生成的 29 个 WikiPage reference resources，不包含第五个 SkillCapsule。

因此可以完成最终迁移：Eidolon 只声明三个 host-owned SkillCapsule，让 Halfcode 对三个 modules 生成一个 dependency closure，并让现有 host transaction 安装这一份计划。

## 目标

安装后的唯一 system Skill 集合为：

1. `sys-halfcode-resource-dsl@1.0.0`；
2. `sys-eidolon-anchor-authoring@1.0.0`；
3. `sys-eidolon-anchor-run@1.0.0`；
4. `sys-eidolon-anchor-devops@1.0.0`。

Dependency 由 SkillCapsule XNL 显式声明：DevOps 依赖 Authoring 与 Run；Authoring 依赖 Halfcode Resource DSL。Authoring 通过 ResourceMappings 从 depa module 生成 `references/flow-dsl/**`，不在 Eidolon 维护文档副本。

## 范围

- 创建 Eidolon-owned ResourcePackage build input，包含 DevOps、Authoring、Run 三枚 SkillCapsule。
- 组合两个 published modules，生成并校验一份 deterministic、可离线 hydrate 的四 Skill plan。
- 让 global init 只消费这份 complete plan，成功后退出旧 `sys-ai-workflow` 与 builtin catalog。
- 迁移 workflow actor、stage loader、kernel/agent/tool prompt 的 system authority identity。
- 把 `Skill` 工具扩展为 exact resource + line fragment 加载，复用通用 context resource revision/visibility 机制。
- Authoring 与 Run 使用 `operations/`；DevOps 保持生命周期 stage 目录。
- 验证 source runtime 与真实 compiled `eidolon global init`。

## 不在范围

- 不改变 Halfcode ResourcePackage、SkillCapsule、dependency planner 或 applier contract。
- 不改变 depa Flow DSL 或 AI workflow resource domain contract。
- 不新增 workflow-specific resource loader、context compressor、actor/session/runtime。
- 不在此 track 执行真实 provider 的自然语言 create→publish→run；该 journey 属于 mission 后续 acceptance track。
- 不保留旧 identity alias、symlink 或 compatibility Skill，因为它们会形成双 authority。

## 成功判据

- 一份 Halfcode plan 对四个 exact identities、versions、edges、files、digests 与 provenance 负责。
- global init 幂等安装四项、保留普通用户 Skill、失败恢复上一完整树、成功移除旧单体 Skill。
- DevOps 只做生命周期路由；Authoring/Run 职责和 operations 分离。
- Flow DSL references 来自 published depa module，完整路径/bytes/digest/provenance 一致。
- `Skill` 按 exact declared resource 渐进加载，coding 初始 context 不再全量注入 29 篇 reference。
- 生产代码没有自然语言 regex/keyword/substring/ordered heuristic，也没有第二套 topology/content compiler。
