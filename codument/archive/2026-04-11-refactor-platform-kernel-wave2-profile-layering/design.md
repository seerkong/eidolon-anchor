# 设计：Wave 2 的 profile layering

## 1. 波次定位

本波次只处理 profile layering，不提前混入 shell/support 的后续 cutover。

目标是把当前“默认 coding profile”改造成正式三层：

1. `platform-only`
2. `ai-kernel`
3. `ai-coding`

## 2. 设计原则

### 2.1 单一 truth source

三层 profile 的顺序只在 `@cell/mod-profiles` 定义一次。调用方只能选择 profile，不允许自己重新拼装顺序。

### 2.2 保守增量兼容

主运行入口改为正式消费 `ai-coding`，但继续保留 `default-coding` 兼容别名，避免一次性打断所有测试与调用方。

### 2.3 缺失 capability 是正式语义

`platform-only` 不应隐式长出 AI runtime bootstrap、tooling、slash surface 或 coding fallback。调用方如果直接装配它，就必须显式感知“这里只有平台基线，没有 AI runtime 默认实现”。

## 3. 结构方案

### 3.1 profile 切分

- `platform-only`
  - 当前不追加 AI-shaped extension
  - 作为所有后续 overlay 的正式基线
- `ai-kernel`
  - 在 `platform-only` 之上追加 `mod-sys-kernel`
- `ai-coding`
  - 在 `ai-kernel` 之上追加 `mod-sys-coding`

### 3.2 兼容策略

- 新增正式导出：
  - `platformOnlyRuntimeProfile`
  - `aiKernelRuntimeProfile`
  - `aiCodingRuntimeProfile`
  - `assemblePlatformOnlyRuntimeProfile`
  - `assembleAiKernelRuntimeProfile`
  - `assembleAiCodingRuntimeProfile`
- 保留兼容导出：
  - `defaultCodingRuntimeProfile`
  - `assembleDefaultCodingRuntimeProfile`

兼容导出只是指向 `ai-coding`，不再拥有独立 truth source。

## 4. 风险

### 风险 1：platform-only 被误做成隐式 AI baseline

如果 `platform-only` 仍然偷偷带上 AI runtime bootstrap 或 slash/tooling，Wave 3 就无法识别哪些 shell 行为是在偷吃默认 AI 能力。

### 风险 2：调用方继续自己拼层级

如果 `TerminalRuntime` 继续直接引用旧默认命名或自己拼 kernel/coding extension，profile layering 会再次失真。

## 5. 成功标准

Wave 2 达到以下条件时视为完成：

- 三层 profile 正式落地到单一 truth source
- `TerminalRuntime` 显式通过 `ai-coding` 装配
- `platform-only` 的 capability absence 具备自动化保护
- terminal/tui/headless 主路径保持连续可运行
