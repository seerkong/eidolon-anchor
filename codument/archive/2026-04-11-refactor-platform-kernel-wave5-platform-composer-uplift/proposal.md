# 变更：实施平台微内核 Wave 5 的 platform composer uplift

## 背景和动机

在完成前四波以及后续 support/mod rename、import cutover 之后，当前仓库已经具备：

- `platform-only -> ai-kernel -> ai-coding` 的正式 profile layering
- `@cell/platform-contract` 的最小平台 contract 外壳
- shell/runtime entry 对 assembly result 的正式消费

但总 track 的最新复核表明，一个关键结构 gap 仍然存在：

- `@cell/composer` 的主装配器仍直接建立在 AI-shaped `ai-contract` 上
- runtime assembly engine 仍主要初始化 `agentConfigs`、`tooling`、`runtimeCatalog`、`runtimeSupport`、`slashCommands` 等 AI runtime 资产
- 平台层还没有真正成为“先组合平台 capability，再由 AI facet 叠加”的正式装配引擎

这使得当前更接近“AI 领域微内核之上的平台外壳”，而不是 feasibility analysis 目标中的“两层微内核”。

## 要做

- 将 `@cell/composer` 的主装配器从 AI-shaped runtime composer 提升为平台 capability composition engine
- 明确 platform assembly state/result 与 AI assembly facet 的叠加边界
- 为后续 `mod-platform-kernel`、platform facet VM、AI slash contract 下沉提供正式装配基线
- 用 focused tests 锁定 platform-first composition ownership

## 不做

- 本次不直接实现 `AiAgentVm` 的 platform/AI facet 全量拆分
- 本次不引入完整的 `platform-logic` 或 `mod-platform-kernel` 实现
- 本次不做 shell runtime 的全面平台无关化
- 本次不处理 codument 历史文档中的旧命名

## 变更内容

- 调整 `@cell/composer` 的根装配 contract 与主装配入口
- 让 platform assembly 成为第一层 truth，AI facet 明确作为其上的叠加层
- 更新 profile/mod/composer focused tests，验证 platform-first ownership
- 为下一波 VM facet 拆分与 platform baseline 提供可执行结构基础

## 影响范围

- 受影响代码：
  - `cell/packages/platform-contract`
  - `cell/packages/composer`
  - `cell/packages/mod-profiles`
  - `cell/packages/mod-ai-kernel`
  - 相关 focused tests
- 后续波次依赖：
  - platform VM facet / AI VM facet split
  - `mod-platform-kernel`
  - shell bridge 去 AI 语义化
