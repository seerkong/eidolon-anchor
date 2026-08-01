# 设计：platform composer uplift

## 1. 波次目标

Wave 5 不直接做 VM facet 拆分，也不直接引入完整的 `mod-platform-kernel`。

它只处理一个关键前置问题：

- 让 `@cell/composer` 的根装配器真正成为平台级 capability composition engine

如果这一步不做，后续 platform kernel baseline、VM facet split 和 shell bridge 去 AI 化都会继续建立在 AI-shaped root composer 上，结构会越来越难收口。

## 2. 当前问题

当前虽然已经有：

- `@cell/platform-contract`
- `@cell/composer/contract`
- `@cell/composer/ai-contract`

但 `assembleRuntimeProfile()` 仍直接使用 `ai-contract` 的：

- `RuntimeAssemblyContext`
- `RuntimeAssemblyState`
- `RuntimeAssemblyResult`

并在根装配器里直接初始化：

- `agentConfigs`
- `tooling`
- `bootstrap`
- `runtimeCatalog`
- `runtimeSupport`
- `slashCommands`
- `slashCommandSurfaces`

这意味着根装配器仍天然站在 AI runtime 的视角，而不是平台 capability 的视角。

## 3. 目标结构

建议将装配 contract 明确分成两层：

### 3.1 Platform root assembly

- `platform-contract`
  - root assembly context
  - root assembly state
  - root assembly result
  - root extension / profile contract

这层只包含平台可复用的最小组合能力，例如：

- `systemPromptSections`
- `capabilityIds`
- `policies`

以及后续可能加入的更通用 capability port。

### 3.2 AI assembly facet

- `composer/ai-contract`
  - 在 platform root assembly 上扩展：
    - `agentConfigs`
    - `tooling`
    - `bootstrap`
    - `runtimeCatalog`
    - `runtimeSupport`
    - `slashCommands`
    - `slashCommandSurfaces`

结论：

- AI facet 仍保留，但它不应继续定义根装配器
- 根装配器应先面向 platform contract，再由 AI facet 叠加

## 4. 实施方向

### 4.1 拆出 platform-first assemble helper

把当前根装配逻辑改为先基于 platform contract 组装：

- platform initial state
- profile reduce
- platform result finalize

然后仅在 AI runtime 入口处增加 AI facet finalize。

### 4.2 保持 mod-profiles 与 shell adoption 的行为稳定

本 wave 不改变：

- `platform-only`
- `ai-kernel`
- `ai-coding`

的正式 layering，也不改变 shell runtime 当前依赖 assembly result 的主路径。

### 4.3 focused tests 必须验证 ownership，而不是 grep

至少应覆盖：

- `platform-only` 不依赖 AI facet 默认状态
- `ai-kernel -> ai-coding` layering 仍成立
- shell/tui 继续从 assembly result 消费所需 AI facet

## 5. 与后续波次的关系

Wave 5 完成后，后续优先级将更清晰：

1. VM facet split
2. `mod-platform-kernel`
3. 第一批真实 `platform-support`
4. AI slash/direct-action contract 从 terminal/core 下沉

## 6. 反模式

本 wave 应避免：

- 只改命名，不改根装配 ownership
- 为了未来幻想，预先引入过大的平台 state
- 在 platform 与 AI 两边维护两套平行 assemble helper
