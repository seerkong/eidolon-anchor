# 设计草案：AI package topology、composer ownership 与 membrane facade 重构

本文档基于 [architecture-summary.md](./architecture-summary.md) 中已经确认的架构思路展开，并将其落为可执行的设计。最终落地后的包职责与消费边界说明见 [migration-guide.md](./migration-guide.md)。

## 目标

- 将 AI runtime 相关 package topology 重构为 `ai-core-*` / `ai-organ-*` / `ai-support` / `ai-composer` / `membrane` 的明确分层。
- 让 `ai-composer` 对齐参考项目 `sparrow_composer` 的职责，而不是继续把 composer ownership 下沉到 `ai-core-logic`。
- 让 `membrane` 成为 `ai-composer` 之上的更高层 facade 聚合面。
- 让 terminal 按职责消费合适层级的 facade，而不是被错误限制为单一路径，也不继续无边界直接引用内部实现。

## 当前问题

### 1. Composer ownership 仍未按目标 topology 收口
- `cell/packages/composer` 已承担 runtime assembly reducer 和 contract，但包名仍停留在中间状态。
- `terminal` 以及其他 consumer 仍直接绑定当前 composer / domain-ai host，缺少“领域 composer”和“更高层 facade”的明确分层。

### 2. domain-ai 命名与职责仍停留在中间态
- `domain-ai-contract` / `domain-ai-logic` / `domain-ai-support` 已是 AI host-facing 入口，但命名无法准确表达 `core` / `support` 的长期 ownership。

### 3. AI-specific organ ownership 尚未分离
- 当前 `organ-contract` / `organ-logic` 同时承载 AI-specific orchestration / organization / coordination / permission / recovery 等能力。
- 参考架构要求引入与 `sparrow_organ_data` / `sparrow_organ_logic` 对齐的专属 organ ownership。
- 即使已经引入 `ai-organ-*`，当前旧 `organ-*` 仍保留一部分真实源码，导致“新包负责 ownership、旧包仍是实现宿主”的双真相状态没有真正结束。

### 4. membrane 还不是正式的高层 facade 宿主
- 当前 `membrane` 包存在但职责偏空。
- 未来若引入更多领域 composer，需要一个位于 composer 之上的统一封装面。

## 目标结构

### Package ownership

- `@cell/ai-core-contract`
  - AI core runtime contract
  - runtime assembly contract
  - runtime support contract
  - shell/host bundle contract

- `@cell/ai-core-logic`
  - runtime ingress/egress glue
  - AI runtime graph / semantic / stage pipeline / snapshot / config loader logic
  - core-facing facade ports
  - 不反向依赖 `ai-organ-logic`

- `@cell/ai-support`
  - local/server support 实现
  - support bundle 工厂
  - runtime support backend ownership

- `@cell/ai-organ-contract`
  - `RuntimeDeps`
  - AI-specific permission / persistence / organization contract
  - AI 组织层数据定义

- `@cell/ai-organ-logic`
  - orchestrator driver
  - runtime coordinator
  - organization / member / holon logic
  - coordination engine
  - task tree
  - permission runtime
  - runtime recovery / persistence orchestration

- `@cell/ai-composer`
  - runtime profile / extension reducer
  - runtime assembly result
  - runtime deps composition helper
  - AI 领域正式 composer 宿主

- `@cell/membrane`
  - 更高层 runtime composition facade
  - 封装 `ai-composer`
  - 未来可继续聚合更多领域 composer

## 关键设计决策

### 决策 1：`ai-composer` 负责 composer ownership，`ai-core-logic` 只负责 core glue

理由：
- 这和参考项目 `sparrow_composer` 的职责对应。
- 如果把 composition contract 继续下沉到 `ai-core-logic`，会重新制造 logic 包承载组合面的问题。

### 决策 2：新增 `ai-organ-*`，而不是继续在历史 `organ-*` 上增量堆叠

理由：
- 用户明确要求与 `sparrow_organ_data` / `sparrow_organ_logic` 的职责对齐。
- 仅在旧 `organ-*` 中继续增量堆叠，会让 AI-specific ownership 长期模糊不清。

补充约束：
- `ai-organ-contract` / `ai-organ-logic` 不仅要承接“新入口命名”，还必须承接旧 `organ-contract` / `organ-logic` 中 AI runtime 相关源码的正式宿主地位。
- 旧 `organ-*` 包在迁移完成后必须被删除，不再保留 compatibility shell。
- `ai-organ-logic` 应依赖 `ai-core-logic`，而不是由 `ai-core-logic` 反向聚合 organ runtime surface。

### 决策 2.5：core-* 中残留的 AI-specific contract / logic 必须继续下沉到 ai-core-*

理由：
- 当前 `ai-core-*` 仍偏 facade host，而 `core-contract` / `core-logic` 仍残留大量 AI runtime 专属数据与逻辑。
- 若保留这些 compatibility layers，AI core 仍有第二真相源，不符合本轮 package topology 收口目标。
- 用户要求对数据与逻辑做显式拆分：AI-specific data 进入 `ai-core-contract`，AI-specific logic 进入 `ai-core-logic`。

