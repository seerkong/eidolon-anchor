# 变更：实施平台微内核 Wave 6 的 VM platform/AI facet split

## 背景和动机

Wave 5 已将 `@cell/composer` 的根装配器提升为 platform-first composition engine，但 runtime 核心状态仍然集中在单一 `AiAgentVm` 上。

这使得：

- 平台执行状态与 AI 领域状态继续混在同一个 VM 类型中
- `TerminalRuntime`、`organ-logic`、`ToolFuncRegistry` 等调用方仍天然依赖 AI-shaped VM
- feasibility analysis 中“platform runtime facet / AI runtime facet”这一目标仍未真正开始

## 要做

- 将当前 `AiAgentVm` 拆为 platform facet 与 AI facet
- 明确哪些 runtime state/callback/effect 属于平台层，哪些属于 AI 领域层
- 提供兼容迁移入口，避免一次性打断既有执行路径
- 用 focused tests 锁定 facet split 后的行为等价性

## 不做

- 本次不引入完整的 `platform-logic` 新包
- 本次不处理 shell bridge 去 AI 语义化
- 本次不处理 AI slash contract 下沉

## 影响范围

- `cell/packages/core-logic/src/runtime/runtime.ts`
- `cell/packages/core-logic/src/runtime/*`
- `cell/packages/organ-logic/src/**/*`
- `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts`
- 相关 focused tests
