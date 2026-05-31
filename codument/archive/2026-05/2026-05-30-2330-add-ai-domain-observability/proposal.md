# 变更：为 AI Agent Domain 添加可观测性、Trace、Eval 基础设施

## 背景和动机 (Context And Why)

eidolon-anchor 的 AI coding agent 当前缺少结构化的可观测性设施：
- LLM 调用生命周期（model_selection → request → progress → response → completion）无统一诊断事件流
- 无可持久化的 session trace，问题排查依赖零散的 console.log
- 无 scene replay 能力，无法做回归测试和 contract validation

这些能力的缺失直接影响了 agent 行为的可调试性和持续质量保障。

**机会：** 所有需要的原语已存在于 depa-data-graph（GraphMiddleware / StreamGraph / GraphBridge）和 depa-actor（OrchestratorState），当前只需集成。

## “要做”和“不做” (Goals / Non-Goals)

**目标:**
- 为 DataGraph 添加 TraceMiddleware，拦截所有读写操作并产出结构化 trace 记录
- 建立 StreamGraph 诊断管线，实时聚合 trace 数据
- 建立 Provider Diagnostic Collector，覆盖 LLM 调用全生命周期
- 实现可配置的 Session Trace 持久化（内存 + JSONL 双模式）
- 实现基于 OrchestratorState 的 Scene Replay（CLI 命令，支持 recorded/live 双模式）
- 补全已有但未使用的原语（validate / depsAudit / snapshot / loggerPlugin）

**非目标:**
- 不涉及 UI 表现层的可观测性
- 不涉及 agent-teams / 多 agent 协作的可观测性
- 不引入新的第三方可观测性库（如 OpenTelemetry）
- 不构建实时 trace 可视化 dashboard

## 变更内容（What Changes）

- **新增** `terminal/packages/organ/src/observability/` — TraceMiddleware、DiagnosticPipeline、ProviderCollector、SessionTraceStore、SceneReplay
- **新增** CLI 命令 `eidolon replay` — Scene Replay 入口
- **修改** `terminal/packages/tui/src/app/tui_a1/graph.ts` — TuiA1StateGraph 注册 TraceMiddleware、persistPlugin、loggerPlugin
- **修改** `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts` — 在 AI agent 执行路径中挂载 Provider Diagnostic Collector
- **修改** `terminal/packages/tui/support/util/stream-diagnostics.ts` — 将零散的诊断调用迁移到统一 DiagnosticPipeline
- 无 **BREAKING** 变更，所有改动通过 middleware 和 plugin 非侵入式挂载

## 影响范围（Impact）

- 受影响的功能规范：AI Agent runtime 执行路径、TUI state graph
- 受影响的基础库：depa-data-graph-core（使用已有 API，无需修改库本身）
- 受影响的模块：
  - `terminal/packages/organ/` — 新增 observability 子模块
  - `terminal/packages/tui/` — graph.ts 添加 middleware 注册
  - `terminal/packages/organ/src/AIAgent/` — TerminalRuntime 添加 collector 挂载点
