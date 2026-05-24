# 变更：重构 AI package topology、composer ownership 与 membrane 封装层

## 背景和动机 (Context And Why)
当前仓库已经完成了第一轮“默认 runtime product definition 从 terminal 迁到 composer/mod profile”的 cutover，但 package topology 与 ownership 仍处在中间状态：`@cell/composer` 的职责尚未按目标命名和边界收口，`domain-ai-*` 命名未完成向 `ai-*` 的正式演进，`organ-*` 中的 AI-specific 组织层契约与逻辑还未拆分为独立 ownership，`@cell/membrane` 也还没有成为更高层 composer facade 的正式宿主。

本轮目标不是重复第一轮 composer 引入，而是完成第二轮 package topology 重构：将 AI core / AI organ / AI support / AI composer / membrane 的职责边界明确下来，使 AI runtime 相关能力具备更清晰、可扩展、可持续演进的 package ownership。

本次讨论确认的架构思路总结，见 [architecture-summary.md](./architecture-summary.md)。
本轮落地后的包职责、兼容壳策略与 terminal facade 消费边界，见 [migration-guide.md](./migration-guide.md)。

## “要做”和“不做” (Goals / Non-Goals)
**目标:**
- 将 `@cell/composer` 改名为 `@cell/ai-composer`，并明确其对应参考项目 `sparrow_composer` 的职责。
- 将 `@cell/domain-ai-contract`、`@cell/domain-ai-logic`、`@cell/domain-ai-support` 分别演进为 `@cell/ai-core-contract`、`@cell/ai-core-logic`、`@cell/ai-support`。
- 新增 `@cell/ai-organ-contract` 与 `@cell/ai-organ-logic`，承接 AI-specific organ data / organ logic 的正式 ownership。
- 将 `cell/packages/core-logic` 中残留的 AI 领域专属逻辑实现迁入 `@cell/ai-core-logic`，并完成数据/逻辑分离。
- 将 `cell/packages/core-contract` 与 `cell/packages/core-logic` 中残留的 AI 领域专属数据迁入 `@cell/ai-core-contract`。
- 清理 `core-contract` / `core-logic` 中旧的 AI 领域兼容层，使 core 包不再保留 AI-specific 真相源。
- 将 `@cell/organ-contract` 与 `@cell/organ-logic` 中仍残留的 AI runtime 相关源码迁入 `@cell/ai-organ-contract` 与 `@cell/ai-organ-logic`，并删除 legacy `organ-*` 包。
- 让 `@cell/membrane` 封装 `@cell/ai-composer`，成为更高层 composer facade 聚合面，并为未来更多领域 composer 预留扩展位。
- 调整 `terminal/*` 对 `cell/*` facade 的消费边界，使其按职责消费合适层级的 facade，而不是继续无边界依赖内部实现。
- 明确迁移期兼容策略，并通过 focused tests 锁定新的 package topology、facade ownership 与 terminal adoption。

**非目标:**
- 本 track 不要求在同一轮完成所有非 AI-generic `organ-*` 内容的最终归宿裁决。
- 本 track 不要求第一轮就完成完整的 server support 或远程 runtime backend。
- 本 track 不要求一次性删除所有旧 package name；但 `organ-contract` / `organ-logic` 在完成源码迁移后必须被删除。
- 本 track 不扩大到 `Read` / `Write` / `Edit` / `Bash` 等工具实现的单独 backend 大迁移。
- 本 track 不把 terminal 强制改成只消费 membrane 的单一入口模式。

## 变更内容（What Changes）
- 将 `@cell/composer` 演进并改名为 `@cell/ai-composer`
- 将 `@cell/domain-ai-contract` 演进并改名为 `@cell/ai-core-contract`
- 将 `@cell/domain-ai-logic` 演进并改名为 `@cell/ai-core-logic`
- 将 `@cell/domain-ai-support` 演进并改名为 `@cell/ai-support`
- 新增 `@cell/ai-organ-contract`
- 新增 `@cell/ai-organ-logic`
- 将 `cell/packages/core-logic` 中 AI 领域专属逻辑拆分并迁入 `@cell/ai-core-logic`
- 将 `cell/packages/core-contract` 与 `cell/packages/core-logic` 中 AI 领域专属数据迁入 `@cell/ai-core-contract`
- 删除 `@cell/core-contract` / `@cell/core-logic` 中旧的 AI-specific compatibility surface
- 将 `@cell/organ-contract` 的正式源码宿主迁入 `@cell/ai-organ-contract`
- 将 `@cell/organ-logic` 的正式源码宿主迁入 `@cell/ai-organ-logic`
- 删除 legacy `@cell/organ-contract` 与 `@cell/organ-logic` 包及其 workspace 注册
- 让 `@cell/membrane` 正式封装 `@cell/ai-composer`
- 梳理 `terminal/*` 对不同层级 facade 的消费边界
- **BREAKING**：AI runtime 相关 package name、正式 ownership 和 facade 入口将发生调整

## 影响范围（Impact）
- 受影响的功能规范：
  - AI runtime composition / composer ownership
  - contract / logic / support layering
  - AI organ contract / logic ownership
  - membrane facade ownership
  - terminal runtime adoption boundary
- 受影响的代码：
  - `cell/packages/composer`
  - `cell/packages/domain-ai-contract`
  - `cell/packages/domain-ai-logic`
  - `cell/packages/domain-ai-support`
  - `cell/packages/core-contract`
  - `cell/packages/core-logic`
  - `cell/packages/organ-contract`
  - `cell/packages/organ-logic`
  - `cell/packages/membrane`
  - `cell/packages/mod-ai-kernel`
  - `cell/packages/mod-profiles`
  - `terminal/packages/*`
- 受影响的测试：
  - runtime composition ownership tests
  - membrane facade tests
  - terminal adoption tests
  - package surface / package migration focused tests
