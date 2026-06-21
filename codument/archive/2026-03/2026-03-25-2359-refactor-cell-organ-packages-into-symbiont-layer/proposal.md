# 变更：将 cell 中的低层 organ 包重构为 symbiont / organ 分层

## 背景

当前 `cell` 分层里，`organ-contract-low` 同时承载“可脱离项目核心复用的低层契约”，`organ-contract-high` 则承载依赖 `core-contract` 的组织领域契约；但命名仍将两者都归在 `organ` 语义下，不利于清晰区分“可独立迁移/复用的共生层”和“依赖核心定义的业务器官层”。

用户希望将这类脱离项目核心、仍可复制到其他项目使用的低层库/引擎部分统一命名为 `symbiont`，并新增对应的 logic 层。

## 变更内容

- **BREAKING** 将 `cell/packages/organ-contract-low` 重构为 `cell/packages/symbiont-contract`
- **BREAKING** 将 `cell/packages/organ-contract-high` 重构为 `cell/packages/organ-contract`
- 新增 `cell/packages/symbiont-logic`
- 将当前位于 `core-logic` / `organ-logic` 中、可脱离核心业务定义复用的低层 stream / ingress 基础设施下沉到 `symbiont-logic`
- 更新 `cell`、`backend`、`terminal` 及测试中的 package 依赖、TS path 与 import surface

## 不做

- 不在本次重构中重新定义 `core-contract` / `core-logic` 的业务语义
- 不在本次重构中引入兼容 alias 或长期双轨导出
- 不把明显依赖核心语义事件或组织业务语义的实现误迁到 `symbiont-logic`

## 影响范围

- 受影响的规范：
  - `aiagent-reference-aligned-stage-streaming`
- 受影响的代码：
  - `cell/packages/core-contract`
  - `cell/packages/core-logic`
  - `cell/packages/organ-logic`
  - `cell/packages/support`
  - `backend/packages/organ`
  - `terminal/packages/organ`
  - `terminal/packages/tui`
  - `backend/tsconfig.json`
  - `terminal/tsconfig.json`
  - `cell/tsconfig.json`
