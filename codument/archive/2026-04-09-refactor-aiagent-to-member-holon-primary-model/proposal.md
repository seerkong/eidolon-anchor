# 变更：AIAgent 正式切换到 `member / holon` 与 `primary / delegate / detached` 模型

## 背景和动机 (Context And Why)

当前 AIAgent 的正式对象模型仍使用 `member / collective / formation` 与 `control / delegate / detached` 两组命名。虽然运行时已经完成 actor 化，但 `collective / formation` 这组名字没有直接表达统一的组织类别与治理差异，`control` 也容易与 orchestrator、controller、session 等已有概念混淆。

本变更要以 breaking change 方式，把正式对象模型统一收口为：

- 组织轴：`member / holon`
- 治理轴：`holon.governance = autonomous | leader_led`
- 执行轴：`primary / delegate / detached`

同时，把命令面中的组织型一级命令统一为 `/holon`，并将 prompt/content 分隔符从 `::` 切换为更接近命令行习惯的 `--`。

## “要做”和“不做” (Goals / Non-Goals)

**目标:**
- 将正式组织模型从 `collective / formation` 收口为 `holon + governance`
- 将执行语义中的 `control` 收口为 `primary`
- 保持 `delegate / detached` 执行语义不变
- 保持 `member` 作为原子协作者对象不变
- 将正式组织命令面统一为 `/holon`
- 将正式组织工具族统一为 `Holon*`
- 将命令中的 prompt/content 分隔符从 `::` 切换为 `--`
- 同步更新 runtime、tools、slash parser、help、tips、tests、docs、vendor 文档与 snapshot schema
- 明确这是 breaking rename，不保留长期双模型共存

**非目标:**
- 不在本次变更中重构治理结构本身
- 不在本次变更中引入 holon 嵌套 holon
- 不在本次变更中重做 task board / route / ownership 机制
- 不为了兼容旧命名长期保留双字段、双 kind、双 tool 家族
- 不承诺旧 snapshot / 旧 session 的兼容恢复

## 变更内容（What Changes）

- **BREAKING** 正式组织对象模型从：
  - `member / collective / formation`
  切换为：
  - `member / holon`
  - `holon.governance = autonomous | leader_led`
- **BREAKING** 正式执行语义从：
  - `control / delegate / detached`
  切换为：
  - `primary / delegate / detached`
- **BREAKING** `holon(governance=autonomous)` 对应原 `collective`
- **BREAKING** `holon(governance=leader_led)` 对应原 `formation`
- **BREAKING** 正式一级命令面从：
  - `/actor`
  - `/member`
  - `/collective`
  - `/formation`
  切换为：
  - `/actor`
  - `/member`
  - `/holon`
- **BREAKING** 正式组织工具族从 `Collective* / Formation*` 切换为 `Holon*`
- **BREAKING** prompt/content 分隔符从 `::` 切换为 `--`
- **BREAKING** actor identity、actor key、sessionState、runtimeContext、snapshot/persistence 与 docs/tests 中的正式旧命名同步改写
- 可选保留 `/collective` 与 `/formation` 作为短期 deprecated alias，但它们不再是正式 surface，也不出现在 help/tips/docs 中

## 影响范围（Impact）

- 受影响的功能规范：
  - AIAgent actor runtime
  - AIAgent organization model
  - slash command / prompt parsing
  - persistence / snapshot / recovery
  - docs / vendor actor guide

- 受影响的代码与资产：
  - `cell/packages/core-contract/*`
  - `cell/packages/core-logic/src/runtime/*`
  - `cell/packages/organ-logic/src/organization/*`
  - `cell/packages/organ-logic/src/composer/AIAgent/tools/*`
  - `cell/packages/mod-sys-kernel/src/index.ts`
  - `terminal/packages/core/tests/slash-commands.test.ts`
  - `terminal/packages/tui/*`
  - `codument/specs/*`
  - `vendor/depa-actor/ACTOR-FOR-AI-AGENTS.md`
