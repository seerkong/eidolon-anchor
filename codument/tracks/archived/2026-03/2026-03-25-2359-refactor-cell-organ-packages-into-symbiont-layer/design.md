## 上下文

当前 `cell` 分层里，`organ-contract-low` 实际只承载低层 stream / actor-framework 契约，并不表达组织业务本身；同时，`core-logic` 与 `organ-logic` 中已经出现了一批更接近“低层可复用基础设施”的实现，例如 transcript、ingress stream 容器和 openai completions stream adapter。继续把这些内容放在 `organ-*` 或 `core-*` 名义下，会模糊“共生层”与“业务器官层”的边界。

## 方案概览

1. 重命名 contract 层
  - `organ-contract-low` -> `symbiont-contract`
  - `organ-contract-high` -> `organ-contract`
2. 新建 `symbiont-logic`
  - 承接不依赖 `core-contract` 的低层 logic
  - 第一批承接 stream / ingress 基础设施
3. 收口依赖方向
  - `core-contract` 依赖 `symbiont-contract`
  - `core-logic` 依赖 `core-contract`、`symbiont-contract`、`symbiont-logic`
  - `organ-contract` 依赖 `core-contract` 与 `symbiont-contract`
  - `organ-logic` 依赖 `core-logic`、`organ-contract`、`symbiont-contract`、`symbiont-logic`
4. 同步更新 workspace path、package dependencies、tests 和 layout assertions

## 第一批下沉到 symbiont-logic 的实现

- `IngressStreams`
- `StreamTranscript`
- `StreamLogger`
- `IngressStreamRuntime`
- `OpenAICompletionsNodejsFetchStreamAdapter`

这些模块的共同特征是：
- 不依赖 `core-contract`
- 不表达 member / collective / questionnaire / protocol 等业务器官语义
- 可以作为其他项目里的通用流式基础设施复用

## 决策

- 决策：不保留 `@cell/organ-contract-low` / `@cell/organ-contract-high` 兼容导出
  - 理由：本次目标就是重建命名和边界语义；继续保留旧名会让外部继续沿用错误层次

- 决策：`symbiont-logic` 第一轮只承接低层 stream / ingress 基础设施
  - 理由：这一批实现边界最清晰，迁移收益高，且不会误伤依赖核心定义的业务逻辑

- 决策：`organ-logic` 不再 re-export 低层 symbiont 能力作为正式来源
  - 理由：否则虽然目录改名了，但真实消费面仍旧模糊

## 风险 / 权衡

- 风险：import surface 改名会波及大量测试与 tsconfig path
  - 缓解：通过全局 import 扫描和 package layout 测试锁定改名收口

- 风险：某些看似低层的实现实际上偷偷依赖核心语义
  - 缓解：第一轮只迁明显无 `core-contract` 依赖的实现；其他实现保留在原业务层

## 兼容性设计

- 本次按 breaking-change 路线执行
- 不提供旧 package 名到新 package 名的 alias
- 调用方与测试一次性切到新 package surface

## 迁移计划

1. 冻结新包命名、职责和依赖方向
2. 重命名 package 目录与 package 名称
3. 下沉第一批低层 logic 到 `symbiont-logic`
4. 更新所有依赖、路径映射、测试和导出面
5. 通过 typecheck 与相关测试

## 待解决问题

- `symbiont-logic` 第一轮是否还要承接更多 provider stream adapter，目前先只收 `OpenAICompletionsNodejsFetchStreamAdapter`
