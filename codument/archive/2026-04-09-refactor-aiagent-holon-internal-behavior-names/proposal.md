# 变更：将 AIAgent 内部 `collective / formation` 行为名收口到 holon 内部模型

## 背景和动机 (Context And Why)

当前 AIAgent 的正式对象模型、正式命令面、正式工具族与正式文档已经完成 `member / holon / primary` 收口。但实现内部仍残留一批 `collective / formation` 命名，它们不再代表正式 surface，却仍出现在：

- runtime signal store
- envelope / assign core / manager API
- controller / task runner / visible internal event stream
- internal-only legacy tool family 的适配边界

这些名字继续存在会带来两类问题：

1. 新正式模型与内部实现心智不一致，阅读与维护成本高。
2. 后续如果继续做 holon 扩展，旧命名会把“组织类型”和“治理差异”重新耦合回实现层。

因此，本变更的目标是把内部实现名继续收口到 `holon + governance` 心智，同时明确哪些内部概念暂时保留，不在本轮一并改动。

## “要做”和“不做” (Goals / Non-Goals)

**目标:**
- 将 runtime 内部组织行为分支的主要命名改为以 `holon` 或 `governance` 为中心
- 将 manager / runner / controller / signal / envelope / assign core 中仍作为主实现路径的旧命名继续收口
- 将默认实现与默认测试基线不再依赖 `collective / formation` 术语
- 将 legacy internal-only alias 的边界显式收紧到兼容层
- 明确哪些旧名本轮保留，例如 lane/workload 或 task-tree 历史协议

**非目标:**
- 不再次修改正式 slash surface、正式工具族或正式文档 contract
- 不引入新的组织能力，例如 holon 嵌套、governance 扩展或新调度模型
- 不承诺删除所有 legacy alias；若仍需要兼容边界，可保留在明确的 adapter 层
- 不在没有充分收益的情况下强行重命名底层调度 lane 常量

## 变更内容（What Changes）

- 将主实现路径中的 `collective / formation` 行为名继续改写为 `holon + governance` 命名
- 将 `OrganizationManager` 中仍以旧组织名表达主意图的方法补齐为 holon-first API，并推动调用方切换
- 将 `collectiveTaskSignals` / `formationRouteSignals` 这类 runtime signal store 评估并改为 governance-explicit 命名
- 将 `collectiveEnvelope.ts` / `formationEnvelope.ts` 与对应 assign core、result/route protocol 评估并重命名到 holon 内部协议语义
- 将 `RuntimeCollectiveController`、`CollectiveTaskRunner` 等运行时组件评估并改名，使其职责更贴近 autonomous holon
- 为 `AI_AGENT_LANES.collective`、`AI_AGENT_WORKLOADS.collectiveTask`、`activeForm` 前缀等暂保留项给出明确边界说明

## 影响范围（Impact）

- 受影响的功能规范：
  - AIAgent organization model
  - AIAgent fiber orchestration
  - runtime persistence / recovery 的内部真相命名

- 受影响的代码与资产：
  - `cell/packages/core-logic/src/runtime/*`
  - `cell/packages/organ-logic/src/organization/*`
  - `cell/packages/organ-logic/src/exec/AiAgentExecutor.ts`
  - `cell/packages/organ-logic/src/composer/AIAgent/tools/_collectiveAssignCore.ts`
  - `cell/packages/organ-logic/src/composer/AIAgent/tools/_formationAssignCore.ts`
  - `cell/packages/organ-logic/src/composer/AIAgent/tools/Collective*`
  - `cell/packages/organ-logic/src/composer/AIAgent/tools/Formation*`
  - `cell/packages/organ-logic/tests/AIAgent/*`
  - `.theater/actor/2026-04-09-collective-formation-rename-readiness-report.md`
