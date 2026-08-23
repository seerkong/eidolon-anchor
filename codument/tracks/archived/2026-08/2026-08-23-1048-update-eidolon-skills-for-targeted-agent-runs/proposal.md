# 变更：更新 Eidolon Skills 以指导 typed 与 targeted Agent 运行

## 背景和动机 (Context And Why)

Eidolon 的 authored Ctrl/Data runtime 已从通用 `effects.invoke` envelope 迁移到 depa 标准的 runtime-first `runAgent` / `runTargetedAgent`。当前 Authoring 与 Run Skills 仍展示旧 `ai.agent` envelope，且没有说明 `{ byInstanceName }`、`{ byInstanceId }`、返回 instance identity、flow checkpoint `profile.ai` 与 fresh recovery 的真实关系。模型继续读取旧说明会生成不能通过 publication proof 的代码，或把 Agent actor/session state 错写进 workflow checkpoint。

## “要做”和“不做” (Goals / Non-Goals)

**目标:**

- 从精确安装的 `ai-workflow-flow-dsl-reference@0.1.2` 继续生成完整 Flow DSL references，不手工复制标准正文。
- 更新 Authoring operation，使用 Processor 公式 `output = fn(runtime, input, config)` 与 `output = fn(runtime, selector, invocation, config)`，生成 direct `runtime.ai.effects.runAgent` / `runTargetedAgent` 调用。
- 更新 Run operation，说明通过返回的 instance id 或同 run 唯一的 authored instance name 复用 generic runtime-owned Agent actor/session。
- 冻结 selector 的 exact closed shape、checkpoint/actor authority 边界、Ctrl/Data ordinary-node 用法和渐进加载顺序。
- 递增受影响 SkillCapsule 的末端最小版本，重新生成单一 Halfcode distribution plan，并更新 global Skills。

**非目标:**

- 不修改 depa runtime API、selector schema、generic actor lifecycle 或 workflow persistence。
- 不创建 host 侧 selector/场景/标签语义表。
- 不把 actor history、provider facts、conversation 或 compaction 写入 flow checkpoint。
- 不发布 npm 包，不修改 npmrc，不指定 registry。
- 不提前实施后续 StepSpace/state-sidecar 优化。

## 变更内容（What Changes）

- 修订 Authoring `agent-definition` 与索引/阶段协议，删除 authored Agent generic invoke 示例。
- 修订 Run `agent-execution` 与索引/阶段协议，加入创建、by-name、by-id、恢复与返回 identity 的精确流程。
- 保持 Flow DSL reference 由发布模块机械映射，补 source/dist/installed bytes 与 provenance 验证。
- 递增 Authoring、Run 与依赖它们的 DevOps SkillCapsule patch 版本，重新生成计划并执行隔离 global init/readback。

## 影响范围（Impact）

- 行为：`eidolon-ai-workflow-native-capability`
- 代码/资源：`cell/packages/ai-support/src/system-skill/resource-package/**`
- 生成物：`cell/packages/ai-support/src/system-skill/generated/**`
- 测试：system Skill plan、installer、workflow product/architecture/physical fixture suites
