# Design: add-ai-domain-observability

## 上下文

- **约束**：所有能力基于 depa-data-graph + depa-actor 已有原语，不引入新第三方可观测性库
- **利益相关者**：AI coding agent 的开发者、CI/eval 系统
- **集成点**：`TuiA1StateGraph`（DataGraph 实例）、`TerminalRuntime`（agent 执行路径）、`@terminal/cli`（yargs CLI）

---

## 方案概览

### 1. 工厂函数 `createObservableGraph()`

替代直接 `new DataGraph()`，创建一个预配置了所有 observability middleware 的 DataGraph 工厂。

```
createObservableGraph(options) → { graph, traceLog, diagnosticPipeline, dispose }
  ├── graph: DataGraph — 已注册 TraceMiddleware + persistPlugin + loggerPlugin
  ├── traceLog: AppendOnlyEventLog<TraceRecord> — raw trace 事件
  ├── diagnosticPipeline — StreamGraph 诊断管线
  └── dispose: () => void — 统一清理
```

**与 `TuiA1StateGraph` 的关系**：
- `TuiA1StateGraph` 构造函数改用 `createObservableGraph()` 代替 `new DataGraph()`
- 不改动 `TuiA1StateGraph` 的公开 API（仍暴露 `readonly graph`、`dispatch()` 等）

### 2. Diagnostic 子图（嵌套模块）

使用 depa-data-graph 的 `defineGraphModule` / `mountGraph` 将 diagnostic signals 隔离为子图：

```
DataGraph (root)
├── snapshot, messages, busy, composer, route, ... (现有 TUI state)
├── diag/ (mounted sub-graph)
│   ├── modelSelection: Signal<ModelSelectionRecord[]>
│   ├── continuation: Signal<ContinuationRecord | null>
│   ├── turnTimings: Signal<TurnTimingRecord[]>
│   ├── compactions: Signal<CompactionRecord[]>
│   ├── toolStats: Signal<ExecToolStatsSnapshot>
│   └── retries: Signal<RetryRecord[]>
```

- 子图通过 `mountGraph` 挂载到 root graph，保持命名空间隔离
- 子图内部可定义自己的 computed 节点（如 `diag/summary` 聚合所有诊断）
- GraphBridge 按需将子图 signal 桥接到 StreamGraph

### 3. StreamGraph 诊断管线

```
StreamGraph
├── source: trace.raw (从 TraceMiddleware.onRecord 推入)
├── operator: trace.byNode (按 nodeId 分组 fold)
├── operator: trace.stats (全局统计 fold)
├── source: diag.modelSelection (从 GraphBridge 桥接)
├── source: diag.turnTimings (从 GraphBridge 桥接)
├── source: diag.toolStats (从 GraphBridge 桥接)
├── sink: trace.toTimeline → OrderedTimeline<TraceRecord>
└── sink: trace.toLog → AppendOnlyEventLog<TraceRecord>
```

### 4. Provider Diagnostic Collector

在 `TerminalRuntime` 的 AI agent 执行路径中挂载 collector，在关键生命周期点写入 diagnostic signals：

| 生命周期点 | 写入 signal | 数据内容 |
|---|---|---|
| LLM adapter 选择模型时 | `diag/modelSelection` | `{modelId, fallbackChain, attemptedModels}` |
| 跨 turn 续接时 | `diag/continuation` | `{responseId, epoch, mode}` |
| 请求发送时 | `diag/turnTimings` | `{phase: "request_send", ts}` |
| 流式 progress 时 | `diag/turnTimings` | `{phase: "progress", ts, chunkCount}` |
| 响应完成时 | `diag/turnTimings` | `{phase: "response_complete", ts, tokenCount}` |
| Compaction 执行时 | `diag/compactions` | `{protectedCategories, rewrittenCategories, skipReason}` |
| Tool call 完成时 | `diag/toolStats` | 更新 `{starts, ok, error, byTool}` |
| 重试发生时 | `diag/retries` | `{classificationReason, classificationLayer, attempt}` |

### 5. Session Trace 持久化

双模式，通过 `createObservableGraph()` 的 options 切换：

```
mode: "memory" → AppendOnlyEventLog 仅内存
mode: "file"   → AppendOnlyEventLog + 每个 turn 结束时 flushToFile()
                 导出 JSONL 格式 trace 文件
```

文件写入使用 `AppendOnlyEventLog` + `fs.appendFileSync`（每行一个 JSON TraceRecord），保持与已有 log 抽象一致。

### 6. Scene Replay

#### Scene 存储格式

使用 **xnl-core** 的 `TextElementNode` + mutation append 模式存储 scene：

```
scene.xnl:
  scene id="abc123"
    meta:
      model: "claude-sonnet-4-20250514"
      created: "2026-01-01T00:00:00Z"
    messages: [...]  // 序列化的 ConversationMessage[]
    systemPrompt: "..."
    tools: [...]
    providerEvents:
      event: {phase: "model_selection", ...}
      event: {phase: "request_send", ...}
      event: {phase: "progress", ...}
```

- `providerEvents` 中的每个 event 通过 `TREE_ADD` mutation 追加，天然支持 append-only
- xnl-core 的 `applyMutations` 保证写入的原子性
- 读取时通过 `batchLoad` 加载

#### Replay CLI 命令

