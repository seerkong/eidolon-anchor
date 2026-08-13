# 变更：建立系统级 AI Workflow Skill

## 背景和动机 (Context And Why)

当前实现使用 TypeScript 正则和关键词表理解用户业务语义，并在模型运行前决定 workflow warrant、scenario、form、starting fact、发布和执行倾向。这让确定性 coordinator 冒充了 AI authoring authority，也导致真实研究请求被误路由为 composite approval workflow。与此同时，workflow 提示词分散且以通用 Code Agent 的 user message 形式注入，不是稳定的系统产品能力。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**

- 通过 `eidolon global init` 在 global Eidolon 目录（默认 `~/.eidolon`）初始化或原子替换受管系统 Skills，并在 `skills/sys-ai-workflow` 建立 AI Workflow Skill 真源；同一入口可随产品版本增加更多系统 Skills。
- 由专属 workflow actor + Skill 理解自然语言、选择 native tools、选择 workflow form/starting fact 并写 workspace。
- 删除代码中的自然语言模糊匹配和 heuristic semantic routing。
- 清晰分离 authoring/edit 与 prepare/run 两个产品交互阶段。
- 按 DevOps 生命周期组织全部提示词和知识；将 canonical flow DSL 骨架和 AI Workflow 特有 authoring 知识放入 `coding/flow-dsl`。
- 保持 WorkflowComponent 对结构化校验、proof、publication、runtime 和资源 transition 的 authority。

**非目标:**

- 不在 Eidolon 中实现平行的 flow DSL parser、validator 或 runtime。
- 不把 canonical depa-flows authority 复制成第二套代码规则。
- 不允许普通用户直接选择内部节点、端口、FQN 或 XNL 细节。
- 本 track 不修复 provider/tool-stream/fiber 的底层可靠性问题；该范围由 `harden-ai-workflow-agent-runtime` 承担。

## 变更内容（What Changes）

- **BREAKING** 删除 `WorkflowExperienceCoordinator`/`WorkflowAuthoringIntent` 的代码级自然语言推断职责。
- 增加 `eidolon global init`、global system Skill manifest、安装/替换/升级/resolution 和版本契约；运行时只从 `<global-eidolon-dir>/skills/sys-ai-workflow` 读取产品提示词，workspace skill 不得覆盖同名 `sys-*` identity。
- 增加专属 workflow actor 与最小 native workflow tool policy；入口代码只传递原始请求、当前 stage 和确定性产品事实。
- 按 DevOps 生命周期组织 Skill：`planning/coding/building/testing/releasing/deploying/operating/monitoring` 是顶层 stage，`SKILL.md` 只做 lifecycle 路由，每个 stage 拥有自己的 system prompt、protocol 和 references。
- 将 depa-flows 的 L1 foundation → flow-core/EagerDataFlow/WorkCtrlFlow substrate → AI workflow profile 骨架按原 `foundation/std/spec` 结构裁剪后内嵌到 `coding/flow-dsl`，并加入 AI Workflow bundle、resource、runtime-fact 约束。
- 将 planning 到 monitoring 变成显式产品生命周期；definition revision、authoring layout、published artifact、instance binding、snapshot/RunGraph 和 monitoring evidence 不得互相冒充事实源。
- 增加 Skill 资源可达性、提示词装配、规范同步、静态禁 heuristic 和真实自然语言跨入口验收。

## 影响范围（Impact）

- 受影响的能力（behaviors）：`eidolon-ai-workflow-native-capability`
- 受影响的代码：AI kernel prompt/skill composition、AI Workflow authoring/prompts/tools、agent registry/tool policy、`eidolon global init`/global directory bootstrap、CLI/TUI workflow entry、相关 tests

## 执行授权

用户已要求通过 `codument-impl-mission` 按 mission 顺序实现新增 tracks，本 track 可直接激活执行。
