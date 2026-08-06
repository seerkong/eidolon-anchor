## 上下文

本 track 是 mission `improve-file-read-efficiency-and-context-reuse` 的 G4 落地 track，从占位扩展为真实实现。用户已提供通用配置机制方案并确认（decisions.xnl 的 5 个新决策）。

## 已收集的隐式默认值位置（完整清单见 proposal.md）

- 生产管线两套取值：[AiAgentExecutor.ts:779-784](cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts:779)（cheap）与 [:798-803](cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts:798)（preflight）。
- 函数级回退默认值：[ContextCompressor.ts:229-231](cell/packages/ai-organ-logic/src/compression/ContextCompressor.ts:229) 与 [:269-271](cell/packages/ai-organ-logic/src/compression/ContextCompressor.ts:269)。
- 历史压缩：[ContextCompressor.ts:364,560](cell/packages/ai-organ-logic/src/compression/ContextCompressor.ts:364)（recentKeep=4）、[:588](cell/packages/ai-organ-logic/src/compression/ContextCompressor.ts:588)（safeRatio=0.9）、[AiAgentExecutor.ts:4351](cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts:4351)（triggerRatio=0.85）。
- 唯一既有可配置入口：`modelConfig.capabilities.cachePolicy.compactionThresholdTokens`（只控制触发时机）。

## 方案概览

### 分层

```text
terminal/              入口层：构造 ResourceVFS（读 workDir/.eidolon + ~/.eidolon 两级）
  │                     读文件系统，构造 VFS 后传给 cell
  ▼
cell/ai-support/       从 VFS 读取配置 + 解析 typed options + 内嵌默认 json 兜底（RuntimeConfigVfsLoader）
cell/ai-organ-logic/   消费 typed options（压缩管线参数化）
cell/symbiont-logic/   底层可迁移 ResourceVFS 类型 + 操作（不依赖 cell 内部包）
cell/symbiont-contract/ ResourceVFS 类型定义
```

### 关键设计

1. **ResourceVFS（symbiont-contract/logic）**
   - `ResourceVFSFile { path: PurePosixPath, content: string, source?: string }`
   - `ResourceVFS { files: Map<PurePosixPath, ResourceVFSFile> }`
   - `ResourceVFSOps`：fromDict / withFile / merge / get
   - `ResourceVFSLoaderOps`：fromFilePaths（对齐 sparrow）
   - VFS 路径约定 `/.eidolon/`（非 .sparrow）
   - 设计为通用文件树（skill/agent/prompt），本期只做配置文件

2. **RuntimeConfigVfsLoader（ai-support）**
   - 从 VFS 的 `/.eidolon/runtime-config.json` 读取
   - 解析为 typed options（compact.microCompact 多级结构）
   - VFS 无文件 → 内嵌默认 json 兜底（`import ... with { type: "json" }`）
   - 加载失败静默降级

3. **压缩阈值参数化（ai-organ-logic）**
   - `buildCheapCompactionPipelineOptions` / `buildPreflightPressureCompactionPipelineOptions` 从 typed options 读取
   - `ContextCompressor` 函数默认值（budget/persist/preview/micro/historyCompaction）从配置读取

4. **terminal 构造 VFS**
   - 读 workDir/.eidolon + ~/.eidolon 两级 runtime-config.json
   - 构造 ResourceVFS，传给 RuntimeConfigVfsLoader

## 影响范围与修改点（Impact）

- `cell/packages/symbiont-contract/src/`（ResourceVFS 类型）
- `cell/packages/symbiont-logic/src/`（ResourceVFSOps / ResourceVFSLoaderOps）
- `cell/packages/ai-support/src/`（默认 json + RuntimeConfigVfsLoader）
- `cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts`、`compression/ContextCompressor.ts`
- `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts`

## 决策摘要

- 详见 `decisions.xnl`。
- VFS 消费接口：ai-support 新增 RuntimeConfigVfsLoader（用户确认）。
- bunfs 默认 json：ai-support，VFS 无则取默认（用户确认）。
- ResourceVFS scope：通用文件树，本期只做配置文件（用户确认）。
- 循环依赖 ai-support ↔ ai-organ-logic：记入 backlog（用户确认）。

## 风险 / 权衡

- 风险：生产取值与函数 fallback 默认值两套不一致。
  - 缓解：参数化时同时覆盖两处，统一为单一配置来源。
- 风险：ai-support ↔ ai-organ-logic 循环依赖影响配置消费层归属。
  - 缓解：本 track 在 ai-support 放 VFS loader（薄适配），typed options 解析与 schema 放 ai-organ-logic（现有 LLM_PROVIDER_JSON_SCHEMA 同层）；循环依赖另立 backlog 工作项。
- 风险：terminal 构造 VFS 与 cell 消费接口的契约漂移。
  - 缓解：VFS 路径常量 `/.eidolon/` 单一事实源，symbiont 定义。

## 待解决问题

- 无（方案已确认）。