复用现有 `@terminal/cli` 的 yargs `CommandModule` 模式，新增 `replay` 命令：

```typescript
// terminal/packages/cli/src/commands/replay.ts
export const replay: CommandModule = {
  command: "replay <scene>",
  describe: "replay a recorded scene for eval",
  builder: (yargs) =>
    yargs
      .positional("scene", { type: "string", describe: "path to scene.xnl file" })
      .option("mode", { choices: ["recorded", "live"], default: "recorded" })
      .option("timeout", { type: "number", default: 300 })
      .option("output", { type: "string", describe: "write replay result to file" }),
  handler: async (args) => { /* ... */ },
}
```

在 `terminal/packages/cli/src/index.ts` 中注册：
```typescript
.command(replay)
```

#### Replay 引擎

基于 depa-actor 的 `OrchestratorState` 纯函数 reducer：

```typescript
function runSceneReplay(scene: Scene, options: ReplayOptions): ReplayResult {
  let state = createOrchestratorState({
    timeoutEnabled: true,
    defaultTimeoutMs: options.timeoutMs,
  })

  if (options.mode === "recorded") {
    // 确定性回放：按 scene.providerEvents 逐一发出 fiber actions
    for (const event of scene.providerEventSlice) {
      const action = convertToFiberAction(event)
      const { state: next, effects } = reduceOrchestrator(state, action)
      state = next
      // dispatch effects
    }
  } else {
    // live 模式：真实调用 LLM
    // 使用 scene.messages + scene.tools 发起请求
    // 对比 live response 与 scene.providerEventSlice 的差异
  }

  return buildReplayResult(state)
}
```

### 7. 补全已有原语

在 `createObservableGraph()` 中统一注册：

| 原语 | 注册方式 | 条件 |
|---|---|---|
| `loggerPlugin` | `graph.use(loggerPlugin({...}))` | `options.debug === true` |
| `persistPlugin` | `graph.use(persistPlugin({...}))` | `options.persistKeys` 非空 |
| `depsAudit` | `graph.setDepsAudit("warn")` | `options.debug === true` |

`graph.validate()` 和 `graph.snapshot()` 通过 `createObservableGraph()` 返回的句柄暴露，由调用方按需使用。

---

## 影响范围与修改点（Impact）

### 新增文件

| 文件 | 内容 |
|---|---|
| `terminal/packages/organ/src/observability/TraceMiddleware.ts` | GraphMiddleware 实现、TraceRecord 类型 |
| `terminal/packages/organ/src/observability/DiagnosticPipeline.ts` | StreamGraph 诊断管线工厂 |
| `terminal/packages/organ/src/observability/ProviderCollector.ts` | Provider Diagnostic Collector（signal 写入） |
| `terminal/packages/organ/src/observability/SessionTraceStore.ts` | AppendOnlyEventLog + flushToFile |
| `terminal/packages/organ/src/observability/SceneReplay.ts` | 基于 OrchestratorState 的 replay 引擎 |
| `terminal/packages/organ/src/observability/createObservableGraph.ts` | 工厂函数 |
| `terminal/packages/organ/src/observability/index.ts` | 公开导出 |
| `terminal/packages/cli/src/commands/replay.ts` | yargs replay 命令 |

### 修改文件

| 文件 | 变更 |
|---|---|
| `terminal/packages/tui/src/app/tui_a1/graph.ts` | `TuiA1StateGraph` 构造函数改用 `createObservableGraph()` |
| `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts` | 挂载 ProviderCollector |
| `terminal/packages/tui/support/util/stream-diagnostics.ts` | 零散诊断迁移到 DiagnosticPipeline |
| `terminal/packages/cli/src/index.ts` | 注册 replay 命令 |

---

## 决策摘要

- 详见 `codument/tracks/add-ai-domain-observability/decisions.md`
- 当前关键结论：
  - **createObservableGraph() 工厂函数**附加所有 observability middleware
  - **Diagnostic 子图**通过 mountGraph 隔离
  - **CLI** 复用现有 `@terminal/cli` yargs CommandModule
  - **Scene 存储**使用 xnl-core TextElementNode + TREE_ADD mutation
  - **持久化**使用 AppendOnlyEventLog + flush to file

---

## 风险 / 权衡

- **性能风险**：TraceMiddleware 拦截每次 get/set → 通过 `filter` 选项在生产模式关闭细粒度 trace，仅保留 provider 级别诊断
- **内存风险**：内存模式 trace 无限增长 → `maxRecords` 上限（默认 10000），超出时 FIFO 丢弃旧记录
- **Graph 膨胀**：diagnostic signals 增加 graph 节点数 → 通过子图隔离，不影响主 TUI graph 的 computed 重算范围

## 兼容性设计

- `TuiA1StateGraph` 公开 API 不变：`graph`、`dispatch()`、`snapshot()` 等方法签名保持一致
- `createObservableGraph()` 的返回值是 `DataGraph` 的超集（`{ graph, ...extra }`），调用方可以忽略 extra 字段
- `graph.use()` 的链式调用语义不变，middleware 按注册顺序执行

---

## 待解决问题

- `mountGraph` API 的 exact 签名和用法需在实现时查阅 depa-data-graph 最新文档确 认
- xnl-core 的 scene schema 细节（meta / messages / providerEvents 的具体节点结构）需在实现 Phase 细化
