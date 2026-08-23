# Design: targeted Agent authoring/run Skill update

## 上下文

Authoring/Run/DevOps 是 Eidolon-owned SkillCapsules，由本地 ResourcePackage 与 published Halfcode Resource DSL、published depa Flow DSL reference 组成一个 ApplicationAssembly。Halfcode plan 是安装内容、拓扑、digest 与 provenance 的唯一分发 authority。当前运行实现已支持 authentic frozen task proof、typed facade、closed selector、generic addressed actor/session 与 new-VM snapshot recovery；本 track 只更新模型可见的渐进式操作资源和生成计划。

## 方案概览

1. Authoring guidance
   - 保留 Processor runtime 第一个参数。
   - 非 targeted 形态只生成 `runtime.ai.effects.runAgent(input, config)`。
   - targeted 形态只生成 `runtime.ai.effects.runTargetedAgent(selector, invocation, config)`。
   - selector 仅为 `{ byInstanceName: string }` 或 `{ byInstanceId: string }`，两键互斥、非空；不展示 `{by,type}` 形态。
   - Ctrl `Run` 与 Data ordinary node 都通过同一个 typed binder；task tuple 与 MaterialBinding/AgentDefinition 必须精确一致。
2. Run guidance
   - 第一次调用可用 authored `instanceName` 建立同 run 唯一 alias，并保存返回 `instanceId`。
   - 后续不同节点可按 name 或 id targeting；成功结果携带 stable instance/session identity。
   - flow checkpoint 的 `profile.ai` 只保存 closed instance index、pending/completed receipts 与 opaque generic runtime refs；actor/conversation/provider state 由 generic runtime store 拥有。
   - pending、completed、fresh reconstruction 都依赖 frozen instance closure + canonical checkpoint + generic runtime snapshot，不依赖 child conversation history。
3. Reference 与 distribution
   - `references/flow-dsl/**` 继续由 `DepaFlowsFlowDslReference` module 的 ResourceMappings 生成；本仓不维护第二份标准正文。
   - Authoring `1.0.22→1.0.23`、Run `1.0.2→1.0.3`、DevOps `1.0.26→1.0.27`，DevOps dependency 同步精确版本。
   - generator 两次输出必须字节稳定；plan/readback 必须恰有既有四 Skill，且全量文件/closure digest 与 installed manifest 一致。
4. Admission 与验证
   - 静态扫描禁止 Authoring/Run/DevOps payload 重新出现 authored `operation: "ai.agent"` 或 public Agent `effects.invoke` 示例。
   - 物理 Ctrl/Data fixture 通过 TypeScript 与 publication proof；selector/name/id 与 instance/session continuity 使用现有真实 E2E。
   - 隔离 compiled `global init` 更新 managed Skills，同时保留 ordinary Skill；实际用户 global root 在全部门禁通过后再幂等更新。

## 影响范围与修改点（Impact）

- Authoring：`operations/agent-definition.md`、`operations/index.md` 与必要阶段协议。
- Run：`operations/agent-execution.md`、`operations/index.md` 与必要阶段协议。
- Skill identity：三个 SkillCapsule manifests 与 generated plan。
- Tests：`system_skill_split_plan.test.ts`、installer/global CLI、workflow architecture/product E2E。

## 决策摘要

- Flow DSL 内容 authority 是精确发布的 reference module；Eidolon 只映射和验证。
- Skill 只解释 typed public surface，不教授 generic runtime dispatch internals。
- Agent continuity authority 属于 generic runtime；Flow 只保存稳定 opaque refs 与 invocation receipts。
- 三个受影响 capsules 各自只做 patch 增量，DevOps 因 exact sibling dependencies 必须同步升级。

## 风险 / 权衡

- Skill prose 与 public types 漂移 → 用 authored fixture typecheck、publication AST proof 和静态门禁绑定。
- generated plan stale → canonical build 前 `generate:system-skills:check`，本 track额外重建并两次比对。
- reference 被手工复制 → source mapping/provenance/file bytes 三方验证。
- global update 中断 → 复用既有 whole-root transaction/readback；不新增安装 authority。

## 兼容性设计

- fixed non-Agent named helpers仍可内部使用 closed generic invoke；Agent authored API 只允许 named typed methods。
- ordinary user Skills 保留；旧 managed Skill tree只通过成功的 global init 整体替换。
- CLI/tool 名称与 ResourcePackage/instance/run 格式不变。
