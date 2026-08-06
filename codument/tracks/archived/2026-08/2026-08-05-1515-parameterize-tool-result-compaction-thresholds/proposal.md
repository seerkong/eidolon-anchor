# 变更：tool-result 压缩阈值参数化（通用配置机制）

> 本 track 从占位扩展为真实实现：用户已提供通用配置机制方案并确认（decisions.xnl）。

## 背景和动机 (Context And Why)

tool-result 压缩管线的各阈值目前是**代码内隐式硬编码**，没有显式配置文件承载，用户无法调整。参照 ace-runtime-3 的 `micro-compact-options.json` VFS 加载机制，建立 eidolon 通用配置机制：terminal 构造 VFS，cell 从 VFS 读取 typed options，压缩阈值参数化进 `runtime-config.json`。

## 已收集的隐式默认值位置（完整清单）

### 1. 生产管线两套取值（[AiAgentExecutor.ts](cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts)）

**日常 cheap 管线** `buildCheapCompactionPipelineOptions`（[:770-787](cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts:770)）：

| 参数 | 硬编码值 | 行号 |
|---|---|---|
| `toolResultBudgetBytes` | 120_000 | :779 |
| `toolResultPersistThresholdBytes` | 4_000 | :780 |
| `toolResultPreviewChars` | 1_500 | :781 |
| `microKeepRecentToolResults` | 20 | :782 |
| `microMinContentChars` | 8_000 | :783 |
| `microPreviewChars` | 4_000 | :784 |

**压力预检管线** `buildPreflightPressureCompactionPipelineOptions`（[:789-806](cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts:789)）：

| 参数 | 硬编码值 | 行号 |
|---|---|---|
| `toolResultBudgetBytes` | 20_000 | :798 |
| `toolResultPersistThresholdBytes` | 2_000 | :799 |
| `toolResultPreviewChars` | 500 | :800 |
| `microKeepRecentToolResults` | 1 | :801 |
| `microMinContentChars` | 1_000 | :802 |
| `microPreviewChars` | 300 | :803 |

### 2. 函数级回退默认值（[ContextCompressor.ts](cell/packages/ai-organ-logic/src/compression/ContextCompressor.ts)）

`applyToolResultBudget`（[:217-260](cell/packages/ai-organ-logic/src/compression/ContextCompressor.ts:217)）：

- `toolResultBudgetBytes` 默认 200_000（:229）
- `toolResultPersistThresholdBytes` 默认 30_000（:230）
- `toolResultPreviewChars` 默认 2_000（:231）

`microCompactToolResults`（[:262-304](cell/packages/ai-organ-logic/src/compression/ContextCompressor.ts:262)）：

- `microKeepRecentToolResults` 默认 3（:269）
- `microMinContentChars` 默认 120（:270）
- `microPreviewChars` 默认 800（:271）

### 3. 历史压缩默认值

`findSplitPoint` / `compressHistory`（ContextCompressor.ts:364, 560）：

- `recentKeep` 默认 4（:364, :560）
- 安全比例 `inputLimit * 0.9`（:588）
- 预算比例 `effectiveLimit * 0.9`（AiAgentExecutor.ts:4377）
- 自动压缩触发阈值 `ratio < 0.85`（AiAgentExecutor.ts:4351）

### 4. 唯一与配置相关的间接来源

- `artifactDir` 由 `vm.outerCtx.metadata.sessionDir` 推导并受 `isRuntimeStorageFilesEnabled` 门控（[:771-776](cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts:771)）—— 这是目录路径，不是阈值。
- `compactionThresholdTokens` 可通过 `modelConfig.capabilities.cachePolicy` 配置（[:467-474](cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts:467)）—— 只控制"何时压"，不控制"怎么压"。

### 5. 传递逻辑

```
buildCheapCompactionPipelineOptions / buildPreflightPressureCompactionPipelineOptions
  → applyCheapCompactionPipeline(messages, options)
      → applyToolResultBudget(messages, options)      ← toolResultBudgetBytes / PersistThreshold / PreviewChars
      → microCompactToolResults(messages, options)    ← microKeepRecentToolResults / MinContentChars / PreviewChars
  → 结果写入 History domain
```

