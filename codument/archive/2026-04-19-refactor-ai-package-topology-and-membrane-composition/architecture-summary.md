# 架构思路总结：AI Package Topology、Composer Ownership 与 Membrane 封装

本文档汇总本 track 创建前已经确认的架构思路，作为 `proposal.md` 与 `design.md` 的直接依据。

## 1. 核心判断

当前仓库已经完成了第一轮“默认 runtime product definition 从 terminal 迁到 composer/mod profile”的 cutover，但还没有完成第二轮“package topology 与 ownership 收口”。

因此，本轮不应重复第一轮工作，而应解决以下残留问题：

1. `@cell/composer` 已承担 AI runtime assembly 职责，但名称与职责归属还未按目标拓扑明确收口。
2. `@cell/domain-ai-contract` / `@cell/domain-ai-logic` / `@cell/domain-ai-support` 的命名和边界仍停留在中间状态。
3. `@cell/mod-ai-kernel` 仍直接依赖 `LocalFile*` support 实现，说明 profile/composer 组合链仍混入宿主实现。
4. `terminal` 虽已不再是默认产品定义中心，但仍持有过多 runtime factory / host glue 职责。
5. `@cell/membrane` 还没有成为更高层 composer facade 的正式宿主。

## 2. 目标 package topology

### 2.1 包命名与职责

- `@cell/ai-core-contract`
  - 由当前 `@cell/domain-ai-contract` 演进
  - 负责 AI core 级 contract、runtime assembly contract、runtime support contract、host bundle contract

- `@cell/ai-core-logic`
  - 由当前 `@cell/domain-ai-logic` 演进
  - 负责 AI core runtime glue、AI runtime graph / semantic / pipeline / snapshot logic、runtime facade port
  - 不负责 composer ownership

- `@cell/ai-support`
  - 由当前 `@cell/domain-ai-support` 演进
  - 负责 local/server support 实现和统一 support bundle factory

- `@cell/ai-organ-contract`
  - 新增
  - 对应参考项目 `sparrow_organ_data`
  - 负责 AI-specific orchestration / organization / permission / persistence / `RuntimeDeps` 等组织层契约

- `@cell/ai-organ-logic`
  - 新增
  - 对应参考项目 `sparrow_organ_logic`
  - 负责 orchestration、organization、coordination、permission runtime、task tree、runtime recovery 等 AI 组织层逻辑

- `@cell/ai-composer`
  - 由当前 `@cell/composer` 演进并改名
  - 对应参考项目 `sparrow_composer`
  - 负责 runtime composition contract、profile/extension reducer、runtime deps 组合 helper
  - 不承载本地宿主实现

- `@cell/membrane`
  - 不再是空壳
  - 负责封装 `@cell/ai-composer`
  - 未来可继续聚合更多领域 composer，形成更高层封装概念

## 3. 依赖方向

建议依赖方向如下：

```text
ai-core-contract <- ai-core-logic
ai-core-contract <- ai-organ-contract <- ai-organ-logic
ai-organ-logic <- ai-support <- ai-composer <- membrane
membrane <- terminal/* and future host adapters
```

说明：
- `ai-composer` 是领域级 composer 宿主。
- `membrane` 位于 composer 之上，提供更高层封装。
- terminal 可以引用不同层级的 `cell/*` facade，但要按职责和抽象层级消费，不应错误限制为“只消费 membrane”。

## 4. Terminal 的正确消费边界

本轮确认的原则不是“`terminal/*` 只消费 membrane”，而是：

- `terminal/*` 可以引用其他 `cell/*` 包。
- 但要按所处层级需要的 facade/contract 进行消费，不应越级引用大量内部实现细节。
- 当需要领域级 runtime composition 能力时，可以引用 `ai-composer` 或由 `membrane` 提供的更高层 facade。
- 当需要未来可扩展的跨领域、更高层组合面时，应优先通过 `membrane` 接入，而不是把多个 composer 直接散落到高层 consumer。

按建议分层：

- `terminal/core`
  - 优先依赖更窄的 contract / UI-neutral contract
  - 不直接承担 AI runtime composition 细节

- `terminal/organ`
  - 可依赖 `membrane`
  - 也可依赖 `ai-core-logic`、`ai-organ-logic`
  - 但应通过正式 facade，而不是摊开 composer/support/mod internals

- `terminal/tui` / `terminal/cli` / `terminal/organ-support`
  - 按具体需求消费更高层或更窄的 facade
  - 不要求机械统一经过单一入口

## 5. Membrane 的正式定位

`membrane` 的定位是：

1. 封装 `ai-composer`
2. 提供更高层、更产品化的 composition facade
3. 为未来更多领域 composer 的聚合预留正式入口
4. 成为高层 consumer 的优先选择之一，但不是唯一允许的消费入口

因此，本轮需要把 `membrane` 设计为“更高层封装面”，而不是“禁止其他 facade 被直接消费的防火墙”。

## 6. 本轮的关键约束

1. `ai-composer` 的职责对齐参考项目 `sparrow_composer`，而不是继续把 composer 逻辑放进 `ai-core-logic`。
2. `ai-core-logic` 与 `ai-organ-logic` 必须分工明确：
   - core 负责 AI core runtime glue
   - organ 负责组织层逻辑与运行时依赖组合
   - 依赖方向必须是 `ai-organ-logic -> ai-core-logic`，不能反向聚合
3. `RuntimeDeps` 等组织层依赖组合 contract 应进入 `ai-organ-contract`。
4. `mod-ai-kernel` 不应继续直接正式拥有 `LocalFile*` 宿主实现。
5. `ai-support` 必须成为正式 support 宿主，后续承担 local/server 切换能力。
6. terminal 不再成为 runtime product definition host，也不应继续掌握过多 runtime factory 细节。
7. `core-contract` / `core-logic` 中残留的 AI-specific data / logic 必须继续迁入 `ai-core-*`，直到 core 包下不再保留 AI 领域真相源。

## 7. 建议迁移策略

### Phase 1
- 创建新包与新 package name
- 先完成 package topology 和导入兼容

### Phase 2
- 将 AI core contract / logic 切到 `ai-core-*`
- 将 AI-specific organ contract / logic 切到 `ai-organ-*`
- 将 support 实现收口到 `ai-support`

### Phase 3
- 将 `composer` 改名并收口为 `ai-composer`
- 让 `membrane` 封装 `ai-composer`
- 调整 terminal 侧消费路径

### Phase 4
- focused tests 切到新 topology
- 删除 legacy `organ-contract` / `organ-logic` 包，并清理旧包兼容壳与第二真相源

## 8. 本文档的用途

- 作为本 track 的架构总结记录
- 在 `proposal.md` 中作为正式引用项
- 在 `design.md` 中作为设计依据
- 为实现阶段提供 package ownership 和 facade 边界的统一判断标准
