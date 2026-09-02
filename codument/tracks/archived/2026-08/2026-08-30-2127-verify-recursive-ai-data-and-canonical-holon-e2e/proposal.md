# 变更：验证递归 AI Data 与 canonical Holon 产品闭环

## 背景和动机 (Context And Why)

前序 Track 已分别实现 AI Data 的自主 SubFlow、Halfcode `AIAgentDefinition` authoring/selection、canonical Holon TaskSpace pump，以及旧 VM autonomous Holon runtime 的退役。当前测试能分别证明这些局部能力，但 Mission 的最终成功条件要求它们在 Eidolon 产品边界内组成可恢复的 Ctrl/Data 旅程，而不是把若干单元测试的通过误当成系统闭环。

## “要做”和“不做” (Goals / Non-Goals)

目标：

- 建立一份可重复运行的 Ctrl/Data 产品 E2E 矩阵，覆盖递归 SubFlow、动态 Worker resource、canonical Holon 多任务、失败恢复、fresh reconstruction、显式 organization replan 与父 Flow 消费。
- 每条证据都回指 exact definition/instance/run/checkpoint、Halfcode authoring/freeze receipt、TaskSpace subscription/settlement receipt，而不是用调用次数或内存状态代替。
- 验证测试不逐任务调用 `holon-process`，不预写模型应当提出的 graph patch、definition selection 或 definition authority。
- 修复当前代码上由综合旅程暴露的 wiring、恢复或幂等缺口。

非目标：

- 不引入 `GoalGraph`、第二份 Mission graph 或第二个 writable task authority。
- 不把 Capability Catalog 扩展为动态真相源。
- 不重新引入 VM autonomous Holon task board、runner 或 compatibility writer。
- 不要求本 Track 使用真实外部 provider；测试以确定性的 provider boundary 验证产品生命周期，真实模型成本/缓存仍由 provider 专项矩阵负责。

## 变更内容（What Changes）

- 新增一组面向当前源码的产品矩阵/receipt 断言，并复用既有资源 fixture 与 runtime public surface。
- 补齐 AI Data parent/child run 与自主 Worker resource 在 fresh runtime 中的组合证据。
- 补齐 Ctrl/Data canonical Holon 多任务、失败窗口、replan 和最终消费的对称证据。
- 发现真实产品缺口时修改最小 production owner，并追加针对性回归。

## 影响范围（Impact）

- 受影响能力：`eidolon-complete-agent-ctrl-data-e2e`
- 主要测试：`cell/packages/ai-organ-logic/tests/workflow/`
- 可能受影响代码：`WorkflowRuntimeService`、AI Data runtime driver、Halfcode resource host、Holon TaskSpace pump/coordinator/effect provider
