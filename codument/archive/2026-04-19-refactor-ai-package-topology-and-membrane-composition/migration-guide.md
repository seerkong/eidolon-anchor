# AI Package Topology Migration Guide

本文档用于收口本 track 落地后的 package topology、兼容策略与 terminal facade 消费边界。

## 包职责总览

### `@cell/ai-core-contract`
- AI core runtime contract 的正式宿主
- 承载 runtime assembly contract、runtime support contract、host bundle contract

### `@cell/ai-core-logic`
- AI core runtime glue 的正式宿主
- 承载 AI runtime graph / semantic / stage pipeline / snapshot / config loader 等 core logic
- 不承载 composer ownership
- 也不反向依赖 `@cell/ai-organ-logic`

### `@cell/ai-organ-contract`
- AI-specific organ contract 的正式宿主
- 承载 `RuntimeDeps`、permission、organization、persistence 等组织层契约

### `@cell/ai-organ-logic`
- AI-specific organ logic 的正式宿主
- 承载 orchestration、organization、coordination、permission runtime、runtime recovery 与 persistence orchestration

### `@cell/ai-support`
- AI support backend 的正式宿主
- 承载 local/server support 实现与 support bundle 工厂

### `@cell/ai-composer`
- AI 领域 composer 的正式宿主
- 对齐参考项目 `sparrow_composer`
- 承载 runtime composition contract、profile/extension reducer、runtime deps composition helper

### `@cell/membrane`
- 更高层 runtime composition facade 宿主
- 封装 `@cell/ai-composer`
- 为未来更多领域 composer 的聚合留出扩展位

## 依赖方向

建议按以下方向理解依赖层次：

```text
ai-core-contract
  <- ai-core-logic
  <- ai-organ-contract
  <- ai-organ-logic
  <- ai-support
  <- ai-composer
  <- membrane
  <- terminal/* and future host adapters
```

关键约束：
- `ai-composer` 不回流到 `ai-core-logic`
- `ai-organ-logic` 依赖 `ai-core-logic`，不能反向由 `ai-core-logic` 聚合 organ runtime surface
- `core-contract` / `core-logic` 中残留的 AI-specific data / logic 必须继续迁入 `ai-core-*`
- `ai-organ-*` 正式承接 AI-specific organ ownership
- `ai-support` 正式承接 support backend ownership
- `membrane` 是高层 facade 宿主之一，但不是唯一允许入口

## 旧包到新包的映射

- `@cell/composer` -> `@cell/ai-composer`
- `@cell/domain-ai-contract` -> `@cell/ai-core-contract`
- `@cell/domain-ai-logic` -> `@cell/ai-core-logic`
- `@cell/core-contract` 中 AI-specific data -> `@cell/ai-core-contract`
- `@cell/core-logic` 中 AI-specific logic -> `@cell/ai-core-logic`
- `@cell/domain-ai-support` -> `@cell/ai-support`
- `organ-*` 中 AI-specific contract / logic -> `@cell/ai-organ-contract` / `@cell/ai-organ-logic`

## 兼容壳清理结果

本轮已从 workspace 中移除以下旧包：
- `@cell/composer`
- `@cell/domain-ai-contract`
- `@cell/domain-ai-logic`
- `@cell/domain-ai-support`

当前 `@cell/organ-contract` 与 `@cell/organ-logic` 已从 workspace 删除。AI runtime 相关正式 ownership 已不再通过旧包名暴露；旧名字仅应存在于 migration guard、track 文档和归档历史中。

## Terminal 消费边界

### `terminal/core`
- 优先消费窄 contract
- 当前应依赖 `@cell/ai-core-contract`
- 不负责高层 runtime composition

### `terminal/organ`
- 可消费更高层 runtime composition facade
- 当前可依赖 `@cell/membrane/runtime-composition`
- 也可按需要依赖 `@cell/ai-core-logic`、`@cell/ai-organ-logic`

### `terminal/tui`
- 可消费 host-facing runtime catalog 与配置解析 facade
- 当前 runtime catalog 依赖 `@cell/ai-core-logic`
- runtime composition 类型可通过 `@cell/membrane/runtime-composition` 获取

### `terminal/organ-support`
- 不需要为执行支持逻辑强行引入 membrane/composer
- 维持更窄、更贴近 support/exec 的依赖面

## 后续实现判断规则

当新增 AI runtime 相关代码时，优先按以下问题判断归属：

1. 这是 contract 还是 logic，属于 core 还是 organ？
2. 这是 support backend，还是 runtime composition？
3. 这是 AI 领域 composer 本身，还是更高层 facade 聚合？
4. 这个 terminal consumer 需要的是窄 contract、host glue，还是高层 composition facade？

如果答案分别是：
- core contract -> `@cell/ai-core-contract`
- core glue -> `@cell/ai-core-logic`
- AI organ contract / logic -> `@cell/ai-organ-*`
- support backend -> `@cell/ai-support`
- AI composition -> `@cell/ai-composer`
- 更高层 composition facade -> `@cell/membrane`

## 验证入口

本 track 的 focused ownership / layering guard 主要由以下文件锁定：
- `cell/packages/ai-organ-logic/tests/AIAgent/cell_package_surface_migration.test.ts`
- `terminal/packages/organ/tests/AIAgent/runtime/terminal_runtime_composer_adoption.test.ts`
- `terminal/packages/core/tests/slash-commands.test.ts`
- `terminal/packages/tui/tests/local-runtime-facade-config.test.ts`