## 通用配置机制方案（用户确认）

### 分层

```
terminal/              入口层：构造 ResourceVFS（读 workDir/.eidolon + ~/.eidolon 两级）
cell/ai-support/       从 VFS 读取配置 + 解析 typed options + 内嵌默认 json 兜底（RuntimeConfigVfsLoader）
cell/ai-organ-logic/   消费 typed options（压缩管线参数化）
cell/symbiont-logic/   底层可迁移 ResourceVFS 类型 + 操作（不依赖 cell 内部包）
cell/symbiont-contract/ ResourceVFS 类型定义
```

### 关键决策

- VFS 路径约定 `/.eidolon/`（非 .sparrow）
- 不要 kconf（本地文件 + bunfs 默认兜底）
- 所有配置类别存**一个文件** `runtime-config.json`
- 默认加载 `~/.eidolon/`，优先级：workDir/.eidolon → ~/.eidolon → bunfs 默认 json
- 加载失败静默降级为内嵌默认 json
- 要 typed options（每类别 parse 函数 + 默认值兜底）
- ResourceVFS 设计为通用文件树（含 skill/agent/prompt），本期只做配置文件
- bunfs 默认 json 放 ai-support
- 循环依赖（ai-support ↔ ai-organ-logic）记入 backlog 后续解决

### runtime-config.json 结构（多级，compact.microCompact）

```json
{
  "compact": {
    "microCompact": {
      "budget":   { "toolResultBudgetBytes": 200000, "toolResultPersistThresholdBytes": 30000, "toolResultPreviewChars": 2000 },
      "cheap":    { "toolResultBudgetBytes": 120000, "toolResultPersistThresholdBytes": 4000, "toolResultPreviewChars": 1500, "microKeepRecentToolResults": 20, "microMinContentChars": 8000, "microPreviewChars": 4000 },
      "preflight":{ "toolResultBudgetBytes": 20000, "toolResultPersistThresholdBytes": 2000, "toolResultPreviewChars": 500, "microKeepRecentToolResults": 1, "microMinContentChars": 1000, "microPreviewChars": 300 }
    },
    "historyCompaction": {
      "recentKeep": 4,
      "safeRatio": 0.9,
      "triggerRatio": 0.85
    }
  }
}
```

## "要做"和"不做" (Goals / Non-Goals)

**目标:**

- symbiont-contract/logic 建立可迁移 ResourceVFS 类型 + 操作。
- ai-support 新增 RuntimeConfigVfsLoader（从 VFS 读 + 内嵌默认 json 兜底）。
- 压缩阈值参数化进 runtime-config.json（compact.microCompact 多级结构）。
- terminal 构造 ResourceVFS（两级 .eidolon 目录）。

**非目标:**

- 不引入 kconf 或外部配置中心。
- 本期只做配置文件，不做 skill/agent/prompt 的 VFS 文件树。
- 不解决 ai-support ↔ ai-organ-logic 循环依赖（backlog）。
- 不迁移其他 runtime 配置到 VFS。

## 变更内容（What Changes）

- `cell/packages/symbiont-contract/src/`：ResourceVFSFile / ResourceVFS 类型。
- `cell/packages/symbiont-logic/src/`：ResourceVFSOps / ResourceVFSLoaderOps。
- `cell/packages/ai-support/src/`：内嵌默认 runtime-config.json + RuntimeConfigVfsLoader。
- `cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts`、`compression/ContextCompressor.ts`：压缩阈值从配置读取。
- `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts`：构造 ResourceVFS。

## 影响范围（Impact）

- 受影响的能力（behaviors）：`progressive-context-resource-loading`、压缩相关行为
- 受影响的代码：
  - `cell/packages/symbiont-contract/`
  - `cell/packages/symbiont-logic/`
  - `cell/packages/ai-support/`
  - `cell/packages/ai-organ-logic/`
  - `terminal/packages/organ/`

