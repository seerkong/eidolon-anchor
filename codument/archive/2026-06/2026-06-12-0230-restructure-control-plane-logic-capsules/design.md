# 设计：控制面三集群 Capsule 重构

## 上下文

前置 track 已交付：boundary declaration（core logic 入口、注入 effect contracts、入口分类、forbiddenDirectIo）、五个 conformance 套件、三集群源码零改动的验证基线。本 track 是既定两步走的第二步：在该保护层下做完整结构重构。

两个外部经验模式已蒸馏进 `analysis/knowledge.md`：capsule（封装形态）与 derivation contract（数据图加工定义进 contract、流转布线通用化）。

## 方案概览

### 1. Capsule 形态（本仓库适配版）

每个集群一个 capsule 目录，位于其 logic 包内：

```text
<package>/src/<capsule>/
  coreLogic.ts        — 唯一稳定入口：output = fn(runtime, input, config)
  adapterRegistry.ts  — 枚举 id → adapter 注册与解析
  adapters/           — 按适配轴分目录（effect 派发、持久化、信号 sink、恢复源……）
  internals/          — 私有 helper，禁止外部 import
```

与参考模式的差异（用户决策）：**不含 types/ 部分**。input/output/config/state 类型全部定义在对应 contract 包（platform-contract / ai-core-contract / ai-runtime-control-contract），logic 包只 import 不复制。

与参考模式的第二处包级分离（与 spec delta capsule-structure 陈述一致）：adapter registry 只对存在适配轴的集群要求；adapter **实现**可由 support/composer 包在组装时注册（与类型留在 contract 包同理），此时 capsule 目录内可以没有 `adapters/` 子目录；当前无适配轴的集群（orchestrator）省略 registry。

config 规则：强类型；只放 adapter 枚举 id 与少量静态策略；不放函数对象；不重复 runtime 已有字段。调用方只传 `(runtime, input, config)`。

### 2. Derivation Contract

contract 侧（按宿主分层惯例：通用断言机制在 platform-contract，三集群具体 derivation 类型在 ai-core-contract / ai-runtime-control-contract）：

- 类型化 state 形状与 event/command union（engine 的已存在于 ai-runtime-control-contract，补缺即可）。
- 每集群一个 derivation contract：必需方法集合 + `assert*DerivationContract` 运行时断言（缺方法时报出方法名）。
  - EngineCommandDerivation：initialize / reduce（command → state + effects intent）/ selectNext / classifyRecovery。
  - SchedulerDerivation：initialize / reduceFiberEvent / projectSchedulerSignal。
  - CoordinatorDerivation：evaluateSafepoint 消费 / decideCheckpoint / decideRecovery。

logic 侧：derivation 实现为显式 state 上的纯函数；经流转布线注入。

流转布线：**先盘点 depa-data-graph / depa-actor 既有原语**（stream、signal、reducer projection、mailbox）能否直接承载 reduce→{state,effects}→project 的循环；只有缺失时才在 platform 侧加薄 glue（类型 + 断言形态，不是平行 store）。盘点结论记入 analysis 后才允许写 glue（P1 任务）。

### 3. 三集群重构落位

| 集群 | capsule 位置 | 重构要点 | 风险 |
|------|--------------|----------|------|
| runtime_control_engine | ai-runtime-control-logic/src/engineCapsule/ | 现有纯 reducer 平移为 coreLogic + derivation 实现；ports 适配轴入 adapterRegistry；support 侧文件实现注册为 adapters | 低 |
| snapshot_coordinator | ai-runtime-control-composer/src/coordinatorCapsule/ | 决策 derivation（checkpoint 闸门、恢复决定）入 coreLogic；writer 经 adapter registry 以 file_store 枚举 id 在 composer 注册（writer 只持久化）；RuntimeSnapshots.ts 的保存闸门改走 coordinatorDerivation；恢复重建保持 outer（persistence backplane 迁移为非目标，归后续 track） | 中 |
| orchestrator_driver | ai-organ-logic/src/orchestratorCapsule/ | 调度状态机为 SchedulerDerivation 纯实现；mailbox 驱动、tick 循环为 outer；scheduler signal 投影经 derivation project；detached/childDone 记账入 internals；现有 createAiAgentOrchestratorDriver* 保留为兼容出口 | 高 |

顺序按风险递增：engine → coordinator → driver。每个集群重构完成即跑全部前置 conformance + 失败基线对照（stash 对照法），不绿不进入下一集群。

### 4. 兼容出口与映射更新

- 既有公开导出（如 `createAiAgentOrchestratorDriverWithCooperative`、`saveAiAgentRuntimeSnapshot`、engine 函数）保留原名，从 capsule 内部 re-export 或薄包装；调用方（executor、TerminalRuntime、composer 消费者）零改动或最小改动。
- boundary declaration 的 coreLogicEntries/outerAdapterSurface 与 encapsulation conformance 的 CLUSTER_SOURCES 映射随文件移动同步更新——映射更新与文件移动必须在同一任务内完成。

### 5. AiRuntimeTurnSupervisor 处置（前提修正）

实施中证实 supervisor 已接线进 TerminalRuntime 的 live turn 主路径（hint 注入 + 最多 3 轮强制 continuation），删除属于行为变更，与本 track 行为保持原则冲突。本 track 不删除、不扩展；其移除作为 refactor-ai-turn-tool-provider-lifecycle 的显式输入（详见 decisions.md 决策 3）。

### 6. 验证策略

- 每阶段：包内测试 + 前置 conformance 五套件全绿。
- 失败基线对照：重构前后以干净基线对照（已知 ai-organ-logic ~12、terminal/organ 15 为 HEAD 既有失败），失败集合必须是基线子集。
- 新增 capsule 结构 conformance：internals 不被外部 import、types 不在 logic 包重复定义、adapter 经 registry 解析（源码级断言，沿用既有模式）。
- derivation 断言的负向测试：缺方法的实现注入即报错。

## 影响范围与修改点（Impact）

见 proposal.md Impact 一节。

## 决策摘要

- 详见 `decisions.md`。当前关键结论：
  - capsule 完整采用但去掉 types 部分；类型只在 contract 包（用户决策，accepted）。
  - 三集群 reducer/projection 全部采用 derivation contract（用户决策，accepted）。
  - AiRuntimeTurnSupervisor 前提修正后保留并冻结，移除归入 refactor-ai-turn-tool-provider-lifecycle（用户重确认，accepted，见决策 3 与第 5 节）。
  - 流转布线 vendor 原语优先，盘点先行、glue 后置（原则，accepted）。
  - capsule 文件命名采用本仓库 camelCase 惯例：`coreLogic.ts`、`adapterRegistry.ts`。

## 风险 / 权衡

- 风险：driver 单文件 2000 行拆分引入回归。
  - 缓解：放在最后阶段；每步基线对照；行为保持闸门（conformance + 失败集合子集）不绿不前进；保留兼容出口。
- 风险：derivation contract 过度抽象、流转 glue 演变成平行框架。
  - 缓解：P1 强制盘点任务先行；spec case flow-wiring-reuses-primitives 源码级断言禁止本地平行框架。
- 风险：conformance 源码映射漏更新导致断言空转。
  - 缓解：映射更新与文件移动同任务；encapsulation 测试对缺失符号响亮失败（前置 track 已验证该性质）。
- 风险：跨包移动（RuntimeSnapshots 切分）影响依赖方。
  - 缓解：原导出保留为兼容出口；gap-loop 复检导出面。

## 待解决问题

- depa-data-graph 是否足以承载 derivation 流转布线（P1 盘点任务回答，结论记 analysis）。
