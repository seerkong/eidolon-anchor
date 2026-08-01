# Spec: add-ai-domain-observability

## 概述

基于 depa-data-graph 的 `GraphMiddleware` + `StreamGraph` + `GraphBridge`，以及 depa-actor 的 `OrchestratorState`，为 eidolon-anchor 的 AI coding agent 执行路径添加可观测性、trace、eval 三层基础设施。

## 背景

当前 eidolon-anchor 的 `TuiA1StateGraph` 使用 `DataGraph` + `AppendOnlyEventLog` + `ReducerProjection` 管理 TUI 状态，但未使用 middleware、StreamGraph、GraphBridge 等已有基础设施。AI agent 执行过程中缺少：
- 结构化的 provider 诊断事件
- 可持久化和回放的 session trace
- 用于 CI/自动化评估的 scene replay 能力

所有需要的原语已存在于 depa-data-graph 和 depa-actor 中，核心工作是集成。

---

## 功能需求

### Requirement: GraphMiddleware 拦截所有 DataGraph 读写

#### Scenario: 拦截 get 操作
- **Given** DataGraph 已注册 TraceMiddleware
- **When** 任何代码通过 `graph.get()` 或 `ctx.get()` 读取节点值
- **Then** TraceMiddleware 的 `beforeGet` 回调被触发，记录 `{phase: "before", op: "get", nodeId, ts}`

#### Scenario: 拦截 set 操作
- **Given** DataGraph 已注册 TraceMiddleware
- **When** 任何代码通过 `graph.set()` 或 `ctx.set()` 写入节点值
- **Then** TraceMiddleware 的 `afterSet` 回调被触发，记录 `{phase: "after", op: "set", nodeId, ts}`

#### Scenario: 拦截 batch 操作
- **Given** DataGraph 已注册 TraceMiddleware
- **When** 通过 `graph.batch()` 执行批量操作
- **Then** `onBatch` 回调分别在 batch 开始和结束时触发

#### Scenario: 可选过滤器
- **Given** TraceMiddleware 配置了 `filter` 函数
- **When** 读写的 nodeId 不匹配 filter
- **Then** 该操作不被记录

### Requirement: StreamGraph 诊断管线

#### Scenario: trace 事件流入 StreamGraph
- **Given** TraceMiddleware 产生 trace 记录
- **When** trace 记录被推入 StreamGraph 的 `trace.raw` source
- **Then** 下游 operator 可对 trace 进行聚合、分组、过滤

#### Scenario: 按节点分组统计
- **Given** StreamGraph 中已定义 `trace.byNode` operator
- **When** 多个 trace 记录流入
- **Then** `trace.byNode` 输出按 nodeId 分组的记录映射

#### Scenario: 全局统计
- **Given** StreamGraph 中已定义 `trace.stats` operator
- **When** trace 记录流入
- **Then** `trace.stats` 输出 `{totalEvents, byOp, byNode}` 统计摘要

### Requirement: Provider Diagnostic Collector

#### Scenario: 记录 model_selection 事件
- **Given** agent 执行过程中选择了模型
- **When** 模型选择完成（含 fallback 链、attempted_models）
- **Then** `diag.modelSelection` signal 追加一条 `ModelSelectionRecord`

#### Scenario: 记录 continuation_state
- **Given** agent 执行跨 turn 续接
- **When** 续接完成
- **Then** `diag.continuation` signal 更新为 `{responseId, epoch, mode}`

#### Scenario: 记录 turn timing
- **Given** 每个 agent turn 有多个阶段
- **When** 阶段切换（request_send → progress → response_receive → response_completed）
- **Then** `diag.turnTimings` signal 追加带有各阶段时间戳的记录

#### Scenario: 记录 compaction 决策
- **Given** agent 触发 context compaction
- **When** compaction 执行完成
- **Then** `diag.compactions` signal 追加 `{protectedCategories, rewrittenCategories, skipReason}`

#### Scenario: 记录 tool_call 统计
- **Given** agent 执行了 tool calls
- **When** turn 结束
- **Then** `diag.toolStats` signal 更新为 `{starts, ok, error, byTool}`