### 决策 3：`membrane` 不是唯一入口，而是更高层 facade 宿主

理由：
- 高层 consumer 需要一个更产品化、可扩展到多领域 composer 的封装面。
- 但 terminal 的不同子包职责不同，不应强制都通过 membrane 走单一入口。

### 决策 4：`organ-*` 完成迁移后直接删除，而不是保留兼容壳

理由：
- package rename 涉及 workspace、导入路径、测试和上层 consumer，不能在源码尚未切干净前提前删除旧包。
- 但对 `organ-contract` / `organ-logic` 而言，一旦活动 consumer、测试与资源路径都已切到 `ai-organ-*`，继续保留旧包只会制造第二入口与维护噪音。

## 建议迁移路径

### Phase 1：创建新 package topology 与兼容壳

1. 新建：
   - `cell/packages/ai-core-contract`
   - `cell/packages/ai-core-logic`
   - `cell/packages/ai-support`
   - `cell/packages/ai-organ-contract`
   - `cell/packages/ai-organ-logic`
   - `cell/packages/ai-composer`
2. 为仍需过渡的旧包创建兼容层：
   - `domain-ai-contract`
   - `domain-ai-logic`
   - `domain-ai-support`
   - `composer`
   - `organ-*` 不再保留过渡入口

### Phase 2：core / organ / support ownership cutover

1. 将 `domain-ai-contract` 的 runtime contract 切入 `ai-core-contract`
2. 将 `domain-ai-logic` 的 runtime glue 切入 `ai-core-logic`
3. 将 `core-logic` 中 AI-specific logic 从对象方法/混合结构中拆出，迁入 `ai-core-logic`
4. 将 `core-contract` 与 `core-logic` 中 AI-specific data 迁入 `ai-core-contract`
5. 清理 `core-contract` / `core-logic` 中旧的 AI-specific compatibility layer
6. 将 AI-specific 的 organ contract / logic 切入 `ai-organ-*`
7. 将旧 `organ-contract` 中仍保留的 AI runtime contract 源码迁入 `ai-organ-contract`
8. 将旧 `organ-logic` 中仍保留的 AI runtime 逻辑源码迁入 `ai-organ-logic`
9. 将测试、资源、tsconfig alias 与活动 consumer 全部切到 `ai-organ-*`
10. 删除 `organ-contract` / `organ-logic` package 目录与 workspace 注册
11. 将 support backend 正式 ownership 收口到 `ai-support`
12. 调整 `mod-ai-kernel`，使其不再正式拥有 `LocalFile*` support backend

### Phase 3：composer 与 membrane cutover

1. 将 `composer` 正式改名为 `ai-composer`
2. 让 `mod-profiles`、`mod-ai-*`、terminal 侧相关 consumer 切到新 composer contract
3. 在 `membrane` 中引入对 `ai-composer` 的更高层封装
4. 增加 membrane facade contract 与 focused tests

### Phase 4：terminal adoption 与兼容层清理

1. 按 terminal 子包职责切换合适 facade
2. focused tests 锁定 terminal 对 facade 的层级消费边界
3. 逐步降级或删除旧 forwarding shell

## Terminal 消费边界

### `terminal/core`
- 优先消费较窄 contract
- 不直接承担 AI runtime composition ownership

### `terminal/organ`
- 可以消费 `membrane`
- 也可以消费 `ai-core-logic` / `ai-organ-logic`
- 但必须通过正式 facade，而不是摊开内部实现细节

### `terminal/tui` / `terminal/cli` / `terminal/organ-support`
- 按实际需要选择更高层或更窄的 facade
- 不要求机械统一到单一入口

## 兼容性设计

- `organ-contract` / `organ-logic` 在迁移完成后直接删除
- 其他旧 package name 在迁移期可保留 forwarding shell
- focused tests 需明确验证正式 ownership 在新包而非旧壳
- 对 `organ-contract` / `organ-logic` 的迁移要求更严格：不只去掉真实源码，也要去掉旧包目录、alias 与活动测试路径

## 风险与缓解

- 风险：rename 先做了，但 ownership 没真正切走
  - 缓解：focused tests 验证新包为正式宿主，并删除 legacy `organ-*` 包以防残留第二入口

- 风险：`membrane` 只是多套 re-export，没有形成高层 facade
  - 缓解：要求 membrane 暴露明确的高层 facade contract，并用 tests 锁定

- 风险：terminal 侧被错误收紧为单一路径
  - 缓解：在 spec 中明确“terminal 可按职责消费不同层级 facade”

- 风险：AI-specific organ 内容与泛化 organ 内容边界不清
  - 缓解：实现前先形成迁移清单，并按 AI-specific 优先切分

## 需要重点验证的行为

- 新 package name 与 workspace 路径解析正常
- legacy `organ-*` package 目录、alias 与活动依赖已被删除
- `mod-ai-kernel` 不再正式拥有本地 support backend
- membrane 正式封装 ai-composer
- terminal adoption 仍正常工作
- focused ownership guard 不回归