#### Scenario: 记录 retry 事件
- **Given** provider 请求失败并触发重试
- **When** 重试发生或耗尽
- **Then** `diag.retries` signal 记录 `{classificationReason, classificationLayer, attemptNumber}`

### Requirement: Session Trace 持久化

#### Scenario: 内存模式
- **Given** trace 配置 `mode: "memory"`
- **When** session 运行中
- **Then** 所有 trace 记录保留在内存 AppendOnlyEventLog 中，session 结束时丢弃

#### Scenario: JSONL 文件导出模式
- **Given** trace 配置 `mode: "file"`
- **When** 每个 turn 结束
- **Then** 该 turn 的 trace 记录追加写入 JSONL 文件

#### Scenario: 全量 session 导出
- **Given** session 结束
- **When** 调用导出
- **Then** 完整的 trace JSONL 文件生成，每行一个 TraceRecord

### Requirement: Scene Replay（eval 基础设施）

#### Scenario: 录制 scene
- **Given** 一个 agent turn 正在执行
- **When** turn 完成
- **Then** 该 turn 的完整 scene（messages + systemPrompt + tools + providerEventSlice）被持久化

#### Scenario: CLI 触发 recorded 回放
- **Given** 存在已录制的 scene 文件
- **When** 运行 `eidolon replay --scene <path> --mode recorded`
- **Then** 基于 depa-actor OrchestratorState 确定性重放 provider 事件序列，输出回放结果

#### Scenario: CLI 触发 live contract revalidation
- **Given** 存在已录制的 scene 文件
- **When** 运行 `eidolon replay --scene <path> --mode live`
- **Then** 真实调用 LLM 重新执行该 turn，对比 response 差异

#### Scenario: 回放超时控制
- **Given** scene replay 正在执行
- **When** 超过配置的 timeout
- **Then** 回放被终止，输出超时诊断信息

### Requirement: 补全已有原语

#### Scenario: Graph 完整性校验
- **Given** DataGraph 在开发模式下
- **When** 每次 dispatch 后
- **Then** `graph.validate()` 检查 cycle 和 missing deps

#### Scenario: Deps 审计
- **Given** DataGraph 在开发模式下
- **When** computed/processor/consumer 读取未声明的依赖
- **Then** console.warn 输出警告

#### Scenario: Graph 快照导出
- **Given** 开发者需要调试
- **When** 调用 `graph.snapshot()`
- **Then** 返回包含所有节点值、边、版本的完整快照

#### Scenario: Logger 插件
- **Given** DataGraph 注册了 loggerPlugin
- **When** 任何 signal 值变更
- **Then** console 输出变更记录（dev mode only）

---

## 非功能需求

- **性能**：TraceMiddleware 不应显著影响 DataGraph 读写性能（每次记录应 <1ms）
- **内存**：内存模式下 trace 保留上限可配置（默认每个 session 最多 10000 条记录）
- **兼容性**：不改变现有 `TuiA1StateGraph` 的公开 API，通过 middleware 非侵入式挂载
- **可测试性**：所有 diagnostic collector 和 scene replay 逻辑应可独立单元测试

## 验收标准

1. 在 DataGraph 上注册 TraceMiddleware 后，每个 get/set/batch 操作均产生结构化 trace 记录
2. StreamGraph 诊断管线可实时输出按节点分组和全局统计
3. Provider diagnostic signals（model_selection / continuation / turnTiming / compaction / toolStats / retries）在 agent 执行过程中正确填充
4. JSONL 文件导出模式在 turn 结束后生成有效的 trace 文件
5. `eidolon replay --scene <path>` CLI 命令可成功执行确定性回放
6. 现有 TUI 功能在集成后无回归

## 范围外

- UI/表现层的可观测性（本次仅 agent domain）
- agent-teams / 多 agent 协作的可观测性
- 远程 trace 上报（如 OpenTelemetry 集成）
- 实时 trace 可视化 dashboard
